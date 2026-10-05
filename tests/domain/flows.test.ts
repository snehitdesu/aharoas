/**
 * Domain flow integration tests — the real services against the test DB.
 * Covers the mandated chains: purchase->inventory, nested recipe explosion,
 * order->payment->explosion->consumption, duplicate webhook (no double
 * consumption), cycle rejection, outlet authorization, refund state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";
import { recordPurchaseReceipt, recordWastage, currentQuantity, getAvgCost } from "@/server/services/inventory";
import { explodeRecipe, assertNoCycleOnAdd } from "@/server/services/recipe";
import { createOrder, addOrderItem, submitOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { receivePOSWebhook } from "@/server/services/pos";
import { bindWebhook } from "./webhookBinding";
import { MockPOSProvider } from "@/integrations/pos";
import { RecipeCycleError } from "@/domain/recipe/cycle";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let ctx: AccessContext;
let orgId: string, outletA: string, outletB: string;
let unitKg: string;
let mChicken: string, mRice: string, mGinger: string, mGarlic: string;
let mainVersionId: string, subRecipeId: string, mainRecipeId: string;
let biryaniItemId: string;

async function makeRecipe(name: string, opts: { menuItemId?: string; yieldQty: number; lines: Array<{ materialId?: string; subRecipeId?: string; qty: number }> }) {
  const recipe = await prisma.recipe.create({ data: { organizationId: orgId, name, outputType: opts.menuItemId ? "MENU_ITEM" : "SUB_RECIPE", menuItemId: opts.menuItemId } });
  const version = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: recipe.id, version: 1, status: "APPROVED", yieldQty: opts.yieldQty } });
  for (const l of opts.lines) {
    await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: version.id, componentType: l.subRecipeId ? "SUB_RECIPE" : "MATERIAL", materialId: l.materialId, subRecipeId: l.subRecipeId, qty: l.qty } });
  }
  return { recipeId: recipe.id, versionId: version.id };
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `Flow Org ${RUN}` } });
  orgId = org.id;
  const a = await prisma.outlet.create({ data: { organizationId: orgId, code: `A${RUN}`, name: "A" } });
  const b = await prisma.outlet.create({ data: { organizationId: orgId, code: `B${RUN}`, name: "B" } });
  outletA = a.id; outletB = b.id;
  ctx = systemContext(orgId, [outletA, outletB]);

  const kg = await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } });
  unitKg = kg.id;
  const mk = (sku: string, name: string) => prisma.material.create({ data: { organizationId: orgId, sku: `${sku}-${RUN}`, name, baseUnitId: unitKg } });
  mChicken = (await mk("CHK", "Chicken")).id;
  mRice = (await mk("RICE", "Rice")).id;
  mGinger = (await mk("GIN", "Ginger")).id;
  mGarlic = (await mk("GAR", "Garlic")).id;

  const item = await prisma.menuItem.create({ data: { organizationId: orgId, name: `Biryani ${RUN}`, price: 300, taxPct: 5, station: "KITCHEN", posCode: `BIR-${RUN}` } });
  biryaniItemId = item.id;

  // sub-recipe: 1kg GGP = 0.5 ginger + 0.5 garlic
  const sub = await makeRecipe(`GGP ${RUN}`, { yieldQty: 1, lines: [{ materialId: mGinger, qty: 0.5 }, { materialId: mGarlic, qty: 0.5 }] });
  subRecipeId = sub.recipeId;
  // main: 1 plate = 0.2 rice + 0.25 chicken + 0.05 GGP(sub)
  const main = await makeRecipe(`Biryani Recipe ${RUN}`, { menuItemId: biryaniItemId, yieldQty: 1, lines: [{ materialId: mRice, qty: 0.2 }, { materialId: mChicken, qty: 0.25 }, { subRecipeId: sub.recipeId, qty: 0.05 }] });
  mainVersionId = main.versionId; mainRecipeId = main.recipeId;

  // stock the store at outlet A
  for (const [mid, q, rate] of [[mChicken, 50, 220], [mRice, 100, 90], [mGinger, 10, 120], [mGarlic, 10, 140]] as const) {
    await recordPurchaseReceipt(ctx, { outletId: outletA, materialId: mid, quantity: q, rate, sourceRef: `seed:${RUN}:${mid}` });
  }
});

afterAll(async () => { await prisma.$disconnect(); });


// H4 tenant binding for the provider account used below.
beforeAll(async () => {
  await bindWebhook({ kind: "POS", provider: "mock", organizationId: orgId, outletId: outletA, externalRef: outletA });
});

describe("purchase -> inventory", () => {
  it("increases on-hand and sets weighted-average cost", async () => {
    expect(num(await currentQuantity(prisma, ctx, outletA, mChicken))).toBe(50);
    expect(num(await getAvgCost(prisma, ctx, outletA, mChicken))).toBe(220);
  });
});

describe("nested recipe explosion", () => {
  it("expands sub-recipes to raw materials with correct scaling", async () => {
    const exploded = await explodeRecipe(prisma, ctx, mainVersionId, 2); // 2 plates
    expect(num(exploded.get(mRice)!)).toBeCloseTo(0.4, 6);
    expect(num(exploded.get(mChicken)!)).toBeCloseTo(0.5, 6);
    // GGP needed = 0.1kg => ginger/garlic 0.05 each
    expect(num(exploded.get(mGinger)!)).toBeCloseTo(0.05, 6);
    expect(num(exploded.get(mGarlic)!)).toBeCloseTo(0.05, 6);
  });
});

describe("order -> payment -> explosion -> consumption", () => {
  it("depletes inventory exactly once when the order is paid", async () => {
    const before = num(await currentQuantity(prisma, ctx, outletA, mChicken));
    const order = await createOrder(ctx, { outletId: outletA, channel: "DINE_IN", source: "POS" });
    await addOrderItem(ctx, order.id, { menuItemId: biryaniItemId, qty: 4 });
    await submitOrder(ctx, order.id);
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    const payment = await createPayment(ctx, order.id, { method: "CASH", amount: num(fresh!.total) });
    const res = await verifyPayment(ctx, payment.id);
    expect(res.orderSettled).toBe(true);

    const paid = await prisma.order.findUnique({ where: { id: order.id } });
    expect(paid!.status).toBe("PAID");
    expect(paid!.stockConsumed).toBe(true);
    // 4 plates * 0.25 chicken = 1.0 consumed
    expect(num(await currentQuantity(prisma, ctx, outletA, mChicken))).toBeCloseTo(before - 1.0, 6);
  });
});

describe("POS webhook idempotency", () => {
  it("does not consume stock twice for a duplicate webhook", async () => {
    const provider = new MockPOSProvider();
    const payload = {
      eventId: `EVT-${RUN}`, externalRef: `EXT-${RUN}`, storeId: outletA, outletId: outletA, source: "PETPOOJA", channel: "AGGREGATOR",
      items: [{ posItemCode: `BIR-${RUN}`, name: "Biryani", qty: 2, unitPrice: 300, taxPct: 5 }],
      settled: true,
    };
    const raw = JSON.stringify(payload);
    const sig = MockPOSProvider.sign(raw);

    const before = num(await currentQuantity(prisma, ctx, outletA, mChicken));
    const w1 = await receivePOSWebhook({ providerName: "mock", rawBody: raw, signature: sig }, { provider, db: prisma });
    const w2 = await receivePOSWebhook({ providerName: "mock", rawBody: raw, signature: sig }, { provider, db: prisma });
    expect(w1.ok).toBe(true);
    expect(w1.duplicate).toBe(false);
    expect(w2.duplicate).toBe(true);

    // exactly one order created
    const orders = await prisma.order.count({ where: { outletId: outletA, source: "PETPOOJA", externalRef: `EXT-${RUN}` } });
    expect(orders).toBe(1);
    // 2 plates * 0.25 = 0.5 consumed once, not twice
    expect(num(await currentQuantity(prisma, ctx, outletA, mChicken))).toBeCloseTo(before - 0.5, 6);
  });

  it("rejects an invalid signature", async () => {
    const provider = new MockPOSProvider();
    const raw = JSON.stringify({ eventId: `BAD-${RUN}`, externalRef: `BADEXT-${RUN}`, outletId: outletA, items: [] });
    const res = await receivePOSWebhook({ providerName: "mock", rawBody: raw, signature: "deadbeef" }, { provider, db: prisma });
    expect(res.ok).toBe(false);
    expect(res.signatureValid).toBe(false);
  });
});

describe("recipe cycle rejection at write time", () => {
  it("rejects making the main recipe a sub of its own sub-recipe", async () => {
    // main already depends on sub; adding sub -> main closes a cycle.
    await expect(assertNoCycleOnAdd(prisma, ctx, subRecipeId, mainRecipeId)).rejects.toBeInstanceOf(RecipeCycleError);
  });
});

describe("outlet authorization", () => {
  it("blocks a store user of outlet B from writing to outlet A", async () => {
    const limited: AccessContext = {
      userId: "limited", organizationId: orgId, outletIds: [outletB], roles: ["STORE"],
      outletRoles: { [outletB]: ["STORE"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false,
    };
    let err: unknown;
    try {
      await recordWastage(limited, { outletId: outletA, materialId: mRice, quantity: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenError);
  });
});

describe("refund -> payment/order state", () => {
  it("moves a fully refunded paid order to REFUNDED", async () => {
    const order = await createOrder(ctx, { outletId: outletA, channel: "TAKEAWAY", source: "POS" });
    await addOrderItem(ctx, order.id, { menuItemId: biryaniItemId, qty: 1 });
    await submitOrder(ctx, order.id);
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    const p = await createPayment(ctx, order.id, { method: "CARD", amount: num(fresh!.total) });
    await verifyPayment(ctx, p.id);
    const { payment } = await refundPayment(ctx, p.id, { amount: num(fresh!.total), reason: "test" });
    expect(payment.status).toBe("REFUNDED");
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe("REFUNDED");
  });
});
