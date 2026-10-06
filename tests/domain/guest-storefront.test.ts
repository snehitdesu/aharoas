/**
 * Customer storefront (table QR website) — the server side added for it, on
 * the real services and database:
 *
 *  - cart quote: server pricing (outlet override, size, add-ons, GST) without
 *    creating anything; unavailable / foreign items reported per line;
 *  - placement: optional guest name / phone (CRM find-or-create, never
 *    overwriting a known customer), payment choice for the staff, every line
 *    checked BEFORE anything is created, opening hours, duplicate submits;
 *  - multiple guests at one table, wrong table / wrong restaurant;
 *  - the customer tracker driven by the real KOT / KDS transitions, and the
 *    cash path (staff accept) vs. a verified online prepayment (auto KOT).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, NotFoundError, ValidationError } from "@/server/db/scope";
import { createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup, setOutletMenuItem, setMenuItemAvailability, updateMenuItem } from "@/server/services/menu";
import { submitOrder } from "@/server/services/orders";
import { updateKOTStatus } from "@/server/services/kot";
import { createCustomer } from "@/server/services/crm";
import { rotateTableQr } from "@/server/services/masterData";
import { guestMenu, quoteGuestCart, placeGuestOrder, getGuestOrder, startGuestPayment, confirmGuestPayment, orderingStatus, normalizeGuestPhone } from "@/server/services/guestOrdering";
import { guestTracker } from "@/domain/orderProgress";
import { isOpenAt, formatHours, minutesOf } from "@/domain/openingHours";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, foreignOrgId: string;
let sys: AccessContext, kitchen: AccessContext, cashier: AccessContext;
let token: string, token2: string, foreignToken: string;
let pizza: string, fries: string, medium: string, cheese: string, veggies: string, foreignItem: string;
let seq = 0;
const key = () => `sf-${RUN}-${++seq}-abcdef`;
const role = (userId: string, org: string, outlet: string, r: string): AccessContext => ({ userId, organizationId: org, outletIds: [outlet], roles: [r], outletRoles: { [outlet]: [r] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function newTable(org: string, outlet: string, code: string) {
  const t = await prisma.restaurantTable.create({ data: { organizationId: org, outletId: outlet, code } });
  return (await rotateTableQr(systemContext(org, [outlet]), t.id)).qrToken!;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Storefront Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SF${RUN}`.slice(0, 12), name: "SF Central", address: "Plot 7, Tech Park", phone: "+91 90000 00000" } })).id;
  sys = systemContext(orgId, [outletId]);
  kitchen = role(`kit-${RUN}`, orgId, outletId, "KITCHEN");
  cashier = role(`cash-${RUN}`, orgId, outletId, "CASHIER");
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });

  pizza = (await createMenuItem(sys, { name: `Margherita ${RUN}`, price: 99, taxPct: 5, station: "KITCHEN" })).id;
  fries = (await createMenuItem(sys, { name: `Fries ${RUN}`, price: 85, taxPct: 5, station: "KITCHEN" })).id;
  medium = (await addVariant(sys, { menuItemId: pizza, name: "Medium", priceDelta: 61 })).id;
  const addOns = await createModifierGroup(sys, { name: `Pizza Add-ons ${RUN}`, minSelect: 0, maxSelect: 2 });
  veggies = (await addModifierOption(sys, { groupId: addOns.id, name: "Extra Veggies", priceDelta: 40 })).id;
  cheese = (await addModifierOption(sys, { groupId: addOns.id, name: "Cheese Melt", priceDelta: 60 })).id;
  await attachModifierGroup(sys, pizza, addOns.id);
  token = await newTable(orgId, outletId, "T07");
  token2 = await newTable(orgId, outletId, "T08");

  foreignOrgId = (await prisma.organization.create({ data: { name: `Foreign SF ${RUN}` } })).id;
  const foreignOutlet = (await prisma.outlet.create({ data: { organizationId: foreignOrgId, code: `FS${RUN}`.slice(0, 12), name: "Foreign" } })).id;
  foreignItem = (await createMenuItem(systemContext(foreignOrgId, [foreignOutlet]), { name: `Foreign dish ${RUN}`, price: 10, taxPct: 5, station: "KITCHEN" })).id;
  foreignToken = await newTable(foreignOrgId, foreignOutlet, "F1");
});

describe("guest menu (storefront data)", () => {
  it("exposes only the restaurant's own facts: name, outlet, address, phone; hours only when configured", async () => {
    const m = await guestMenu(token);
    expect(m.restaurant).toMatchObject({ name: `Storefront Org ${RUN}`, outletName: "SF Central", address: "Plot 7, Tech Park", phone: "+91 90000 00000", hours: null });
    expect(m.ordering).toEqual({ open: true, message: null });
    expect(m.table).toEqual({ code: "T07" });
    expect(JSON.stringify(m)).not.toMatch(/organizationId|outletId|qrToken|gstin|costPrice/);
  });
});

describe("cart quote", () => {
  it("prices size + add-ons + GST exactly like order placement and creates nothing", async () => {
    const ordersBefore = await prisma.order.count({ where: { organizationId: orgId } });
    const q = await quoteGuestCart(token, { items: [{ menuItemId: pizza, variantId: medium, modifierOptionIds: [cheese], qty: 1 }, { menuItemId: fries, qty: 2 }] });
    expect(q.lines).toEqual([
      expect.objectContaining({ index: 0, ok: true, name: `Margherita ${RUN} (Medium)`, unitPrice: "160.00", modifiersPerUnit: "60.00", lineTotal: "220.00" }),
      expect.objectContaining({ index: 1, ok: true, name: `Fries ${RUN}`, unitPrice: "85.00", lineTotal: "170.00" }),
    ]);
    expect(q).toMatchObject({ subtotal: "390.00", tax: "19.50", total: "409.50", allAvailable: true, taxes: [{ ratePct: "5", amount: "19.50" }] });
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(ordersBefore);
  });

  it("follows the outlet's current price and flags unavailable / foreign items per line", async () => {
    await setOutletMenuItem(sys, { outletId, menuItemId: fries, price: 95 });
    await setMenuItemAvailability(sys, pizza, { soldOut: true });
    try {
      const q = await quoteGuestCart(token, { items: [{ menuItemId: fries, qty: 1 }, { menuItemId: pizza, qty: 1 }, { menuItemId: foreignItem, qty: 1 }, { menuItemId: "does-not-exist", qty: 1 }] });
      expect(q.lines[0]).toMatchObject({ ok: true, unitPrice: "95.00" });
      expect(q.lines[1]).toMatchObject({ ok: false, reason: expect.stringMatching(/sold out/) });
      expect(q.lines[2]).toMatchObject({ ok: false, reason: "This item is no longer on the menu" }); // another restaurant's item: no oracle
      expect(q.lines[3]).toMatchObject({ ok: false, reason: "This item is no longer on the menu" });
      expect(q).toMatchObject({ allAvailable: false, subtotal: "95.00", total: "99.75" });
    } finally {
      await setMenuItemAvailability(sys, pizza, { soldOut: false });
      await setOutletMenuItem(sys, { outletId, menuItemId: fries, price: null });
    }
  });

  it("refuses client prices and invalid tokens", async () => {
    await expect(quoteGuestCart(token, { items: [{ menuItemId: fries, qty: 1, unitPrice: 1 }] })).rejects.toBeInstanceOf(ZodError);
    await expect(quoteGuestCart(token, { items: [{ menuItemId: fries, qty: 1 }], total: 1 })).rejects.toBeInstanceOf(ZodError);
    await expect(quoteGuestCart("not-a-real-token-123", { items: [{ menuItemId: fries, qty: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("placing a storefront order", () => {
  it("cash: name + phone link the CRM customer (existing names never overwritten); staff see name and payment choice; no KOT until accepted", async () => {
    const existing = await createCustomer(sys, { name: "Known Regular", phone: "9876500001" });
    const placed = await placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }], customer: { name: "Someone Else", phone: "+91 98765-00001" }, paymentMethod: "CASH" }, key());
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId }, include: { kots: true, customer: true } });
    expect(order).toMatchObject({ status: "OPEN", source: "QR", channel: "QR", customerId: existing.id });
    expect(order.customer!.name).toBe("Known Regular");
    expect(order.kots).toHaveLength(0);
    const note = await prisma.notification.findFirst({ where: { organizationId: orgId, body: { contains: placed.ref } } });
    expect(note!.body).toMatch(/waiting to be accepted · Someone Else · pays at the counter$/);
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Order", entityId: placed.orderId, action: "CREATE", after: { contains: "guest-qr" } } });
    expect(audit!.after).toMatch(/"paymentMethod":"CASH"/);

    // A new phone creates the customer; a name without a phone creates nothing in the CRM.
    const fresh = await placeGuestOrder(token2, { items: [{ menuItemId: fries, qty: 1 }], customer: { name: "Ananya", phone: "9123456780" } }, key());
    expect((await prisma.order.findUniqueOrThrow({ where: { id: fresh.orderId }, include: { customer: true } })).customer).toMatchObject({ name: "Ananya", phone: "9123456780" });
    const customersBefore = await prisma.customer.count({ where: { organizationId: orgId } });
    const anon = await placeGuestOrder(token2, { items: [{ menuItemId: fries, qty: 1 }], customer: { name: "Ravi" } }, key());
    expect((await prisma.order.findUniqueOrThrow({ where: { id: anon.orderId } })).customerId).toBeNull();
    expect(await prisma.customer.count({ where: { organizationId: orgId } })).toBe(customersBefore);
    await prisma.order.updateMany({ where: { id: { in: [placed.orderId, fresh.orderId, anon.orderId] } }, data: { status: "CANCELLED" } });
  });

  it("rejects a bad phone and unknown fields; an unavailable line is refused BEFORE any order or customer exists", async () => {
    await expect(placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }], customer: { phone: "12ab" } }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }], customer: { name: "x", email: "a@b.c" } }, key())).rejects.toBeInstanceOf(ZodError);
    await expect(placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }], paymentMethod: "CARD" }, key())).rejects.toBeInstanceOf(ZodError);
    await setMenuItemAvailability(sys, pizza, { soldOut: true });
    const orders = await prisma.order.count({ where: { organizationId: orgId } });
    const customers = await prisma.customer.count({ where: { organizationId: orgId } });
    try {
      await expect(placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }, { menuItemId: pizza, qty: 1 }], customer: { name: "Late", phone: "9000000077" } }, key())).rejects.toThrow(/Item 2: .*sold out/);
    } finally {
      await setMenuItemAvailability(sys, pizza, { soldOut: false });
    }
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(orders);
    expect(await prisma.customer.count({ where: { organizationId: orgId } })).toBe(customers);
    expect(normalizeGuestPhone("+91 98765 43210")).toBe("9876543210");
    expect(normalizeGuestPhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("duplicate submit (double tap / refresh) with the same key = one order, one notification", async () => {
    const k = key();
    const body = { items: [{ menuItemId: fries, qty: 2 }], customer: { name: "Twice", phone: "9000000088" }, paymentMethod: "CASH" };
    const [a, b] = await Promise.all([placeGuestOrder(token, body, k), placeGuestOrder(token, body, k)]);
    const c = await placeGuestOrder(token, body, k);
    expect(new Set([a.orderId, b.orderId, c.orderId]).size).toBe(1);
    expect(await prisma.order.count({ where: { organizationId: orgId, idempotencyKey: { endsWith: k } } })).toBe(1);
    expect(await prisma.notification.count({ where: { organizationId: orgId, body: { contains: a.ref } } })).toBe(1);
    await prisma.order.update({ where: { id: a.orderId }, data: { status: "CANCELLED" } });
  });

  it("multiple guests at one table get separate orders and can only read their own; wrong restaurant's item is refused", async () => {
    const g1 = await placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }] }, key());
    const g2 = await placeGuestOrder(token, { items: [{ menuItemId: pizza, variantId: medium, modifierOptionIds: [veggies], qty: 1 }] }, key());
    expect(g1.orderId).not.toBe(g2.orderId);
    expect((await getGuestOrder(g1.orderId, g1.accessKey)).bill.lines.map((l) => l.name)).toEqual([`Fries ${RUN}`]);
    expect((await getGuestOrder(g2.orderId, g2.accessKey)).bill.total).toBe("210.00"); // (160 + 40) × 1.05
    await expect(getGuestOrder(g2.orderId, g1.accessKey)).rejects.toBeInstanceOf(NotFoundError);
    await expect(placeGuestOrder(foreignToken, { items: [{ menuItemId: fries, qty: 1 }] }, key())).rejects.toBeInstanceOf(NotFoundError);
    await prisma.order.updateMany({ where: { id: { in: [g1.orderId, g2.orderId] } }, data: { status: "CANCELLED" } });
  });

  it("refuses orders outside the outlet's opening hours (browsing still works)", async () => {
    const now = new Date();
    const hh = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    // A one-minute window that has already passed today (or wraps): closed now.
    const open = hh(new Date(now.getTime() + 2 * 3600_000));
    const close = hh(new Date(now.getTime() + 3 * 3600_000));
    await prisma.outlet.update({ where: { id: outletId }, data: { openTime: open, closeTime: close } });
    try {
      const menu = await guestMenu(token);
      expect(menu.ordering.open).toBe(false);
      expect(menu.restaurant.hours).toMatchObject({ open, close });
      await expect(placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }] }, key())).rejects.toThrow(/closed right now/);
      await expect(quoteGuestCart(token, { items: [{ menuItemId: fries, qty: 1 }] })).resolves.toMatchObject({ ordering: { open: false } });
    } finally {
      await prisma.outlet.update({ where: { id: outletId }, data: { openTime: null, closeTime: null } });
    }
  });
});

describe("customer tracker from the real KOT / KDS flow", () => {
  it("cash: received (waiting) → staff accept → kitchen accepted → preparing → ready → served", async () => {
    const g = await placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }], paymentMethod: "CASH" }, key());
    const step = async () => (await getGuestOrder(g.orderId, g.accessKey)).tracker;
    expect(await step()).toEqual({ step: 0, confirmed: false });
    await submitOrder(cashier, g.orderId); // the existing cash workflow: staff accept at the POS → KOT
    expect(await step()).toEqual({ step: 0, confirmed: true });
    const kot = await prisma.kot.findFirstOrThrow({ where: { orderId: g.orderId } });
    await updateKOTStatus(kitchen, kot.id, "ACCEPTED");
    expect(await step()).toEqual({ step: 1, confirmed: true });
    await updateKOTStatus(kitchen, kot.id, "PREPARING");
    expect(await step()).toEqual({ step: 2, confirmed: true });
    await updateKOTStatus(kitchen, kot.id, "READY");
    expect(await step()).toEqual({ step: 3, confirmed: true });
    await updateKOTStatus(kitchen, kot.id, "SERVED");
    expect(await step()).toEqual({ step: 4, confirmed: true });
    expect(await prisma.kot.count({ where: { orderId: g.orderId } })).toBe(1);
  });

  it("online: nothing reaches the kitchen until the server verifies the payment; then exactly one KOT", async () => {
    const g = await placeGuestOrder(token2, { items: [{ menuItemId: fries, qty: 1 }], paymentMethod: "ONLINE" }, key());
    expect(await prisma.kot.count({ where: { orderId: g.orderId } })).toBe(0);
    const started = await startGuestPayment(g.orderId, g.accessKey, key());
    // A browser claiming success without the gateway's confirmation does not pay anything (mock decline = gateway says no).
    const declined = await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: started.paymentId, gateway: { mockOutcome: "decline" } });
    expect(declined.paymentStatus).toBe("FAILED");
    expect(await prisma.kot.count({ where: { orderId: g.orderId } })).toBe(0);
    const again = await startGuestPayment(g.orderId, g.accessKey, key());
    const ok = await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: again.paymentId });
    expect(ok.paymentStatus).toBe("SUCCESS");
    expect(ok.tracker).toEqual({ step: 0, confirmed: true });
    await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: again.paymentId }); // replayed confirmation
    expect(await prisma.kot.count({ where: { orderId: g.orderId } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: g.orderId } })).status).toBe("PAID");
  });

  it("orderingStatus / guestTracker / opening hours units", () => {
    const outlet = { openTime: "09:00", closeTime: "23:30", timezone: "Asia/Kolkata" };
    const at = (iso: string) => new Date(iso);
    expect(isOpenAt(outlet, at("2026-10-06T03:30:00Z"))).toBe(true); // 09:00 IST
    expect(isOpenAt(outlet, at("2026-10-06T03:29:00Z"))).toBe(false); // 08:59 IST
    expect(isOpenAt(outlet, at("2026-10-06T18:00:00Z"))).toBe(false); // 23:30 IST
    const overnight = { openTime: "18:00", closeTime: "02:00", timezone: "Asia/Kolkata" };
    expect(isOpenAt(overnight, at("2026-10-06T19:30:00Z"))).toBe(true); // 01:00 IST
    expect(isOpenAt(overnight, at("2026-10-06T06:30:00Z"))).toBe(false); // 12:00 IST
    expect(isOpenAt({ openTime: null, closeTime: "10:00", timezone: "Asia/Kolkata" })).toBe(true);
    expect(formatHours(outlet)).toBe("9:00 AM – 11:30 PM");
    expect(formatHours({ openTime: "00:00", closeTime: "00:00" })).toBe("Open 24 hours");
    expect(minutesOf("24:00")).toBeNull();
    expect(orderingStatus({ outlet: { ...outlet, id: "o", organizationId: "x", name: "n", address: null, phone: null, currency: "INR" } }, at("2026-10-06T02:00:00Z"))).toEqual({ open: false, message: "We're closed right now — ordering opens at 9:00 AM. You can still browse the menu." });

    const k = (...s: string[]) => ({ status: "SENT", kots: s.map((status) => ({ status })) });
    expect(guestTracker({ status: "OPEN", kots: [] })).toEqual({ step: 0, confirmed: false });
    expect(guestTracker(k("NEW"))).toEqual({ step: 0, confirmed: true });
    expect(guestTracker(k("ACCEPTED", "NEW"))).toEqual({ step: 1, confirmed: true });
    expect(guestTracker(k("PREPARING", "ACCEPTED"))).toEqual({ step: 2, confirmed: true });
    expect(guestTracker(k("READY", "NEW"))).toEqual({ step: 2, confirmed: true }); // one station still to go
    expect(guestTracker(k("READY", "SERVED"))).toEqual({ step: 3, confirmed: true });
    expect(guestTracker({ status: "PAID", kots: [{ status: "SERVED" }, { status: "CANCELLED" }] })).toEqual({ step: 4, confirmed: true });
    expect(guestTracker({ status: "CANCELLED", kots: [{ status: "NEW" }] })).toEqual({ step: -1, confirmed: false });
  });
});

describe("price change between quote and order", () => {
  it("the order uses the price at placement time, never the browser's", async () => {
    const q = await quoteGuestCart(token, { items: [{ menuItemId: fries, qty: 1 }] });
    expect(q.total).toBe("89.25");
    await updateMenuItem(sys, fries, { price: 90 });
    try {
      const g = await placeGuestOrder(token, { items: [{ menuItemId: fries, qty: 1 }] }, key());
      expect((await getGuestOrder(g.orderId, g.accessKey)).bill.total).toBe("94.50");
      await prisma.order.update({ where: { id: g.orderId }, data: { status: "CANCELLED" } });
    } finally {
      await updateMenuItem(sys, fries, { price: 85 });
    }
  });

  it("a disabled (revoked) table QR stops ordering and quoting with the same message as an unknown one", async () => {
    const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `X${RUN}`.slice(0, 10) } });
    const tok = (await rotateTableQr(sys, t.id)).qrToken!;
    await prisma.restaurantTable.update({ where: { id: t.id }, data: { qrToken: null } });
    const a = await quoteGuestCart(tok, { items: [{ menuItemId: fries, qty: 1 }] }).catch((e) => e);
    const b = await quoteGuestCart("unknown-token-zzzz", { items: [{ menuItemId: fries, qty: 1 }] }).catch((e) => e);
    expect(a).toBeInstanceOf(NotFoundError);
    expect(a.message).toBe(b.message);
    expect(ValidationError).toBeDefined();
  });
});
