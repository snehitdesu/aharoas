/**
 * Back-office reads/admin commands (adminQueries.ts): organization, departments,
 * floors, conversions, modifier groups, role matrix, attendance/leave, payment /
 * refund / petty-cash / drawer lists, stock ledger, audit trail — authorization,
 * outlet + organization isolation, filters, pagination and secret hygiene.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  getOrganization, updateOrganization, listDepartments, createDepartment, updateDepartment, listFloors, updateFloor,
  listUnitConversions, listMaterialCategories, listModifierGroups, roleMatrix, listAttendance, listLeave,
  listPayments, listRefunds, listPettyCash, listDrawerSessions, listLedger, listAuditLogs,
} from "@/server/services/adminQueries";
import { createUnit, createUnitConversion, createMaterial, createFloor } from "@/server/services/masterData";
import { createMenuItem, createModifierGroup, addModifierOption, attachModifierGroup } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { recordOpeningBalance } from "@/server/services/inventory";
import { recordPettyCash, openCashDrawer } from "@/server/services/finance";
import { checkIn, requestLeave } from "@/server/services/staff";

const RUN = Date.now().toString(36);
let orgId: string, outletA: string, outletB: string;
let owner: AccessContext, mgrA: AccessContext, mgrB: AccessContext, cashierA: AccessContext, storeA: AccessContext, org2: AccessContext, sys: AccessContext;
let kg: string, g: string, rice: string, floorA: string, mgrAUser: string, cashierUser: string, paymentA: string;

const member = (userId: string, role: string, outletId: string): AccessContext => ({ userId, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Admin Org ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AA${RUN}`, name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AB${RUN}`, name: "B" } })).id;
  sys = systemContext(orgId, [outletA, outletB]);
  const ownerUser = (await prisma.user.create({ data: { organizationId: orgId, email: `owner-${RUN}@t.local`, name: "Owner", passwordHash: "x" } })).id;
  mgrAUser = (await prisma.user.create({ data: { organizationId: orgId, email: `mgra-${RUN}@t.local`, name: "Manager A", passwordHash: "x" } })).id;
  cashierUser = (await prisma.user.create({ data: { organizationId: orgId, email: `cash-${RUN}@t.local`, name: "Cashier A", passwordHash: "x" } })).id;
  await prisma.membership.createMany({ data: [
    { organizationId: orgId, userId: ownerUser, role: "OWNER" },
    { organizationId: orgId, userId: mgrAUser, outletId: outletA, role: "MANAGER" },
    { organizationId: orgId, userId: cashierUser, outletId: outletA, role: "CASHIER" },
  ] });
  owner = { userId: ownerUser, organizationId: orgId, outletIds: [outletA, outletB], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
  mgrA = member(mgrAUser, "MANAGER", outletA);
  mgrB = member(`mgrb-${RUN}`, "MANAGER", outletB);
  cashierA = member(cashierUser, "CASHIER", outletA);
  storeA = member(`store-${RUN}`, "STORE", outletA);
  org2 = systemContext((await prisma.organization.create({ data: { name: `Admin Org2 ${RUN}` } })).id, []);

  kg = (await createUnit(owner, { code: `kg${RUN}`, name: "Kilogram", kind: "WEIGHT" })).id;
  g = (await createUnit(owner, { code: `g${RUN}`, name: "Gram", kind: "WEIGHT" })).id;
  rice = (await createMaterial(owner, { sku: `R-${RUN}`, name: "Rice", baseUnitId: kg })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("organization", () => {
  it("any member reads; only an org-wide org.manage role edits (audited)", async () => {
    expect((await getOrganization(prisma, cashierA)).canManage).toBe(false);
    expect((await getOrganization(prisma, owner)).canManage).toBe(true);
    await expect(updateOrganization(mgrA, { name: "Hijack" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOrganization(owner, { timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(ZodError);
    await expect(updateOrganization(owner, { currency: "USD" } as never)).rejects.toBeInstanceOf(ZodError); // currency is not editable
    expect((await updateOrganization(owner, { name: `Renamed ${RUN}`, gstin: "29ABCDE1234F1Z5" })).name).toBe(`Renamed ${RUN}`);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "Organization" } })).toBe(1);
    expect((await getOrganization(prisma, org2)).id).not.toBe(orgId); // always the caller's own org
  });
});

describe("departments and floors", () => {
  it("outlet managers manage their own outlet only; names unique per outlet", async () => {
    const d = await createDepartment(mgrA, { outletId: outletA, name: "Bar", kind: "BAR" });
    await expect(createDepartment(mgrA, { outletId: outletA, name: "Bar" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createDepartment(mgrA, { outletId: outletB, name: "Bar" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createDepartment(storeA, { outletId: outletA, name: "Store" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateDepartment(mgrB, d.id, { active: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateDepartment(org2, d.id, { active: false })).rejects.toBeInstanceOf(NotFoundError);
    expect((await updateDepartment(mgrA, d.id, { active: false })).active).toBe(false);
    expect((await listDepartments(prisma, storeA, outletA)).map((x) => x.name)).toContain("Bar");
    await expect(listDepartments(prisma, storeA, outletB)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("floors list with table counts and are editable by the outlet manager", async () => {
    floorA = (await createFloor(mgrA, { outletId: outletA, name: "Ground" })).id;
    await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: outletA, floorId: floorA, code: `T${RUN}`, capacity: 4 } });
    const floors = await listFloors(prisma, mgrA, outletA);
    expect(floors.find((f) => f.id === floorA)?.tableCount).toBe(1);
    await expect(updateFloor(mgrB, floorA, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await updateFloor(mgrA, floorA, { name: "Ground floor", sortOrder: 1 })).name).toBe("Ground floor");
  });
});

describe("master reads", () => {
  it("conversions resolve unit/material names; categories and modifier groups list", async () => {
    await createUnitConversion(owner, { fromUnitId: kg, toUnitId: g, factor: 1000 });
    const conv = await listUnitConversions(prisma, storeA);
    expect(conv).toEqual([expect.objectContaining({ from: `kg${RUN}`, to: `g${RUN}`, factor: 1000, material: null })]);
    expect(Array.isArray(await listMaterialCategories(prisma, storeA))).toBe(true);
    await expect(listUnitConversions(prisma, org2)).resolves.toEqual([]); // other org sees none of ours

    const item = await createMenuItem(sys, { name: `Pizza ${RUN}`, price: 300 });
    const grp = await createModifierGroup(sys, { name: `Crust ${RUN}`, minSelect: 1, maxSelect: 1 });
    await addModifierOption(sys, { groupId: grp.id, name: "Thin", priceDelta: 20 });
    await attachModifierGroup(sys, item.id, grp.id);
    const groups = await listModifierGroups(prisma, cashierA);
    expect(groups.find((x) => x.id === grp.id)).toMatchObject({ itemCount: 1, options: [expect.objectContaining({ name: "Thin", priceDelta: 20 })] });
    await expect(listModifierGroups(prisma, storeA)).rejects.toBeInstanceOf(ForbiddenError); // STORE has no menu.view
  });

  it("role matrix: staff managers only; grantable reflects authority", async () => {
    await expect(Promise.resolve().then(() => roleMatrix(cashierA))).rejects.toBeInstanceOf(ForbiddenError);
    const m = roleMatrix(mgrA);
    expect(m.roles.find((r) => r.role === "CASHIER")?.grantable).toBe(true);
    expect(m.roles.find((r) => r.role === "MANAGER")?.grantable).toBe(false); // peers cannot mint peers
    expect(m.roles.find((r) => r.role === "OWNER")?.grantable).toBe(false);
    expect(roleMatrix(owner).roles.find((r) => r.role === "OWNER")?.grantable).toBe(true);
    expect(m.roles.some((r) => (r.role as string) === "SUPER_ADMIN")).toBe(false);
  });
});

describe("staff lists", () => {
  it("attendance and leave: managers see their outlet; staff see only their own", async () => {
    await checkIn(cashierA, { outletId: outletA });
    await requestLeave(cashierA, { outletId: outletA, fromDate: new Date("2030-01-01"), toDate: new Date("2030-01-02"), reason: "trip" });
    const att = await listAttendance(prisma, mgrA, { outletId: outletA });
    expect(att.items[0]).toMatchObject({ userId: cashierUser, userName: "Cashier A" });
    expect((await listAttendance(prisma, cashierA, { userId: cashierUser })).items).toHaveLength(1);
    await expect(listAttendance(prisma, cashierA, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError); // not self-scoped
    await expect(listAttendance(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listAttendance(prisma, mgrB, {})).items).toHaveLength(0); // own outlet only
    const leave = await listLeave(prisma, mgrA, { status: "PENDING" });
    expect(leave.items).toEqual([expect.objectContaining({ userName: "Cashier A", reason: "trip" })]);
    expect((await listLeave(prisma, cashierA, { userId: cashierUser })).items).toHaveLength(1);
    await expect(listLeave(prisma, cashierA, { userId: mgrAUser })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("finance lists", () => {
  it("payments, refunds, petty cash and drawer are finance.view scoped; keys never leak", async () => {
    const item = await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100 });
    const order = await placeOrder(sys, { outletId: outletA, channel: "TAKEAWAY", items: [{ menuItemId: item.id, qty: 1 }], submit: true });
    const p = await createPayment(owner, order.id, { method: "CASH", amount: 100, idempotencyKey: `adm-${RUN}-pay` });
    paymentA = p.id;
    await verifyPayment(owner, p.id);
    await refundPayment(owner, p.id, { amount: 40, reason: "cold food", idempotencyKey: `adm-${RUN}-ref` } as never);

    const pays = await listPayments(prisma, mgrA, { outletId: outletA });
    expect(pays.items).toEqual([expect.objectContaining({ id: p.id, amount: 100, refunded: 40, method: "CASH" })]);
    expect(pays.items[0]).not.toHaveProperty("idempotencyKey");
    expect(pays.items[0]).not.toHaveProperty("requestHash");
    expect((await listPayments(prisma, mgrA, { method: "UPI" })).items).toHaveLength(0);
    expect((await listPayments(prisma, mgrB, {})).items).toHaveLength(0); // outlet B manager: none of outlet A
    await expect(listPayments(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPayments(prisma, storeA, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listPayments(prisma, org2, {})).items).toHaveLength(0);

    const refunds = await listRefunds(prisma, mgrA, {});
    expect(refunds.items).toEqual([expect.objectContaining({ amount: 40, reason: "cold food" })]);
    expect(refunds.items[0]).not.toHaveProperty("idempotencyKey");

    await recordPettyCash(mgrA, { outletId: outletA, type: "OPENING", amount: 500 } as never);
    expect((await listPettyCash(prisma, mgrA, { outletId: outletA })).items[0]).toMatchObject({ type: "OPENING", amount: 500 });
    await expect(listPettyCash(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);

    await openCashDrawer(mgrA, { outletId: outletA, openingFloat: 1000 } as never);
    expect((await listDrawerSessions(prisma, cashierA, { outletId: outletA, status: "OPEN" })).items[0]).toMatchObject({ openingFloat: 1000, status: "OPEN" });
  });
});

describe("stock ledger", () => {
  it("read-only ledger with material names, filters and cursor pages", async () => {
    for (let i = 0; i < 3; i++) await recordOpeningBalance(sys, { outletId: outletA, materialId: rice, quantity: 1 + i, rate: 50, sourceRef: `adm-${RUN}-ob-${i}` });
    const p1 = await listLedger(prisma, storeA, { outletId: outletA, take: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]).toMatchObject({ materialName: "Rice", unit: `kg${RUN}`, txnType: "OPENING_BALANCE" });
    const p2 = await listLedger(prisma, storeA, { outletId: outletA, take: 2, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1);
    expect(new Set([...p1.items, ...p2.items].map((r) => r.id)).size).toBe(3); // no overlap
    expect((await listLedger(prisma, storeA, { outletId: outletA, txnType: "WASTAGE" })).items).toHaveLength(0);
    await expect(listLedger(prisma, mgrB, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listLedger(prisma, cashierA, { outletId: outletA })).rejects.toBeInstanceOf(ForbiddenError); // no inventory.view
  });
});

describe("audit trail", () => {
  it("audit.view only; org-wide sees org-level rows; entity filter works", async () => {
    await expect(listAuditLogs(prisma, mgrA, {})).rejects.toBeInstanceOf(ForbiddenError); // MANAGER lacks audit.view
    const org = await listAuditLogs(prisma, owner, { entityType: "Organization" });
    expect(org.items).toHaveLength(1);
    expect(org.items[0]).toMatchObject({ action: "UPDATE", actorName: "Owner" });
    expect((org.items[0].after as { name: string }).name).toBe(`Renamed ${RUN}`);
    const pay = await listAuditLogs(prisma, owner, { entityType: "Payment", entityId: paymentA });
    expect(pay.items.length).toBeGreaterThanOrEqual(1);
    expect((await listAuditLogs(prisma, org2, { entityType: "Organization" })).items.every((r) => r.entityId !== orgId)).toBe(true);
  });
});
