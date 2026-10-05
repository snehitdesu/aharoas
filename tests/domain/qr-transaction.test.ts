/**
 * Phase 2 core transaction: guest QR ordering -> POS -> payment -> bill /
 * receipt -> KOT -> KDS -> inventory consumption -> sales data, plus the
 * failure paths (invalid QR, cross-tenant, tampering, duplicates, declines,
 * concurrency, cancellation, repricing a settled order).
 *
 * Real services, real database; guests go through the guest service exactly as
 * the /api/qr routes call it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup, setOutletMenuItem, setMenuItemAvailability } from "@/server/services/menu";
import { submitOrder, cancelOrder, applyDiscount, updateOrderItem, getOrder, placeOrder, addOrderItem, fireOrderItems } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { updateKOTStatus, listKOTs } from "@/server/services/kot";
import { getOrderBill, buildBill } from "@/server/services/bill";
import { recordPurchaseReceipt, currentQuantity } from "@/server/services/inventory";
import { rotateTableQr } from "@/server/services/masterData";
import { dailySales, salesSummary, itemSales, paymentsByMethod } from "@/server/services/analytics";
import { resolveTable, guestMenu, placeGuestOrder, getGuestOrder, startGuestPayment, confirmGuestPayment, guestOrderKey, MAX_WAITING_GUEST_ORDERS } from "@/server/services/guestOrdering";
import { fulfilmentStage } from "@/domain/orderProgress";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, otherOutletId: string, foreignOrgId: string;
let sys: AccessContext, cashier: AccessContext, kitchen: AccessContext, manager: AccessContext, otherOutletCashier: AccessContext, foreignOwner: AccessContext;
let token: string, token2: string, token3: string, foreignToken: string;
let biryani: string, naan: string, cola: string, paneer: string, foreignItem: string;
let large: string, spiceHot: string, spiceMild: string, extraCheese: string, mRice: string, mChicken: string;

const role = (userId: string, org: string, outlet: string, r: string): AccessContext => ({ userId, organizationId: org, outletIds: [outlet], roles: [r], outletRoles: { [outlet]: [r] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
let keySeq = 0;
const key = () => `k-${RUN}-${++keySeq}-abcdef`;

async function newTable(org: string, outlet: string, code: string) {
  const t = await prisma.restaurantTable.create({ data: { organizationId: org, outletId: outlet, code } });
  return (await rotateTableQr(systemContext(org, [outlet]), t.id)).qrToken!;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `QR Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QR${RUN}`, name: "QR Central", address: "1 Food St", phone: "+910000000000" } })).id;
  otherOutletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QX${RUN}`, name: "QR Other" } })).id;
  sys = systemContext(orgId, [outletId, otherOutletId]);
  cashier = role(`cash-${RUN}`, orgId, outletId, "CASHIER");
  kitchen = role(`kit-${RUN}`, orgId, outletId, "KITCHEN");
  manager = role(`mgr-${RUN}`, orgId, outletId, "MANAGER");
  otherOutletCashier = role(`cash2-${RUN}`, orgId, otherOutletId, "CASHIER");
  for (const s of ["KITCHEN", "BAKERY", "BAR"]) await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: s, kind: s } });

  biryani = (await createMenuItem(sys, { name: `Biryani ${RUN}`, price: 300, taxPct: 5, station: "KITCHEN" })).id;
  naan = (await createMenuItem(sys, { name: `Naan ${RUN}`, price: 60, taxPct: 5, station: "BAKERY" })).id;
  cola = (await createMenuItem(sys, { name: `Cola ${RUN}`, price: 99.99, taxPct: 18, station: "BAR" })).id;
  paneer = (await createMenuItem(sys, { name: `Paneer ${RUN}`, price: 250, taxPct: 5, station: "KITCHEN" })).id;
  large = (await addVariant(sys, { menuItemId: biryani, name: "Large", priceDelta: 80 })).id;
  const spice = await createModifierGroup(sys, { name: `Spice ${RUN}`, minSelect: 1, maxSelect: 1 });
  spiceHot = (await addModifierOption(sys, { groupId: spice.id, name: "Hot", priceDelta: 0 })).id;
  spiceMild = (await addModifierOption(sys, { groupId: spice.id, name: "Mild", priceDelta: 0 })).id;
  await attachModifierGroup(sys, biryani, spice.id);
  const extras = await createModifierGroup(sys, { name: `Extras ${RUN}`, minSelect: 0, maxSelect: 2 });
  extraCheese = (await addModifierOption(sys, { groupId: extras.id, name: "Cheese", priceDelta: 30 })).id;
  await attachModifierGroup(sys, naan, extras.id);
  // Outlet price override: the guest pays the outlet's price, not the org price.
  await setOutletMenuItem(sys, { outletId, menuItemId: paneer, price: 275 });

  // Recipe for the biryani so consumption is observable (1 plate = 0.2 rice + 0.25 chicken).
  const kg = await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } });
  mRice = (await prisma.material.create({ data: { organizationId: orgId, sku: `RICE-${RUN}`, name: "Rice", baseUnitId: kg.id } })).id;
  mChicken = (await prisma.material.create({ data: { organizationId: orgId, sku: `CHK-${RUN}`, name: "Chicken", baseUnitId: kg.id } })).id;
  const recipe = await prisma.recipe.create({ data: { organizationId: orgId, name: `Biryani R ${RUN}`, outputType: "MENU_ITEM", menuItemId: biryani } });
  const v = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: recipe.id, version: 1, status: "APPROVED", yieldQty: 1 } });
  await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: v.id, componentType: "MATERIAL", materialId: mRice, qty: 0.2 } });
  await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: v.id, componentType: "MATERIAL", materialId: mChicken, qty: 0.25 } });
  await recordPurchaseReceipt(sys, { outletId, materialId: mRice, quantity: 100, rate: 90, sourceRef: `qr:${RUN}:rice` });
  await recordPurchaseReceipt(sys, { outletId, materialId: mChicken, quantity: 50, rate: 220, sourceRef: `qr:${RUN}:chk` });

  token = await newTable(orgId, outletId, "T1");
  token2 = await newTable(orgId, outletId, "T2");
  token3 = await newTable(orgId, outletId, "T3");

  // A second tenant with its own table + menu.
  foreignOrgId = (await prisma.organization.create({ data: { name: `QR Foreign ${RUN}` } })).id;
  const fOutlet = (await prisma.outlet.create({ data: { organizationId: foreignOrgId, code: `QF${RUN}`, name: "Foreign" } })).id;
  foreignOwner = systemContext(foreignOrgId, [fOutlet]);
  foreignItem = (await createMenuItem(foreignOwner, { name: `Foreign Dish ${RUN}`, price: 1, taxPct: 0 })).id;
  foreignToken = await newTable(foreignOrgId, fOutlet, "F1");
});

afterAll(async () => { await prisma.$disconnect(); });

const twoBiryanis = () => ({ items: [{ menuItemId: biryani, variantId: large, modifierOptionIds: [spiceHot], qty: 2, notes: "no onions" }, { menuItemId: naan, modifierOptionIds: [extraCheese], qty: 3 }] });

// ------------------------------------------------------------------

describe("QR table resolution and guest menu", () => {
  it("resolves the table's own outlet and serves its menu at outlet prices, without admin fields", async () => {
    const m = await guestMenu(token);
    expect(m.table.code).toBe("T1");
    expect(m.restaurant.outletName).toBe("QR Central");
    const p = m.menu.find((i) => i.id === paneer)!;
    expect(p.price).toBe(275); // outlet override, not the org's 250
    const b = m.menu.find((i) => i.id === biryani)!;
    expect(b.variants.map((x) => x.name)).toEqual(["Large"]);
    expect(b.modifierGroups[0].group.options.map((o) => o.name).sort()).toEqual(["Hot", "Mild"]);
    expect(m.menu.some((i) => i.id === foreignItem)).toBe(false);
    for (const field of ["posCode", "createdById", "organizationId", "outletOverrides"]) expect(b).not.toHaveProperty(field);
    expect(m.payment).toEqual({ online: true, testMode: true });
  });

  it("refuses malformed, unknown and rotated tokens, and tables of inactive outlets — with one message", async () => {
    for (const bad of ["", "x", "../../etc", "a".repeat(200), "unknown-token-123"]) await expect(resolveTable(bad)).rejects.toBeInstanceOf(NotFoundError);
    const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `R${RUN}` } });
    const old = (await rotateTableQr(sys, t.id)).qrToken!;
    const fresh = (await rotateTableQr(sys, t.id)).qrToken!;
    await expect(resolveTable(old)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveTable(fresh)).resolves.toMatchObject({ table: { code: `R${RUN}` } });
    const closed = await prisma.outlet.create({ data: { organizationId: orgId, code: `QC${RUN}`, name: "Closed", active: false } });
    const ct = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: closed.id, code: "C1", qrToken: `closed-${RUN}` } });
    await expect(resolveTable(`closed-${RUN}`)).rejects.toThrow(/not valid/);
    void ct;
  });

  it("a sold-out item is listed as unavailable and cannot be ordered", async () => {
    await setOutletMenuItem(sys, { outletId, menuItemId: cola, soldOut: true });
    expect((await guestMenu(token)).menu.find((i) => i.id === cola)!.soldOut).toBe(true);
    await expect(placeGuestOrder(token3, { items: [{ menuItemId: cola, qty: 1 }] }, key())).rejects.toThrow(/sold out/);
    await setOutletMenuItem(sys, { outletId, menuItemId: cola, soldOut: false });
    await setMenuItemAvailability(sys, cola, { active: false });
    await expect(placeGuestOrder(token3, { items: [{ menuItemId: cola, qty: 1 }] }, key())).rejects.toThrow(/not on the menu/);
    await setMenuItemAvailability(sys, cola, { active: true });
  });
});

describe("placing a guest order", () => {
  it("prices every line on the server and replays a duplicate submission", async () => {
    const k = key();
    const placed = await placeGuestOrder(token, twoBiryanis(), k, { ip: "10.0.0.1" });
    expect(placed.replayed).toBe(false);
    const o = await getOrder(prisma, cashier, placed.orderId);
    expect(o).toMatchObject({ status: "OPEN", channel: "QR", source: "QR", createdById: null });
    // (300 + 80) × 2 = 760 ; (60 + 30) × 3 = 270 ; subtotal 1030 ; tax 5% = 51.5
    expect(num(o.subtotal)).toBe(1030);
    expect(num(o.tax)).toBe(51.5);
    expect(num(o.total)).toBe(1081.5);
    expect(o.items.find((i) => i.menuItemId === biryani)!.modifiers.map((m) => m.name)).toEqual([`Spice ${RUN}: Hot`]);
    expect(o.kots).toHaveLength(0); // waits for staff acceptance

    const again = await placeGuestOrder(token, twoBiryanis(), k);
    expect(again).toMatchObject({ orderId: placed.orderId, replayed: true, accessKey: placed.accessKey });
    expect(await prisma.order.count({ where: { organizationId: orgId, idempotencyKey: { endsWith: k } } })).toBe(1);
    await expect(placeGuestOrder(token, { items: [{ menuItemId: paneer, qty: 1 }] }, k)).rejects.toBeInstanceOf(ConflictError);
    // The same key from another table is a different order, never a replay of this one.
    const other = await placeGuestOrder(token2, twoBiryanis(), k);
    expect(other.orderId).not.toBe(placed.orderId);
    const audit = await prisma.auditLog.findFirst({ where: { entityId: placed.orderId, ip: "10.0.0.1" } });
    expect(JSON.parse(audit!.after!)).toMatchObject({ via: "guest-qr", table: "T1" });
  });

  it("refuses client prices/totals, bad quantities and a missing idempotency key", async () => {
    const tamper = [
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: 1, unitPrice: 1 }] },
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: 1 }], total: 1 },
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: 1, modifiers: [{ name: "Gold", priceDelta: -300 }] }] },
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: 0 }] },
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: 1.5 }] },
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: 51 }] },
      { items: [{ menuItemId: biryani, modifierOptionIds: [spiceHot], qty: -1 }] },
      { items: [] },
    ];
    for (const body of tamper) await expect(placeGuestOrder(token3, body, key())).rejects.toBeInstanceOf(ZodError);
    await expect(placeGuestOrder(token3, twoBiryanis(), undefined)).rejects.toBeInstanceOf(ZodError);
    await expect(placeGuestOrder(token3, twoBiryanis(), "short")).rejects.toBeInstanceOf(ZodError);
  });

  it("refuses invalid modifiers and variants", async () => {
    const bad = [
      { menuItemId: biryani, qty: 1 }, // required spice missing
      { menuItemId: biryani, modifierOptionIds: [spiceHot, spiceMild], qty: 1 }, // max 1
      { menuItemId: biryani, modifierOptionIds: [spiceHot, extraCheese], qty: 1 }, // option of another item's group
      { menuItemId: biryani, modifierOptionIds: [spiceHot, spiceHot], qty: 1 }, // duplicate
      { menuItemId: naan, variantId: large, qty: 1 }, // another item's variant
    ];
    for (const item of bad) await expect(placeGuestOrder(token3, { items: [item] }, key())).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.order.count({ where: { tableId: (await resolveTable(token3)).table.id } })).toBe(0);
  });

  it("cannot order another tenant's dish or reach another tenant's order", async () => {
    await expect(placeGuestOrder(token3, { items: [{ menuItemId: foreignItem, qty: 1 }] }, key())).rejects.toBeInstanceOf(NotFoundError);
    await expect(placeGuestOrder(foreignToken, { items: [{ menuItemId: naan, qty: 1 }] }, key())).rejects.toBeInstanceOf(NotFoundError);
    const mine = await placeGuestOrder(token3, { items: [{ menuItemId: paneer, qty: 1 }] }, key());
    // Staff of another tenant / outlet cannot read it either.
    await expect(getOrder(prisma, foreignOwner, mine.orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getOrderBill(prisma, otherOutletCashier, mine.orderId)).rejects.toBeInstanceOf(ForbiddenError);
    await cancelOrder(manager, mine.orderId, "test cleanup");
  });

  it("an order is readable only with its own access key", async () => {
    const a = await placeGuestOrder(token2, { items: [{ menuItemId: paneer, qty: 1 }] }, key());
    const b = await placeGuestOrder(token2, { items: [{ menuItemId: naan, qty: 1 }] }, key());
    expect((await getGuestOrder(a.orderId, a.accessKey)).bill.total).toBe("288.75"); // 275 × 1.05
    for (const k of [undefined, "", "x", b.accessKey, a.accessKey.slice(0, -1) + (a.accessKey.endsWith("A") ? "B" : "A")]) await expect(getGuestOrder(a.orderId, k)).rejects.toBeInstanceOf(NotFoundError);
    // Counter (POS) orders are never exposed to the guest API, even with a correct key.
    const pos = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", items: [{ menuItemId: paneer, qty: 1 }] });
    await expect(getGuestOrder(pos.id, guestOrderKey(pos.id))).rejects.toBeInstanceOf(NotFoundError);
    for (const id of [a.orderId, b.orderId, pos.id]) await cancelOrder(manager, id, "test cleanup");
  });

  it("limits unaccepted orders waiting at one table", async () => {
    const t = await newTable(orgId, outletId, `W${RUN}`);
    const ids: string[] = [];
    for (let i = 0; i < MAX_WAITING_GUEST_ORDERS; i++) ids.push((await placeGuestOrder(t, { items: [{ menuItemId: paneer, qty: 1 }] }, key())).orderId);
    await expect(placeGuestOrder(t, { items: [{ menuItemId: paneer, qty: 1 }] }, key())).rejects.toThrow(/waiting for the restaurant/);
    await submitOrder(cashier, ids[0]); // staff accept one -> room for another
    await expect(placeGuestOrder(t, { items: [{ menuItemId: paneer, qty: 1 }] }, key())).resolves.toMatchObject({ replayed: false });
  });
});

describe("full transaction: QR order -> POS accept -> KOT/KDS -> guest payment -> receipt -> stock -> sales", () => {
  it("runs end to end with consistent state at every step", async () => {
    const t = await newTable(orgId, outletId, `E${RUN}`);
    const riceBefore = num(await currentQuantity(prisma, sys, outletId, mRice));
    const salesBefore = await salesSummary(prisma, manager, { outletId });

    const placed = await placeGuestOrder(t, twoBiryanis(), key());
    let view = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(view).toMatchObject({ status: "OPEN", fulfilment: "AWAITING_ACCEPTANCE", canPay: true });

    // POS sees it as an incoming QR order and accepts it.
    const order = await getOrder(prisma, cashier, placed.orderId);
    expect(order.source).toBe("QR");
    await submitOrder(cashier, placed.orderId);
    await expect(submitOrder(cashier, placed.orderId)).rejects.toBeInstanceOf(ValidationError); // no double acceptance
    const kots = await listKOTs(prisma, kitchen, { outletId });
    const mine = kots.filter((k) => k.orderId === placed.orderId);
    expect(mine.map((k) => k.station?.name).sort()).toEqual(["BAKERY", "KITCHEN"]); // one KOT per station
    const kk = mine.find((k) => k.station?.name === "KITCHEN")!;
    expect(kk.items).toHaveLength(1);
    expect(kk.items[0]).toMatchObject({ name: `Biryani ${RUN} (Large)` });
    expect(num(kk.items[0].qty)).toBe(2);
    expect(kk.items[0].orderItem!.modifiers.map((m) => m.name)).toEqual([`Spice ${RUN}: Hot`]);
    expect(kk.items[0].orderItem!.notes).toBe("no onions");
    expect(kk.order!.table!.code).toBe(`E${RUN}`);

    // Kitchen works the tickets; a repeated tap is a no-op, an illegal jump is refused.
    for (const k of mine) {
      await updateKOTStatus(kitchen, k.id, "ACCEPTED");
      await updateKOTStatus(kitchen, k.id, "ACCEPTED");
      await expect(updateKOTStatus(kitchen, k.id, "SERVED")).rejects.toBeInstanceOf(ValidationError);
      await updateKOTStatus(kitchen, k.id, "PREPARING");
    }
    expect(await prisma.auditLog.count({ where: { entityType: "Kot", entityId: kk.id, after: { contains: "ACCEPTED" } } })).toBe(1);
    view = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(view.fulfilment).toBe("PREPARING");

    // Guest pays online while the food is cooking: amount is the server's balance.
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(start).toMatchObject({ amount: "1081.50", provider: "mock" });
    const declined = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: { mockOutcome: "decline" } });
    expect(declined).toMatchObject({ paymentStatus: "FAILED", status: "SENT", canPay: true });
    const retry = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(retry.paymentId).not.toBe(start.paymentId);
    const paid = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: retry.paymentId });
    expect(paid).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID", canPay: false, fulfilment: "PREPARING" });
    expect(paid.bill).toMatchObject({ kind: "RECEIPT", paymentStatus: "PAID", balanceDue: "0.00", paid: "1081.50", total: "1081.50" });
    expect(paid.bill.payments).toEqual([expect.objectContaining({ method: "ONLINE", status: "SUCCESS", amount: "1081.50" })]);
    // Re-confirming (refresh / double tap) is a no-op.
    expect((await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: retry.paymentId })).paymentStatus).toBe("SUCCESS");
    await expect(startGuestPayment(placed.orderId, placed.accessKey, key())).rejects.toThrow(/already paid/);

    // Stock consumed exactly once: 2 plates × 0.2 rice.
    expect(num(await currentQuantity(prisma, sys, outletId, mRice))).toBeCloseTo(riceBefore - 0.4, 6);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: placed.orderId, txnType: "SALE_CONSUMPTION" } })).toBe(2);
    await verifyPayment(sys, retry.paymentId);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: placed.orderId, txnType: "SALE_CONSUMPTION" } })).toBe(2);
    // Naan has no recipe -> unmapped queue, not silently dropped.
    expect(await prisma.unmappedSale.count({ where: { outletId, posName: `Naan ${RUN}` } })).toBe(1);

    // Kitchen finishes; the order is completed.
    for (const k of mine) { await updateKOTStatus(kitchen, k.id, "READY"); await updateKOTStatus(kitchen, k.id, "SERVED"); }
    view = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(view.fulfilment).toBe("COMPLETED");
    expect(await prisma.notification.count({ where: { organizationId: orgId, type: "ORDER_READY", body: placed.orderId } })).toBe(1);

    // Staff bill == guest receipt, and a reprint is identical.
    const staffBill = await getOrderBill(prisma, cashier, placed.orderId);
    expect(staffBill).toEqual(view.bill);
    expect(await getOrderBill(prisma, cashier, placed.orderId)).toEqual(staffBill);

    // Sales data moved by exactly this order.
    const after = await salesSummary(prisma, manager, { outletId });
    expect(after.orders - salesBefore.orders).toBe(1);
    expect(after.revenue - salesBefore.revenue).toBeCloseTo(1081.5, 2);
    const day = (await dailySales(prisma, manager, { outletId })).reduce((a, r) => a + r.total, 0);
    expect(day).toBeCloseTo(after.revenue, 2);
    expect((await itemSales(prisma, manager, { outletId })).find((r) => r.menuItemId === biryani)!.qty).toBeGreaterThanOrEqual(2);
    expect((await paymentsByMethod(prisma, manager, { outletId })).find((r: { method: string }) => r.method === "ONLINE")).toBeTruthy();
  });

  it("a prepaid order that staff never accepted goes to the kitchen when the payment is verified", async () => {
    const placed = await placeGuestOrder(token2, { items: [{ menuItemId: cola, qty: 2 }, { menuItemId: paneer, qty: 1 }] }, key());
    const p = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const done = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: p.paymentId });
    expect(done).toMatchObject({ status: "PAID", fulfilment: "SENT_TO_KITCHEN" });
    const o = await getOrder(prisma, cashier, placed.orderId);
    expect(o.kots.map((k) => k.status)).toEqual(["NEW", "NEW"]); // BAR + KITCHEN
    expect(o.kots.flatMap((k) => k.items).length).toBe(2);
    await expect(fireOrderItems(cashier, placed.orderId)).rejects.toBeInstanceOf(ValidationError); // nothing left to send twice
  });

  it("concurrent guest payments for the full balance: exactly one succeeds", async () => {
    const placed = await placeGuestOrder(token2, { items: [{ menuItemId: paneer, qty: 2 }] }, key());
    await submitOrder(cashier, placed.orderId);
    const k1 = key(), k2 = key();
    // Two phones at the table start at once: distinct keys; the second resumes the first's PENDING payment or creates its own.
    const [a, b] = await Promise.all([startGuestPayment(placed.orderId, placed.accessKey, k1), startGuestPayment(placed.orderId, placed.accessKey, k2)]);
    const ids = [...new Set([a.paymentId, b.paymentId])];
    const results = await Promise.allSettled(ids.flatMap((id) => [confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: id }), confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: id })]));
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const success = await prisma.payment.findMany({ where: { orderId: placed.orderId, status: "SUCCESS" } });
    expect(success).toHaveLength(1);
    expect(num(success[0].amount)).toBe(577.5);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(o.status).toBe("PAID");
  });

  it("a refresh during checkout resumes the open payment instead of creating another", async () => {
    const placed = await placeGuestOrder(token2, { items: [{ menuItemId: paneer, qty: 1 }] }, key());
    const first = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const k = key();
    const second = await startGuestPayment(placed.orderId, placed.accessKey, k);
    expect(second.paymentId).toBe(first.paymentId);
    expect((await getGuestOrder(placed.orderId, placed.accessKey)).pendingPaymentId).toBe(first.paymentId);
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(1);
    await cancelOrder(manager, placed.orderId, "test cleanup");
  });

  it("split: a counter part-payment, then the guest pays exactly the rest online", async () => {
    const placed = await placeGuestOrder(token2, { items: [{ menuItemId: paneer, qty: 2 }] }, key()); // 577.50
    await submitOrder(cashier, placed.orderId);
    const cash = await createPayment(cashier, placed.orderId, { method: "CASH", amount: 100 });
    await verifyPayment(cashier, cash.id);
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(view.bill).toMatchObject({ paymentStatus: "PARTIALLY_PAID", paid: "100.00", balanceDue: "477.50" });
    const p = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(p.amount).toBe("477.50");
    expect((await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: p.paymentId })).status).toBe("PAID");
  });

  it("a guest cannot confirm a payment that is not an online payment of their own order", async () => {
    const a = await placeGuestOrder(token2, { items: [{ menuItemId: paneer, qty: 1 }] }, key());
    const b = await placeGuestOrder(token2, { items: [{ menuItemId: naan, qty: 1 }] }, key());
    await submitOrder(cashier, a.orderId);
    await submitOrder(cashier, b.orderId);
    const pb = await startGuestPayment(b.orderId, b.accessKey, key());
    await expect(confirmGuestPayment(a.orderId, a.accessKey, { paymentId: pb.paymentId })).rejects.toBeInstanceOf(NotFoundError);
    const cash = await createPayment(cashier, a.orderId, { method: "CASH", amount: 10 });
    await expect(confirmGuestPayment(a.orderId, a.accessKey, { paymentId: cash.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: cash.id } })).status).toBe("PENDING");
    await expect(confirmGuestPayment(a.orderId, a.accessKey, { paymentId: pb.paymentId, status: "SUCCESS" })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("order state safety", () => {
  it("cancelling stops the kitchen, frees the table and never consumes stock", async () => {
    const placed = await placeGuestOrder(token3, { items: [{ menuItemId: biryani, modifierOptionIds: [spiceMild], qty: 1 }] }, key());
    await submitOrder(cashier, placed.orderId);
    const [kot] = (await getOrder(prisma, cashier, placed.orderId)).kots;
    await updateKOTStatus(kitchen, kot.id, "ACCEPTED");
    await cancelOrder(manager, placed.orderId, "guest left");
    const o = await getOrder(prisma, manager, placed.orderId);
    expect(o.status).toBe("CANCELLED");
    expect(o.kots.map((k) => k.status)).toEqual(["CANCELLED"]);
    expect(o.kots[0].items.every((i) => i.status === "CANCELLED")).toBe(true);
    expect((await listKOTs(prisma, kitchen, { outletId })).some((k) => k.orderId === placed.orderId)).toBe(false);
    expect(o.stockConsumed).toBe(false);
    expect((await getGuestOrder(placed.orderId, placed.accessKey))).toMatchObject({ fulfilment: "CANCELLED", canPay: false });
    await expect(startGuestPayment(placed.orderId, placed.accessKey, key())).rejects.toThrow(/cancelled/);
    // CANCELLED is terminal.
    await expect(submitOrder(cashier, placed.orderId)).rejects.toBeInstanceOf(ValidationError);
    await expect(createPayment(cashier, placed.orderId, { method: "CASH", amount: 1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("an order holding the guest's money cannot be cancelled until it is refunded", async () => {
    const o = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: paneer, qty: 2 }] }); // 577.50
    const p = await createPayment(cashier, o.id, { method: "CASH", amount: 200 });
    await verifyPayment(cashier, p.id);
    await expect(cancelOrder(manager, o.id, "changed mind")).rejects.toThrow(/refund them before cancelling/);
    await refundPayment(manager, p.id, { amount: 200, reason: "changed mind" });
    await expect(cancelOrder(manager, o.id, "changed mind")).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("a settled order cannot be repriced, and repricing can never drop below what was paid", async () => {
    const o = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: paneer, qty: 2 }] }); // 577.50
    const part = await createPayment(cashier, o.id, { method: "CASH", amount: 500 });
    await verifyPayment(cashier, part.id);
    await expect(applyDiscount(cashier, o.id, 100)).rejects.toThrow(/below the 500.* already paid/);
    await applyDiscount(cashier, o.id, 50); // tax after discount: 550 - 50 = 500 taxable, + 25 tax = 525 >= 500
    expect(num((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total)).toBe(525);
    expect(await prisma.auditLog.count({ where: { entityType: "Order", entityId: o.id, after: { contains: "\"discount\":\"50.00\"" } } })).toBe(1);
    const rest = await createPayment(cashier, o.id, { method: "CARD", amount: 25 });
    await verifyPayment(cashier, rest.id);
    await expect(applyDiscount(cashier, o.id, 0)).rejects.toThrow(/Cannot discount a PAID order/);
    await expect(updateOrderItem(cashier, o.items[0].id, { discount: 10 })).rejects.toThrow(/closed/);
    await expect(addOrderItem(cashier, o.id, { menuItemId: naan, qty: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPayment(cashier, o.id, { method: "CASH", amount: 1 })).rejects.toThrow(/PAID order/); // no overpayment
    // PAID -> REFUNDED only via refunds; once REFUNDED nothing can be edited.
    await refundPayment(manager, part.id, { amount: 500 });
    await refundPayment(manager, rest.id, { amount: 25 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("REFUNDED");
    await expect(updateOrderItem(cashier, o.items[0].id, { notes: "x" })).rejects.toThrow(/closed/);
    const bill = await getOrderBill(prisma, cashier, o.id);
    expect(bill).toMatchObject({ paymentStatus: "REFUNDED", refunded: "525.00", balanceDue: "0.00" });
  });

  it("a quantity already on a kitchen ticket cannot be changed; added items go out on an additional KOT", async () => {
    const o = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: paneer, qty: 1 }] });
    await expect(updateOrderItem(cashier, o.items[0].id, { qty: 3 })).rejects.toThrow(/already sent to the kitchen/);
    await addOrderItem(cashier, o.id, { menuItemId: naan, qty: 2 });
    const fired = await fireOrderItems(cashier, o.id);
    expect(fired).toHaveLength(1);
    const fresh = await getOrder(prisma, cashier, o.id);
    expect(fresh.kots).toHaveLength(2);
    expect(fresh.kots.find((k) => k.id === fired[0].id)!.items.map((i) => i.name)).toEqual([`Naan ${RUN}`]); // only the new item
    expect(await fireOrderItems(cashier, o.id)).toHaveLength(0); // nothing fired twice
    await cancelOrder(manager, o.id, "test cleanup");
  });
});

describe("bill / receipt", () => {
  it("multi-rate tax, modifiers, quantities, discount and rounding agree with the order", async () => {
    // Cola 99.99 × 3 @18% = 299.97 net ; Naan+cheese 90 × 1 @5% = 90 net ; ₹10 discount shared by value:
    // naan 2.31, cola 7.69 (remainder on the largest) -> taxable 292.28 @18% = 52.61, 87.69 @5% = 4.38
    const o = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", items: [{ menuItemId: cola, qty: 3 }, { menuItemId: naan, modifierOptionIds: [extraCheese], qty: 1 }] });
    await applyDiscount(cashier, o.id, 10);
    const bill = await getOrderBill(prisma, cashier, o.id);
    expect(bill).toMatchObject({ kind: "BILL", subtotal: "389.97", discount: "10.00", tax: "56.99", total: "436.96", paymentStatus: "UNPAID", balanceDue: "436.96", table: null, billNo: o.id.slice(-6).toUpperCase() });
    expect(bill.taxes).toEqual([{ ratePct: "5", taxable: "87.69", amount: "4.38" }, { ratePct: "18", taxable: "292.28", amount: "52.61" }]);
    expect(bill.taxes.reduce((a, t) => a + Number(t.amount), 0)).toBeCloseTo(Number(bill.tax), 2);
    expect(bill.lines.find((l) => l.name === `Naan ${RUN}`)).toMatchObject({ qty: "1", unitPrice: "60.00", modifiers: [{ name: `Extras ${RUN}: Cheese`, priceDelta: "30.00" }], lineTotal: "90.00" });
    expect(bill.restaurant).toMatchObject({ name: `QR Org ${RUN}`, outletName: "QR Central", address: "1 Food St" });
    // Persisted totals are exactly what calculateOrderTotals produced.
    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([num(persisted.subtotal), num(persisted.tax), num(persisted.total)]).toEqual([389.97, 56.99, 436.96]);
    await cancelOrder(manager, o.id, "test cleanup");
  });

  it("tax breakdown always sums to the order tax (rounding residue placed on the largest rate)", () => {
    const at = new Date();
    const item = (lineTotal: string, taxPct: number) => ({ name: "x", qty: 1, unitPrice: lineTotal, discount: 0, taxPct, lineTotal, notes: null, modifiers: [] });
    // 0.125 @ 18% + 0.125 @ 12% + 0.125 @ 5% : unrounded tax 0.04375 -> order tax 0.04
    const bill = buildBill(
      { id: "ord_x", invoiceNo: null, status: "OPEN", channel: "QR", source: "QR", covers: 1, createdAt: at, paidAt: null, subtotal: "0.38", discount: 0, tax: "0.04", total: "0.42", table: null, items: [item("0.125", 18), item("0.125", 12), item("0.125", 5)], payments: [], kots: [] },
      { organization: { name: "N", legalName: null }, outlet: { name: "O", address: null, phone: null, timezone: "Asia/Kolkata", currency: "INR" } },
    );
    expect(bill.taxes.reduce((a, t) => a + Number(t.amount) * 100, 0)).toBe(4);
  });
});

describe("fulfilment stage", () => {
  it("derives the guest-visible stage from order status and tickets", () => {
    expect(fulfilmentStage({ status: "OPEN", kots: [] })).toBe("AWAITING_ACCEPTANCE");
    expect(fulfilmentStage({ status: "SENT", kots: [{ status: "NEW" }, { status: "READY" }] })).toBe("SENT_TO_KITCHEN");
    expect(fulfilmentStage({ status: "PAID", kots: [{ status: "PREPARING" }, { status: "NEW" }] })).toBe("PREPARING");
    expect(fulfilmentStage({ status: "SENT", kots: [{ status: "READY" }, { status: "SERVED" }, { status: "CANCELLED" }] })).toBe("READY");
    expect(fulfilmentStage({ status: "SENT", kots: [{ status: "SERVED" }] })).toBe("SERVED");
    expect(fulfilmentStage({ status: "PAID", kots: [{ status: "SERVED" }] })).toBe("COMPLETED");
    expect(fulfilmentStage({ status: "CANCELLED", kots: [{ status: "READY" }] })).toBe("CANCELLED");
  });
});
