/**
 * Phase 5B — organization isolation on writes.
 *
 * `assertOutletAccess` is a no-op for org-wide / super-admin callers, so every
 * write that accepts a client-supplied outletId must additionally confirm the
 * outlet belongs to the caller's organization (assertOutletInOrg). These tests
 * prove an org-wide user of Org A can never create a scoped record against Org
 * B's outlet, while same-org writes keep working.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { buildAccessContext } from "@/server/auth/context";
import { type AccessContext, NotFoundError } from "@/server/db/scope";
import { createOrder } from "@/server/services/orders";
import { createExpense, recordPettyCash, openCashDrawer } from "@/server/services/finance";
import { createIndent } from "@/server/services/procurement";
import { createFeedback } from "@/server/services/crm";
import { createReservation } from "@/server/services/reservations";
import { recordPurchaseReceipt } from "@/server/services/inventory";

const RUN = Date.now().toString(36);
let orgA: string, outletA: string, orgB: string, outletB: string;
let ownerA: AccessContext; // org-wide (membership outletId=null) OWNER of Org A

async function orgWideOwner(orgId: string, tag: string): Promise<AccessContext> {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${tag}-${RUN}@iso.test`, name: tag, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId: null, role: "OWNER" } });
  return buildAccessContext(prisma, u.id);
}

beforeAll(async () => {
  orgA = (await prisma.organization.create({ data: { name: `Iso A ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgA, code: `IA${RUN}`, name: "A" } })).id;
  orgB = (await prisma.organization.create({ data: { name: `Iso B ${RUN}` } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgB, code: `IB${RUN}`, name: "B" } })).id;
  ownerA = await orgWideOwner(orgA, "ownera");
});

afterAll(async () => { await prisma.$disconnect(); });

describe("organization isolation on writes", () => {
  it("org-wide owner of Org A is org-wide but not super admin (bypass would otherwise apply)", () => {
    expect(ownerA.organizationId).toBe(orgA);
    expect(ownerA.isOrgWide).toBe(true);
    expect(ownerA.isSuperAdmin).toBe(false);
    expect(ownerA.outletIds).not.toContain(outletB); // Org B's outlet is not in reach
  });

  it("rejects every scoped write against a foreign organization's outlet", async () => {
    const future = new Date(Date.now() + 86_400_000);
    await expect(createOrder(ownerA, { outletId: outletB })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createExpense(ownerA, { outletId: outletB, category: "GAS", amount: 100 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordPettyCash(ownerA, { outletId: outletB, type: "OPENING", amount: 500 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(openCashDrawer(ownerA, { outletId: outletB, openingFloat: 1000 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createIndent(ownerA, { outletId: outletB, lines: [{ materialId: "m", qty: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createFeedback(ownerA, { outletId: outletB, rating: 5 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createReservation(ownerA, { outletId: outletB, partySize: 2, reservedAt: future })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordPurchaseReceipt(ownerA, { outletId: outletB, materialId: "m", quantity: 1, rate: 10 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writes no row into the foreign organization's outlet", async () => {
    expect(await prisma.order.count({ where: { outletId: outletB } })).toBe(0);
    expect(await prisma.expense.count({ where: { outletId: outletB } })).toBe(0);
    expect(await prisma.pettyCashTxn.count({ where: { outletId: outletB } })).toBe(0);
    expect(await prisma.purchaseIndent.count({ where: { outletId: outletB } })).toBe(0);
    expect(await prisma.feedback.count({ where: { outletId: outletB } })).toBe(0);
    expect(await prisma.reservation.count({ where: { outletId: outletB } })).toBe(0);
    expect(await prisma.inventoryLedger.count({ where: { outletId: outletB } })).toBe(0);
  });

  it("still allows same-organization writes at the caller's own outlet", async () => {
    const order = await createOrder(ownerA, { outletId: outletA });
    expect(order).toMatchObject({ organizationId: orgA, outletId: outletA, status: "OPEN" });
    const expense = await createExpense(ownerA, { outletId: outletA, category: "GAS", amount: 250 });
    expect(expense).toMatchObject({ organizationId: orgA, outletId: outletA });
  });
});
