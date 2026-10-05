// @vitest-environment jsdom
/**
 * Phase 6 phone screens in a DOM: the captain's table board + filters, opening
 * a table, adding items (with a kitchen note) and sending ONE keyed request
 * whose key is reused on retry; a running order's round, marking READY food
 * served and requesting the bill; the offline banner; the manager's today /
 * live / alerts tabs (insights explained) and staff tab gated by permission;
 * the alert centre marking a notification read.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaptainApp } from "@/features/mobile/CaptainApp";
import { ManagerApp } from "@/features/mobile/ManagerApp";
import { state, installFetch, teardown, renderAs, posts, gets, fail, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/captain" }));
beforeEach(installFetch);
afterEach(teardown);

const now = new Date().toISOString();
const emptyOrder = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, outletId: OUT_A, channel: "DINE_IN", status, tableId: "t1", customerId: null, covers: 2, notes: null, subtotal: "0", discount: "0", tax: "0", total: "0", createdAt: now, items: [], payments: [], kots: [], ...extra });
const menu = [
  { id: "m1", name: "Dosa", description: null, price: 100, taxPct: 5, station: "KITCHEN", isVeg: true, active: true, soldOut: false, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [], effectivePrice: 100, offered: true, effectiveSoldOut: false },
];
const board = (tables: unknown[]) => ({ tables, counts: { all: tables.length, available: 1, occupied: tables.length - 1, kitchen: 1, ready: 0, payment: 0 } });
const freeTable = { id: "t1", code: "T1", capacity: 4, floor: null, status: "AVAILABLE", order: null, tags: ["available"] };
const busyTable = { id: "t2", code: "T2", capacity: 2, floor: null, status: "OCCUPIED", tags: ["occupied", "kitchen"], order: { id: "o2", status: "SENT", total: 210, paid: 0, due: 210, items: 2, unsent: 0, kots: { live: 1, ready: 0, served: 0, cancelled: 0 }, payment: "UNPAID", openedAt: now, elapsedMinutes: 12, openedBy: "Asha" } };

describe("captain app", () => {
  it("board + filters; a new table's first send is ONE keyed POST, and a retry reuses the key", async () => {
    let attempt = 0;
    state.routes = {
      "GET /api/mobile/tables": () => board([freeTable, busyTable]),
      "GET /api/notifications/unread-count": () => ({ unread: 2 }),
      "GET /api/menu": () => menu,
      "POST /api/orders": () => (++attempt === 1 ? fail(503, "Unavailable", "Try again") : emptyOrder("o1", "SENT")),
      "GET /api/orders/o1": () => emptyOrder("o1", "SENT", { items: [{ id: "i1", name: "Dosa", qty: "2", unitPrice: "100", lineTotal: "200", notes: "no onion", menuItemId: "m1", modifiers: [] }], total: "210", kots: [{ id: "k1", number: 7, status: "NEW", items: [{ orderItemId: "i1", status: "NEW" }] }] }),
    };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={{ create: true, modify: true, serve: true }} />, ["order.view", "order.create", "order.modify", "kot.serve"]);
    expect(await screen.findByTestId("table-T2")).toHaveTextContent("₹210.00");
    expect(screen.getByTestId("table-T2")).toHaveTextContent("12 min · Asha");
    await userEvent.click(screen.getByRole("button", { name: /^Free · 1$/ }));
    expect(screen.queryByTestId("table-T2")).toBeNull();
    expect(await screen.findByLabelText("2 unread")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("table-T1"));
    await userEvent.click(screen.getByRole("button", { name: /Add items/ }));
    const sheet = await screen.findByRole("dialog", { name: "Add items" });
    await userEvent.click(await within(sheet).findByRole("button", { name: /Dosa/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /Dosa/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Note for Dosa" })[0]);
    await userEvent.type(screen.getByLabelText("Kitchen note for Dosa"), "no onion");
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await screen.findAllByText(/Try again|server|nothing was lost/i);
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].body).toMatchObject({ outletId: OUT_A, channel: "DINE_IN", tableId: "t1", covers: 2, submit: true, items: [{ menuItemId: "m1", qty: 1, notes: "no onion" }, { menuItemId: "m1", qty: 1 }] });
    expect(posts()[0].body.items[0]).not.toHaveProperty("unitPrice"); // prices come from the server
    expect(posts()[1].headers["Idempotency-Key"]).toBe(posts()[0].headers["Idempotency-Key"]);
    expect(await screen.findByText("KOT 7")).toBeInTheDocument();
  });

  it("running order: keyed round, mark READY food served, request the bill; complete when paid", async () => {
    let status = "SENT";
    const order = () => emptyOrder("o2", status, {
      items: [{ id: "i1", name: "Dosa", qty: "2", unitPrice: "100", lineTotal: "200", notes: null, menuItemId: "m1", modifiers: [] }],
      total: "210", payments: status === "PAID" ? [{ id: "p1", method: "CASH", status: "SUCCESS", amount: "210" }] : [],
      kots: [{ id: "k1", number: 3, status: "READY", items: [{ orderItemId: "i1", status: "READY" }] }],
    });
    state.routes = {
      "GET /api/mobile/tables": () => board([freeTable, busyTable]),
      "GET /api/notifications/unread-count": () => ({ unread: 0 }),
      "GET /api/menu": () => menu,
      "GET /api/orders/o2": order,
      "POST /api/orders/o2/rounds": () => ({ round: { id: "r1", replayed: false }, order: order() }),
      "POST /api/kitchen/kots/k1/status": () => ({}),
      "POST /api/orders/o2/request-bill": () => { status = "BILLED"; return order(); },
    };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={{ create: true, modify: true, serve: true }} />, ["order.view", "order.create", "order.modify", "kot.serve"]);
    await userEvent.click(await screen.findByTestId("table-T2"));
    expect(await screen.findByText("KOT 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark served" }));
    await waitFor(() => expect(posts().at(-1)).toMatchObject({ path: "/api/kitchen/kots/k1/status", body: { status: "SERVED" } }));

    await userEvent.click(screen.getByRole("button", { name: /Add items/ }));
    const sheet = await screen.findByRole("dialog", { name: "Add items" });
    await userEvent.click(await within(sheet).findByRole("button", { name: /Dosa/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/orders/o2/rounds")).toBe(true));
    const round = posts().find((p) => p.path === "/api/orders/o2/rounds")!;
    expect(round.body).toEqual({ items: [{ menuItemId: "m1", qty: 1 }], fire: true });
    expect(round.headers["Idempotency-Key"]).toMatch(/^cap-/);

    await userEvent.click(screen.getByRole("button", { name: /Request bill/ }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/orders/o2/request-bill")).toBe(true));
    expect(await screen.findByRole("link", { name: "View bill" })).toHaveAttribute("href", "/pos/bill/o2");
    status = "PAID";
    await userEvent.click(screen.getByRole("button", { name: /All tables/ }));
    await userEvent.click(screen.getByTestId("table-T2"));
    expect(await screen.findByTestId("order-complete")).toHaveTextContent("Paid in full");
  });

  it("shows the offline state honestly", async () => {
    state.routes = { "GET /api/mobile/tables": () => board([freeTable]), "GET /api/notifications/unread-count": () => ({ unread: 0 }) };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={{ create: true, modify: true, serve: false }} />, ["order.view", "order.create", "order.modify"]);
    await screen.findByTestId("table-T1");
    act(() => { fireEvent(window, new Event("offline")); });
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline.*no duplicates/i);
    expect(screen.getByRole("status")).toHaveTextContent("Offline");
    act(() => { fireEvent(window, new Event("online")); });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Online"));
  });
});

const summary = {
  businessDate: "2026-10-05", timezone: "Asia/Kolkata", generatedAt: now,
  sales: { summary: { orders: 12, refundedOrders: 1, grossSales: 5000, discounts: 120, refunds: 105, netSales: 4780, revenue: 5100, aov: 425 }, methods: [{ method: "CASH", count: 5, collected: 2000, refunded: 105, net: 1895 }] },
  ops: { openOrders: 4, notSent: 1, billsRequested: 2, ordersWithReadyFood: 1, outstanding: 860, kitchenPending: 3, kitchenReady: 1, tables: { total: 10, available: 6, occupied: 4, billRequested: 2 } },
  inventory: { lowStock: 2, criticalStock: 1, lowItems: [{ materialId: "x", name: "Rice", quantity: 0, reorderLevel: 5, critical: true }], negativeStock: 1, unmappedSales: 0, wastageToday: 50 },
  finance: { drawerSessionsClosed: 1, drawerVariance: -40, reconciliationMismatches7d: 2, vendorDue: 1000, vendorOverdue: 1000, expensesToday: 300, expenseCount: 1, refundsToday: 105, refundCount: 1 },
  insights: { window: { from: "2026-09-28", to: "2026-10-04" }, items: [{ code: "NEGATIVE_STOCK", severity: "CRITICAL", category: "inventory", title: "1 materials below zero", detail: "The stock ledger shows negative on-hand for Salt (-1).", link: "/inventory" }] },
};

describe("manager app", () => {
  it("today / live / alerts from one summary; staff tab only with staff.manage", async () => {
    state.routes = {
      "GET /api/mobile/manager": () => summary,
      "GET /api/notifications/unread-count": () => ({ unread: 1 }),
      "GET /api/notifications": () => [{ id: "n1", type: "BILL_REQUESTED", title: "Bill requested · table T2", body: "Order #ABC · ₹210.00", readAt: null, createdAt: now }],
      "POST /api/notifications/n1/read": () => ({}),
    };
    const view = renderAs(<ManagerApp outletId={OUT_A} outletName="Andheri" perms={{ staff: false, captain: true, pos: true, kitchen: true }} />, ["reports.view", "finance.view"]);
    expect(await screen.findByText("₹4,780.00")).toBeInTheDocument();
    expect(screen.getByText("₹860.00")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Payment methods" })).toHaveTextContent("₹1,895.00");
    expect(screen.queryByRole("button", { name: /Staff/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Live/ }));
    expect(screen.getByText("Bills requested").parentElement).toHaveTextContent("2");
    await userEvent.click(screen.getByRole("button", { name: /Alerts/ }));
    expect(screen.getByTestId("insight-NEGATIVE_STOCK")).toHaveTextContent("Salt (-1)");
    expect(screen.getByRole("list", { name: "Low stock items" })).toHaveTextContent("Critical");
    expect(screen.getByText("Vendor dues").parentElement).toHaveTextContent("₹1,000.00 overdue");
    await userEvent.click(await screen.findByRole("button", { name: 'Mark "Bill requested · table T2" read' }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/notifications/n1/read")).toBe(true));
    view.unmount();
    expect(gets("/api/mobile/manager")[0].query.get("outletId")).toBe(OUT_A);
  });

  it("staff tab lists people as cards; you cannot act on yourself", async () => {
    state.routes = {
      "GET /api/mobile/manager": () => summary,
      "GET /api/notifications/unread-count": () => ({ unread: 0 }),
      "GET /api/staff/roles": () => ({ permissions: [], roles: [{ role: "CAPTAIN", rank: 20, permissions: [], grantable: true }] }),
      "GET /api/staff": () => ({ items: [
        { id: "u1", email: "a@x", name: "Asha", phone: null, active: true, lastLoginAt: null, memberships: [{ id: "m1", role: "MANAGER", outletId: OUT_A }] },
        { id: "u2", email: "c@x", name: "Chetan", phone: null, active: true, lastLoginAt: null, memberships: [{ id: "m2", role: "CAPTAIN", outletId: OUT_A }] },
      ], nextCursor: null }),
    };
    renderAs(<ManagerApp outletId={OUT_A} outletName="Andheri" perms={{ staff: true, captain: true, pos: true, kitchen: true }} />, ["reports.view", "staff.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: /Staff/ }));
    const list = await screen.findByRole("list", { name: "Staff members" });
    const me = within(list).getByText("Asha").closest("li")!;
    expect(me).toHaveTextContent("This is you");
    expect(within(me).queryByRole("button", { name: "Deactivate" })).toBeNull();
    const other = within(list).getByText("Chetan").closest("li")!;
    expect(within(other).getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(gets("/api/staff")[0].query.get("outletId")).toBe(OUT_A);
  });
});
