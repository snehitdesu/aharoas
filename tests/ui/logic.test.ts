/**
 * Pure frontend logic: cart, modifiers, estimate parity with the server,
 * submit guard, payment math, KDS lifecycle, navigation, formatting.
 */
import { describe, it, expect } from "vitest";
import { cartReducer, emptyCart, cartBlocker, toOrderItems, cartFingerprint, lineKey, type CartLine } from "@/features/pos/cart";
import { toggleOption, validateSelection, summarizeSelection, needsConfiguration, activeGroups, groupRule } from "@/features/pos/modifiers";
import { estimateTotals } from "@/features/pos/estimate";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import { planPayment, amountDue } from "@/features/pos/paymentMath";
import { groupTickets, primaryAction, canCancel, urgency, ticketLabel, type KdsTicket } from "@/features/kitchen/kds";
import { visibleNav, navFor, NAV_ITEMS } from "@/lib/nav";
import { permissionsForRoles } from "@/server/auth/rbac";
import { calculateOrderTotals } from "@/server/services/orders";
import { formatElapsed, formatQty, shortRef } from "@/lib/format";
import type { MenuItemDTO, ModifierGroupDTO } from "@/features/pos/types";

const line = (over: Partial<Omit<CartLine, "key">> = {}): Omit<CartLine, "key"> => ({ menuItemId: "m1", name: "Dosa", modifierOptionIds: [], modifierLabels: [], unitPrice: 100, modifiersPerUnit: 0, taxPct: 5, qty: 1, ...over });

describe("cart", () => {
  it("merges identical configurations and keeps different ones apart", () => {
    let s = cartReducer(emptyCart(), { type: "add", line: line() });
    s = cartReducer(s, { type: "add", line: line({ qty: 2 }) });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].qty).toBe(3);
    s = cartReducer(s, { type: "add", line: line({ modifierOptionIds: ["b", "a"] }) });
    s = cartReducer(s, { type: "add", line: line({ modifierOptionIds: ["a", "b"] }) }); // order-insensitive
    expect(s.lines).toHaveLength(2);
    expect(s.lines[1].qty).toBe(2);
    expect(lineKey({ menuItemId: "m1", modifierOptionIds: [], notes: " less oil " })).toBe(lineKey({ menuItemId: "m1", modifierOptionIds: [], notes: "less oil" }));
  });

  it("quantity changes: inc, dec to removal, setQty bounds, remove", () => {
    let s = cartReducer(emptyCart(), { type: "add", line: line() });
    const key = s.lines[0].key;
    s = cartReducer(s, { type: "inc", key });
    expect(s.lines[0].qty).toBe(2);
    s = cartReducer(s, { type: "dec", key });
    s = cartReducer(s, { type: "dec", key });
    expect(s.lines).toHaveLength(0);
    s = cartReducer(s, { type: "add", line: line() });
    s = cartReducer(s, { type: "setQty", key, qty: 5000 });
    expect(s.lines[0].qty).toBe(999);
    s = cartReducer(s, { type: "setQty", key, qty: Number.NaN });
    expect(s.lines[0].qty).toBe(999);
    s = cartReducer(s, { type: "setQty", key, qty: 0 });
    expect(s.lines).toHaveLength(0);
  });

  it("a line note changes identity and merges into an identical noted line", () => {
    let s = cartReducer(emptyCart(), { type: "add", line: line({ notes: "no onion" }) });
    s = cartReducer(s, { type: "add", line: line() });
    s = cartReducer(s, { type: "setLineNote", key: s.lines[1].key, notes: "no onion" });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].qty).toBe(2);
  });

  it("order type, blockers and the API payload", () => {
    let s = cartReducer(emptyCart("DINE_IN"), { type: "setTable", tableId: "t1" });
    expect(cartBlocker(s)).toBe("Add at least one item");
    s = cartReducer(s, { type: "add", line: line({ variantId: "v1", modifierOptionIds: ["o1"], notes: "hot" }) });
    expect(cartBlocker(s)).toBeNull();
    expect(toOrderItems(s)).toEqual([{ menuItemId: "m1", variantId: "v1", modifierOptionIds: ["o1"], qty: 1, notes: "hot" }]);
    const fp = cartFingerprint(s);
    s = cartReducer(s, { type: "setOrderType", orderType: "TAKEAWAY" });
    expect(s.tableId).toBeNull(); // table only for dine-in
    expect(cartFingerprint(s)).not.toBe(fp);
    s = cartReducer(s, { type: "setOrderType", orderType: "DELIVERY" });
    expect(cartBlocker(s)).toBe("Attach a customer for delivery");
    expect(cartReducer(s, { type: "clear" }).orderType).toBe("DELIVERY");
  });
});

const group = (over: Partial<ModifierGroupDTO> = {}): ModifierGroupDTO => ({
  id: "g1", name: "Crust", minSelect: 1, maxSelect: 1, active: true,
  options: [{ id: "o1", name: "Thin", priceDelta: "0", active: true }, { id: "o2", name: "Stuffed", priceDelta: "60", active: true }, { id: "o3", name: "Gone", priceDelta: "5", active: false }],
  ...over,
});

describe("modifiers", () => {
  it("single-choice groups act as radios; multi-choice stops at max", () => {
    const radio = group();
    let sel = toggleOption({}, radio, "o1");
    sel = toggleOption(sel, radio, "o2");
    expect(sel.g1).toEqual(["o2"]);
    const multi = group({ id: "g2", minSelect: 0, maxSelect: 2 });
    let m = toggleOption({}, multi, "o1");
    m = toggleOption(m, multi, "o2");
    m = toggleOption(m, multi, "o3");
    expect(m.g2).toEqual(["o1", "o2"]);
    expect(toggleOption(m, multi, "o1").g2).toEqual(["o2"]);
  });

  it("validates min/max and summarizes price and labels over active options only", () => {
    const item = { variants: [], modifierGroups: [{ group: group() }, { group: group({ id: "gx", active: false }) }] } as unknown as MenuItemDTO;
    const groups = activeGroups(item);
    expect(groups).toHaveLength(1);
    expect(groups[0].options.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(validateSelection(groups, {})).toEqual({ valid: false, errors: { g1: "Choose at least 1" } });
    expect(validateSelection(groups, { g1: ["o2"] }).valid).toBe(true);
    expect(summarizeSelection(groups, { g1: ["o2"] })).toEqual({ ids: ["o2"], labels: ["Crust: Stuffed"], perUnit: 60 });
    expect(needsConfiguration(item)).toBe(true);
    expect(needsConfiguration({ variants: [], modifierGroups: [] })).toBe(false);
    expect(groupRule({ minSelect: 0, maxSelect: 3 })).toBe("Optional · up to 3");
    expect(groupRule({ minSelect: 1, maxSelect: 2 })).toBe("Required · choose 1–2");
  });
});

describe("cart estimate matches the server's order totals", () => {
  it.each([
    [[{ qty: 3, unitPrice: 240, modifiersPerUnit: 0, taxPct: 5 }], 0],
    [[{ qty: 2, unitPrice: 500, modifiersPerUnit: 90, taxPct: 5 }, { qty: 1, unitPrice: 49.99, modifiersPerUnit: 0, taxPct: 18 }], 20],
    [[{ qty: 7, unitPrice: 33.33, modifiersPerUnit: 1.11, taxPct: 12 }], 0],
  ])("case %#", (lines, discount) => {
    const est = estimateTotals(lines, discount);
    const server = calculateOrderTotals(lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, modifiersPerUnit: l.modifiersPerUnit, taxPct: l.taxPct })), discount);
    expect(est).toEqual({ subtotal: Number(server.subtotal), tax: Number(server.tax), discount: Number(server.discount), total: Number(server.total) });
  });
});

describe("submit guard", () => {
  it("ignores double submits, reuses the key on retry, and rotates it after success or change", async () => {
    let n = 0;
    const guard = createSubmitGuard(() => `key-${++n}`);
    let release!: (v: string) => void;
    const first = guard.run("fp1", () => new Promise<string>((r) => (release = r)));
    expect(guard.busy).toBe(true);
    expect(await guard.run("fp1", async () => "second")).toEqual({ status: "busy" });
    release("done");
    expect(await first).toEqual({ status: "ok", value: "done" });

    const keys: string[] = [];
    const failing = await guard.run("fp2", async (k) => { keys.push(k); throw new Error("network"); });
    expect(failing.status).toBe("error");
    await guard.run("fp2", async (k) => { keys.push(k); return 1; });
    expect(keys[0]).toBe(keys[1]); // retry of the same request = same Idempotency-Key
    await guard.run("fp2", async (k) => { keys.push(k); return 1; });
    expect(keys[2]).not.toBe(keys[1]); // new key after a confirmed success
    await guard.run("fp3", async (k) => { keys.push(k); throw new Error("x"); });
    await guard.run("fp4", async (k) => { keys.push(k); return 1; });
    expect(keys[4]).not.toBe(keys[3]); // changed cart = new key
  });
});

describe("payment math", () => {
  it("cash returns change; card/UPI cannot exceed the balance; bad input rejected", () => {
    expect(planPayment({ due: 756, method: "CASH", tendered: 1000 })).toEqual({ amount: 756, change: 244, error: null });
    expect(planPayment({ due: 756, method: "CASH", tendered: 500 })).toEqual({ amount: 500, change: 0, error: null });
    expect(planPayment({ due: 756, method: "CARD", tendered: 800 }).error).toBe("Amount exceeds the balance due");
    expect(planPayment({ due: 756, method: "UPI", tendered: 0 }).error).toBe("Enter an amount greater than zero");
    expect(planPayment({ due: 0, method: "CASH", tendered: 10 }).error).toBe("Nothing is due on this order");
    expect(amountDue(756, [{ status: "SUCCESS", amount: "500" }, { status: "FAILED", amount: "256" }, { status: "PENDING", amount: "1" }])).toBe(256);
  });
});

const ticket = (over: Partial<KdsTicket>): KdsTicket => ({
  id: "k", number: 1, status: "NEW", createdAt: "2026-01-01T10:00:00.000Z", orderId: "cmabcdef123456", station: null,
  order: { id: "o", channel: "DINE_IN", source: "POS", covers: 2, notes: null, createdAt: "2026-01-01T10:00:00.000Z", table: { code: "T6" } },
  items: [], ...over,
});

describe("KDS lifecycle", () => {
  it("groups live tickets into columns, oldest first, and drops finished ones", () => {
    const g = groupTickets([
      ticket({ id: "a", status: "PREPARING", createdAt: "2026-01-01T10:05:00Z" }),
      ticket({ id: "b", status: "ACCEPTED", createdAt: "2026-01-01T10:01:00Z" }),
      ticket({ id: "c", status: "READY" }),
      ticket({ id: "d", status: "SERVED" }),
      ticket({ id: "e", status: "NEW" }),
    ]);
    expect(g.progress.map((t) => t.id)).toEqual(["b", "a"]);
    expect([g.new.length, g.ready.length]).toEqual([1, 1]);
  });

  it("actions follow the backend transitions", () => {
    expect(primaryAction("NEW")).toEqual({ to: "ACCEPTED", label: "Accept" });
    expect(primaryAction("PREPARING")).toEqual({ to: "READY", label: "Ready" });
    expect(primaryAction("READY")).toEqual({ to: "SERVED", label: "Served" });
    expect(primaryAction("SERVED")).toBeNull();
    expect(canCancel("PREPARING")).toBe(true);
    expect(canCancel("READY")).toBe(false);
    const t0 = Date.parse("2026-01-01T10:00:00Z");
    expect(urgency("2026-01-01T10:00:00Z", t0 + 9 * 60000)).toBe("normal");
    expect(urgency("2026-01-01T10:00:00Z", t0 + 12 * 60000)).toBe("warn");
    expect(urgency("2026-01-01T10:00:00Z", t0 + 25 * 60000)).toBe("late");
    expect(ticketLabel(ticket({}))).toBe("Table T6");
    expect(ticketLabel(ticket({ order: { ...ticket({}).order!, channel: "TAKEAWAY", table: null } }))).toBe("Takeaway");
  });
});

describe("permission-aware navigation", () => {
  it("shows only surfaces the role can use", () => {
    const labels = (roles: string[]) => visibleNav(permissionsForRoles(roles)).map((n) => n.label);
    const stock = ["Stock", "Ledger", "Transfers", "Issues", "Stock counts", "Wastage", "Production"];
    const purchasing = ["Indents", "Purchase orders", "Goods receipts", "Purchase bills"];
    const everyone = ["Dashboard", "Attendance", "Leave", "Notifications"]; // self-service surfaces
    for (const r of ["CASHIER", "KITCHEN", "MANAGER", "STORE", "CAPTAIN"]) expect(labels([r])).toEqual(expect.arrayContaining(everyone));

    // RBAC gives CASHIER finance.view + customer.*, not inventory or staff management.
    expect(labels(["CASHIER"])).toEqual(expect.arrayContaining(["POS", "Customers", "Payments & refunds", "Vendor payments"]));
    for (const l of ["Kitchen", ...stock, "Staff", "Anomalies", "Audit log"]) expect(labels(["CASHIER"])).not.toContain(l);

    expect(labels(["KITCHEN"])).toEqual(expect.arrayContaining(["Kitchen", ...stock, "Tasks"]));
    for (const l of ["POS", "Customers", "Finance overview", ...purchasing]) expect(labels(["KITCHEN"])).not.toContain(l);

    expect(labels(["STORE"])).toEqual(expect.arrayContaining([...stock, ...purchasing]));
    expect(labels(["STORE"])).not.toContain("Vendor payments"); // no finance.view

    expect(labels(["MANAGER"])).toEqual(expect.arrayContaining(["POS", "Reservations", ...stock, ...purchasing, "Staff", "Finance overview", "Reconciliation", "Exports", "Anomalies"]));
    expect(labels(["MANAGER"])).not.toContain("Audit log"); // no audit.view
    expect(labels(["OWNER"])).toContain("Audit log");
  });

  it("never links to planned (unbuilt) surfaces, even for full-access roles", () => {
    const all = visibleNav(permissionsForRoles(["OWNER"]));
    expect(all.some((n) => n.planned)).toBe(false);
    expect(NAV_ITEMS.filter((n) => n.planned).every((n) => !all.includes(n))).toBe(true);
  });

  it("resolves detail paths to the owning surface (route gating uses the same rule)", () => {
    expect(navFor("/inventory/transfers/abc")?.href).toBe("/inventory/transfers");
    expect(navFor("/inventory/stock/m1")?.href).toBe("/inventory");
    expect(navFor("/procurement/payments")?.permission).toBe("finance.view");
  });
});

describe("formatting", () => {
  it("elapsed, quantities and references", () => {
    const t = Date.parse("2026-01-01T10:00:00Z");
    expect(formatElapsed("2026-01-01T10:00:00Z", t + 4 * 60000)).toBe("4m");
    expect(formatElapsed("2026-01-01T10:00:00Z", t + 65 * 60000)).toBe("1h 05m");
    expect(formatQty("2.500")).toBe("2.5");
    expect(formatQty(3)).toBe("3");
    expect(shortRef("cmabcdef123456")).toBe("123456");
  });
});
