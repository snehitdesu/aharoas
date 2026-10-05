/**
 * Phase 6 — staff & mobile, against the real services:
 *  - captain rounds: menu-priced only, atomic, idempotent (replay, 409 on reuse,
 *    concurrent double submit), refused on BILLED / PAID orders
 *  - removing an unsent line; a sent line cannot be removed
 *  - request bill: OPEN / unsent refused, BILLED + table BILL_REQUESTED, cashier
 *    notification, no further rounds, then payment settles it (PAID, table free)
 *  - kot.serve: floor staff may only move READY -> SERVED
 *  - table board + manager summary: derived state, sections by role, isolation
 *  - roles: ACCOUNTANT, rank ceilings, self-edit, inactive users, scoped staff list
 *  - notifications: role-filtered broadcasts, per-user read receipts, NEW_ORDER / PAYMENT_FAILED
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext, buildAccessContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { placeOrder, addOrderRound, removeOrderItem, requestBill, getOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { updateKOTStatus } from "@/server/services/kot";
import { createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup } from "@/server/services/menu";
import { tableBoard, managerSummary } from "@/server/services/mobile";
import { createStaff, assignMembership, setUserActive, listStaff } from "@/server/services/staff";
import { listNotifications, unreadCount, markNotificationRead, markAllRead, createNotification } from "@/server/services/notifications";
import { placeGuestOrder, startGuestPayment, confirmGuestPayment } from "@/server/services/guestOrdering";
import { rotateTableQr } from "@/server/services/masterData";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, A: string, B: string, foreignOrg: string;
let sys: AccessContext, captain: AccessContext, cashier: AccessContext, cashier2: AccessContext, kitchen: AccessContext, manager: AccessContext, captainB: AccessContext, accountant: AccessContext, foreign: AccessContext;
let dosa: string, coffee: string, large: string, shot: string;
let t1: string, t2: string, t3: string, t4: string;
let n = 0;
const key = () => `p6-${RUN}-${++n}-key`;
const member = (id: string, role: string, outletId: string): AccessContext => ({ userId: id, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
async function user(role: string, outletId: string | null, name = role) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${name.toLowerCase()}-${RUN}-${++n}@p6.test`, name, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId, role } });
  return u.id;
}
const table = async (outletId: string, code: string) => (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `${code}-${RUN}` } })).id;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `P6 Org ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P6A${RUN}`, name: "P6 A" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `P6B${RUN}`, name: "P6 B" } })).id;
  sys = systemContext(orgId, [A, B]);
  captain = member(await user("CAPTAIN", A), "CAPTAIN", A);
  cashier = member(await user("CASHIER", A), "CASHIER", A);
  cashier2 = member(await user("CASHIER", A, "Cashier2"), "CASHIER", A);
  kitchen = member(await user("KITCHEN", A), "KITCHEN", A);
  manager = member(await user("MANAGER", A), "MANAGER", A);
  accountant = member(await user("ACCOUNTANT", A), "ACCOUNTANT", A);
  captainB = member(await user("CAPTAIN", B, "CaptainB"), "CAPTAIN", B);
  foreignOrg = (await prisma.organization.create({ data: { name: `P6 Foreign ${RUN}` } })).id;
  foreign = systemContext(foreignOrg, [(await prisma.outlet.create({ data: { organizationId: foreignOrg, code: `P6F${RUN}`, name: "F" } })).id]);
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: A, name: "KITCHEN", kind: "KITCHEN" } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100, taxPct: 5 })).id;
  coffee = (await createMenuItem(sys, { name: `Coffee ${RUN}`, price: 50, taxPct: 0 })).id;
  large = (await addVariant(sys, { menuItemId: coffee, name: "Large", priceDelta: 20 })).id;
  const g = await createModifierGroup(sys, { name: `Extras ${RUN}`, minSelect: 0, maxSelect: 2 });
  shot = (await addModifierOption(sys, { groupId: g.id, name: "Extra shot", priceDelta: 15 })).id;
  await attachModifierGroup(sys, coffee, g.id);
  [t1, t2, t3, t4] = [await table(A, "T1"), await table(A, "T2"), await table(A, "T3"), await table(A, "T4")];
});

afterAll(async () => { await prisma.$disconnect(); });

async function openTable(tableId: string, items = [{ menuItemId: dosa, qty: 1 }]) {
  return placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId, covers: 2, items, submit: true }, undefined);
}

describe("captain rounds", () => {
  it("a round is menu-priced, atomic and sent to the kitchen; a retry with the same key replays it", async () => {
    const o = await openTable(t1);
    const k = key();
    const body = { items: [{ menuItemId: coffee, qty: 2, variantId: large, modifierOptionIds: [shot], notes: "less sugar" }] };
    const first = await addOrderRound(captain, o.id, body, k);
    expect(first.round).toMatchObject({ itemCount: 1, fired: true, replayed: false });
    const again = await addOrderRound(captain, o.id, body, k);
    expect(again.round).toMatchObject({ id: first.round.id, replayed: true });
    const order = await getOrder(prisma, captain, o.id);
    const coffeeLines = order.items.filter((i) => i.menuItemId === coffee);
    expect(coffeeLines).toHaveLength(1); // not added twice
    expect(coffeeLines[0]).toMatchObject({ name: `Coffee ${RUN} (Large)`, notes: "less sugar" });
    expect(num(coffeeLines[0].lineTotal)).toBe(170); // (50 + 20 + 15) × 2 from the menu
    expect(order.kots).toHaveLength(2); // first send + this round, once
    await expect(addOrderRound(captain, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, k)).rejects.toBeInstanceOf(ConflictError);
  });

  it("concurrent double submit of one round creates it once", async () => {
    const o = await openTable(t2);
    const k = key();
    const body = { items: [{ menuItemId: dosa, qty: 3 }] };
    const results = await Promise.allSettled([addOrderRound(captain, o.id, body, k), addOrderRound(captain, o.id, body, k)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const order = await getOrder(prisma, captain, o.id);
    expect(order.items.filter((i) => num(i.qty) === 3)).toHaveLength(1);
    expect(await prisma.orderRound.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("client prices / open items are refused; other outlet, other org and the kitchen are refused", async () => {
    const o = await openTable(t3);
    await expect(addOrderRound(captain, o.id, { items: [{ menuItemId: dosa, qty: 1, unitPrice: 1 } as never] }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(addOrderRound(captain, o.id, { items: [{ name: "Free food", qty: 1 } as never] }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(addOrderRound(captainB, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, key())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addOrderRound(kitchen, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, key())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addOrderRound(foreign, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, key())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a round on an OPEN (saved) order submits it; unsent lines can be removed, sent ones cannot", async () => {
    const o = await placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId: t4, items: [{ menuItemId: dosa, qty: 1 }, { menuItemId: coffee, qty: 1 }], submit: false });
    const [dosaLine, coffeeLine] = [o.items.find((i) => i.menuItemId === dosa)!, o.items.find((i) => i.menuItemId === coffee)!];
    const after = await removeOrderItem(captain, coffeeLine.id);
    expect(num(after.subtotal)).toBe(100);
    await expect(removeOrderItem(kitchen, dosaLine.id)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await addOrderRound(captain, o.id, { items: [{ menuItemId: coffee, qty: 1 }] }, key());
    expect(r.order.status).toBe("SENT");
    expect(r.order.kots).toHaveLength(1);
    await expect(removeOrderItem(captain, dosaLine.id)).rejects.toThrow(/already sent to the kitchen/);
  });
});

describe("bill request -> payment", () => {
  it("BILLED + table BILL_REQUESTED + cashier alert; no more rounds; payment settles and frees the table", async () => {
    const tableId = await table(A, "TB");
    const o = await placeOrder(captain, { outletId: A, channel: "DINE_IN", tableId, items: [{ menuItemId: dosa, qty: 2 }], submit: false });
    await expect(requestBill(captain, o.id)).rejects.toThrow(/Send the order to the kitchen/);
    await addOrderRound(captain, o.id, { items: [{ menuItemId: coffee, qty: 1 }], fire: false }, key());
    await prisma.order.update({ where: { id: o.id }, data: { status: "SENT" } }); // simulate an order sent earlier with a line left unsent
    await expect(requestBill(captain, o.id)).rejects.toThrow(/not sent to the kitchen/);
    const unsent = (await getOrder(prisma, captain, o.id)).items.filter((i) => i.menuItemId === coffee)[0];
    await removeOrderItem(captain, unsent.id);
    await addOrderRound(captain, o.id, { items: [{ menuItemId: coffee, qty: 1 }] }, key());
    const billed = await requestBill(captain, o.id);
    expect(billed.status).toBe("BILLED");
    expect((await requestBill(captain, o.id)).status).toBe("BILLED"); // repeat = no-op
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: tableId } })).status).toBe("BILL_REQUESTED");
    await expect(addOrderRound(captain, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, key())).rejects.toThrow(/BILLED/);
    // Cashiers see the alert; the kitchen does not.
    const forCashier = await listNotifications(prisma, cashier, { onlyUnread: true });
    expect(forCashier.some((x) => x.type === "BILL_REQUESTED" && x.title.includes("TB"))).toBe(true);
    expect((await listNotifications(prisma, kitchen)).some((x) => x.type === "BILL_REQUESTED")).toBe(false);
    // H1 payment path unchanged: the cashier collects, the order settles, the table frees up.
    const total = num((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total);
    const p = await createPayment(cashier, o.id, { method: "CASH", amount: total, idempotencyKey: key() });
    await verifyPayment(cashier, p.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
    expect((await prisma.restaurantTable.findUniqueOrThrow({ where: { id: tableId } })).status).toBe("AVAILABLE");
    await expect(addOrderRound(captain, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, key())).rejects.toThrow(/PAID/);
    await expect(requestBill(captain, o.id)).rejects.toThrow(/PAID/);
    await expect(removeOrderItem(captain, unsent.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("kitchen status from the floor", () => {
  it("a captain can only mark READY food served", async () => {
    const o = await openTable(await table(A, "TK"));
    const kot = (await getOrder(prisma, captain, o.id)).kots[0];
    await expect(updateKOTStatus(captain, kot.id, "ACCEPTED")).rejects.toBeInstanceOf(ForbiddenError);
    await updateKOTStatus(kitchen, kot.id, "ACCEPTED");
    await updateKOTStatus(kitchen, kot.id, "PREPARING");
    await expect(updateKOTStatus(captain, kot.id, "SERVED")).rejects.toThrow(/Cannot move KOT from PREPARING to SERVED/);
    await updateKOTStatus(kitchen, kot.id, "READY");
    expect((await updateKOTStatus(captain, kot.id, "SERVED")).status).toBe("SERVED");
    await expect(updateKOTStatus(captainB, kot.id, "SERVED")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("mobile read models", () => {
  it("table board derives state from orders / KOTs / payments; scoped to the outlet", async () => {
    const tb = await table(A, "TP");
    const o = await openTable(tb, [{ menuItemId: dosa, qty: 2 }]); // 210
    await addOrderRound(captain, o.id, { items: [{ menuItemId: coffee, qty: 1 }], fire: false }, key()); // unsent
    const p = await createPayment(cashier, o.id, { method: "CASH", amount: 100, idempotencyKey: key() });
    await verifyPayment(cashier, p.id);
    const board = await tableBoard(prisma, captain, A);
    const row = board.tables.find((t) => t.id === tb)!;
    expect(row.order).toMatchObject({ id: o.id, total: 260, paid: 100, due: 160, payment: "PARTIAL", unsent: 1, items: 2, kots: { live: 1, ready: 0 } });
    expect(row.tags).toEqual(expect.arrayContaining(["occupied", "kitchen", "payment"]));
    expect(board.counts.all).toBe(board.tables.length);
    await expect(tableBoard(prisma, captainB, A)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await tableBoard(prisma, foreign, A)).tables).toEqual([]); // org-filtered (the route answers 404)
  });

  it("manager summary sections follow the role", async () => {
    const m = await managerSummary(prisma, manager, A);
    expect(m.sales).not.toBeNull();
    expect(m.ops).not.toBeNull();
    expect(m.inventory).not.toBeNull();
    expect(m.finance).not.toBeNull();
    expect(m.ops!.openOrders).toBeGreaterThan(0);
    expect(m.insights).not.toBeNull();
    const acc = await managerSummary(prisma, accountant, A);
    expect(acc.finance).not.toBeNull();
    expect(acc.sales).not.toBeNull();
    expect(acc.inventory).toBeNull(); // accountants have no stock view
    const k = await managerSummary(prisma, kitchen, A);
    expect([k.sales, k.finance]).toEqual([null, null]);
    expect(k.inventory).not.toBeNull();
    await expect(managerSummary(prisma, captainB, A)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("roles and staff administration", () => {
  it("ACCOUNTANT: books and reports, no POS, stock or refunds", () => {
    for (const p of ["finance.view", "finance.reconcile", "expense.manage", "vendor.pay", "reports.view", "export.run"] as const) expect(can(accountant, p, A)).toBe(true);
    for (const p of ["order.create", "payment.take", "payment.refund", "inventory.adjust", "staff.manage", "kot.update"] as const) expect(can(accountant, p, A)).toBe(false);
  });

  it("a manager grants staff roles at their outlet only, never at or above their own rank, never to themselves", async () => {
    const mgrId = await user("MANAGER", A, "Boss");
    const mgr = await buildAccessContext(prisma, mgrId);
    const created = await createStaff(mgr, { email: `acc-${RUN}@p6.test`, name: "New Accountant", role: "ACCOUNTANT", outletId: A });
    expect(created.setup.token).toBeTruthy(); // one-time setup link, never a password
    await expect(createStaff(mgr, { email: `m2-${RUN}@p6.test`, name: "Peer", role: "MANAGER", outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createStaff(mgr, { email: `o-${RUN}@p6.test`, name: "Owner?", role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createStaff(mgr, { email: `b-${RUN}@p6.test`, name: "Elsewhere", role: "CAPTAIN", outletId: B })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assignMembership(mgr, { userId: mgrId, role: "OWNER" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setUserActive(mgr, mgrId, false)).rejects.toThrow(/your own access/);
    await assignMembership(mgr, { userId: created.id, role: "CAPTAIN", outletId: A });
    const audit = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityId: created.id } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["CREATE", "PASSWORD_LINK"]));
  });

  it("a deactivated user cannot build a session context; reactivation restores it", async () => {
    const mgr = await buildAccessContext(prisma, await user("MANAGER", A, "Boss2"));
    const staffId = await user("CASHIER", A, "Leaver");
    await setUserActive(mgr, staffId, false);
    await expect(buildAccessContext(prisma, staffId)).rejects.toThrow(/inactive/);
    await setUserActive(mgr, staffId, true);
    expect((await buildAccessContext(prisma, staffId)).outletIds).toEqual([A]);
  });

  it("the staff list shows an outlet manager only roles at their outlets", async () => {
    const both = await user("CAPTAIN", A, "Floater");
    await prisma.membership.create({ data: { organizationId: orgId, userId: both, outletId: B, role: "CASHIER" } });
    const mgr = await buildAccessContext(prisma, await user("MANAGER", A, "Boss3"));
    const list = await listStaff(prisma, mgr, { outletId: A, take: 200 });
    const row = list.items.find((u) => u.id === both)!;
    expect(row.memberships.map((m) => m.outletId)).toEqual([A]);
  });
});

describe("notifications", () => {
  it("broadcasts are filtered by the role's permission and read per user", async () => {
    const vendor = await createNotification(sys, { outletId: A, type: "VENDOR_DUE", title: `Vendor due ${RUN}` });
    const ready = await createNotification(sys, { outletId: A, type: "ORDER_READY", title: `Ready ${RUN}` });
    const seen = async (c: AccessContext) => (await listNotifications(prisma, c, { take: 200 })).map((x) => x.id);
    expect(await seen(kitchen)).not.toContain(vendor.notification.id); // finance alert, not for the kitchen
    expect(await seen(kitchen)).toContain(ready.notification.id);
    expect(await seen(cashier)).toContain(vendor.notification.id); // cashier holds finance.view
    expect(await seen(captainB)).not.toContain(ready.notification.id); // other outlet
    await expect(markNotificationRead(kitchen, vendor.notification.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markNotificationRead(foreign, ready.notification.id)).rejects.toBeInstanceOf(NotFoundError);

    const before2 = await unreadCount(prisma, cashier2);
    await markNotificationRead(cashier, ready.notification.id);
    expect((await listNotifications(prisma, cashier)).find((x) => x.id === ready.notification.id)!.readAt).not.toBeNull();
    expect((await listNotifications(prisma, cashier2)).find((x) => x.id === ready.notification.id)!.readAt).toBeNull(); // still unread for the colleague
    expect(await unreadCount(prisma, cashier2)).toBe(before2);
    await markNotificationRead(cashier, ready.notification.id); // idempotent
    await markAllRead(cashier2);
    expect(await unreadCount(prisma, cashier2)).toBe(0);
    expect(await unreadCount(prisma, kitchen)).toBeGreaterThan(0); // untouched by others
  });

  it("a guest QR order raises NEW_ORDER; a declined payment raises PAYMENT_FAILED for cashiers", async () => {
    const qt = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: A, code: `Q-${RUN}` } });
    const token = (await rotateTableQr(sys, qt.id)).qrToken!;
    const placed = await placeGuestOrder(token, { items: [{ menuItemId: dosa, qty: 1 }] }, key());
    const forCaptain = await listNotifications(prisma, captain, { take: 200 });
    expect(forCaptain.some((x) => x.type === "NEW_ORDER" && x.title.includes(`Q-${RUN}`))).toBe(true);
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, gateway: { mockOutcome: "decline" } });
    expect((await listNotifications(prisma, cashier, { take: 200 })).some((x) => x.type === "PAYMENT_FAILED" && x.body?.includes(placed.orderId.slice(-6).toUpperCase()))).toBe(true);
    expect((await listNotifications(prisma, kitchen, { take: 200 })).some((x) => x.type === "PAYMENT_FAILED")).toBe(false);
  });
});

describe("validation", () => {
  it("a round needs at least one line and positive quantities", async () => {
    const o = await openTable(await table(A, "TV"));
    await expect(addOrderRound(captain, o.id, { items: [] }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(addOrderRound(captain, o.id, { items: [{ menuItemId: dosa, qty: 0 }] }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(addOrderRound(captain, o.id, { items: [{ menuItemId: dosa, qty: 1 }] }, "bad key!")).rejects.toBeInstanceOf(ZodError);
    await expect(removeOrderItem(captain, "nope")).rejects.toBeInstanceOf(NotFoundError);
    void ValidationError;
  });
});
