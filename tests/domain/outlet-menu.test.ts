/**
 * Per-outlet menu overrides: price, offered and sold-out differ by outlet and
 * are applied by server-side order pricing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, ValidationError } from "@/server/db/scope";
import { createMenuItem, setOutletMenuItem, listMenu } from "@/server/services/menu";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string, itemId: string;
let ctx: AccessContext, mgrA: AccessContext;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `OM Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `OA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `OB${RUN}`, name: "B" } })).id;
  ctx = systemContext(orgId, [outletA, outletB]);
  mgrA = { userId: "mgrA", organizationId: orgId, outletIds: [outletA], roles: ["MANAGER"], outletRoles: { [outletA]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  itemId = (await createMenuItem(ctx, { name: `Filter Coffee ${RUN}`, price: 60, taxPct: 0 })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

async function priceAt(outletId: string) {
  const o = await createOrder(ctx, { outletId });
  return num((await addOrderItem(ctx, o.id, { menuItemId: itemId })).unitPrice);
}

describe("outlet menu overrides", () => {
  it("an outlet manager can override price at their own outlet only; audited", async () => {
    await setOutletMenuItem(mgrA, { outletId: outletA, menuItemId: itemId, price: 80 });
    await expect(setOutletMenuItem(mgrA, { outletId: outletB, menuItemId: itemId, price: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await priceAt(outletA)).toBe(80);
    expect(await priceAt(outletB)).toBe(60);
    expect(await prisma.auditLog.count({ where: { entityType: "OutletMenuItem", action: "PRICE_CHANGE", outletId: outletA } })).toBe(1);
  });

  it("sold out and not-offered apply per outlet", async () => {
    await setOutletMenuItem(mgrA, { outletId: outletA, menuItemId: itemId, soldOut: true });
    const oA = await createOrder(ctx, { outletId: outletA });
    await expect(addOrderItem(ctx, oA.id, { menuItemId: itemId })).rejects.toThrow(/sold out at this outlet/);
    expect(await priceAt(outletB)).toBe(60); // unaffected
    await setOutletMenuItem(mgrA, { outletId: outletA, menuItemId: itemId, soldOut: false, active: false });
    await expect(addOrderItem(ctx, oA.id, { menuItemId: itemId })).rejects.toBeInstanceOf(ValidationError);
    await setOutletMenuItem(mgrA, { outletId: outletA, menuItemId: itemId, active: true, price: null }); // clear price override
    expect(await priceAt(outletA)).toBe(60);
  });

  it("the outlet menu view reports effective values", async () => {
    await setOutletMenuItem(ctx, { outletId: outletB, menuItemId: itemId, price: 70, soldOut: true });
    const menuB = (await listMenu(prisma, ctx, { outletId: outletB })) as unknown as Array<{ id: string; effectivePrice: number; effectiveSoldOut: boolean; offered: boolean }>;
    expect(menuB.find((i) => i.id === itemId)).toMatchObject({ effectivePrice: 70, effectiveSoldOut: true, offered: true });
    await setOutletMenuItem(ctx, { outletId: outletB, menuItemId: itemId, active: false });
    const offeredB = await listMenu(prisma, ctx, { outletId: outletB, activeOnly: true });
    expect(offeredB.some((i) => i.id === itemId)).toBe(false);
    await expect(listMenu(prisma, mgrA, { outletId: outletB })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
