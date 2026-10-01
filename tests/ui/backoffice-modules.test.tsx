// @vitest-environment jsdom
/**
 * Back-office modules beyond inventory/procurement: CRM + loyalty,
 * reservations/waitlist, staff, finance, reports/exports, anomalies/
 * notifications and admin. Same contract as backoffice.test.tsx: data only from
 * the API, filters/paging server-side, actions offered per status table AND
 * permission, one API call per action, server errors surfaced.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { state, installFetch, teardown, renderAs, OUT_A, ME, posts, gets, setValue, fail } from "./harness";
import { CustomersScreen, CustomerDetail } from "@/features/backoffice/crm";
import { ReservationsScreen } from "@/features/backoffice/reservations";
import { TeamScreen, LeaveScreen, TasksScreen } from "@/features/backoffice/staff";
import { PaymentsScreen, FinanceOverviewScreen, ExpensesScreen, DrawerScreen } from "@/features/backoffice/finance";
import { ReportsScreen, renderCell } from "@/features/backoffice/reports";
import { AnomaliesScreen, anomalyEntityHref } from "@/features/backoffice/alerts";
import { AuditScreen, OrganizationScreen, OutletsScreen } from "@/features/backoffice/admin";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

beforeEach(() => {
  router.push.mockReset();
  installFetch();
});
afterEach(teardown);

const at = "2026-09-30T10:00:00Z";

// ============================================================
describe("CRM", () => {
  const cust = (i: number) => ({ id: `c${i}`, name: `Guest ${i}`, phone: `90000000${i}`, email: null, birthday: null, notes: null, createdAt: at });

  it("searches on the server and pages a bare-array endpoint by the last id", async () => {
    state.routes = { "GET /api/customers": (c) => (c.query.get("cursor") ? [cust(99)] : Array.from({ length: 25 }, (_, i) => cust(i))) };
    renderAs(<CustomersScreen />, ["customer.view"]);
    await screen.findByText("Guest 0");
    expect(screen.queryByRole("button", { name: /New customer/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "Meera");
    await waitFor(() => expect(gets("/api/customers").some((c) => c.query.get("search") === "Meera")).toBe(true));
    await userEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await screen.findByText("Guest 99");
    expect(gets("/api/customers").at(-1)!.query.get("cursor")).toBe("c24");
  });

  it("shows server stats and loyalty; loyalty changes need loyalty.manage and go to the loyalty service", async () => {
    state.routes = {
      "GET /api/customers/c1": () => cust(1),
      "GET /api/customers/c1/stats": () => ({ customerId: "c1", orders: 3, totalSpend: 1500, avgOrderValue: 500, firstOrderAt: at, lastOrderAt: at, loyaltyPoints: 40 }),
      "GET /api/customers/c1/orders": () => ({ items: [], nextCursor: null }),
      "GET /api/loyalty/customers/c1": () => ({ balance: 40, history: { items: [{ id: "l1", type: "EARN", points: 40, orderId: "o1", note: null, createdAt: at }], nextCursor: null } }),
      "POST /api/loyalty/adjust": () => ({}),
    };
    const { unmount } = renderAs(<CustomerDetail id="c1" />, ["customer.view"]);
    expect(await screen.findByText("₹1,500.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Loyalty" }));
    await screen.findByText("+40");
    expect(screen.queryByRole("button", { name: "Adjust" })).not.toBeInTheDocument();
    unmount();

    renderAs(<CustomerDetail id="c1" />, ["customer.view", "loyalty.manage"]);
    await screen.findByText("₹1,500.00");
    await userEvent.click(screen.getByRole("tab", { name: "Loyalty" }));
    await userEvent.click(await screen.findByRole("button", { name: "Adjust" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Points/), "-10");
    await userEvent.type(within(dialog).getByLabelText(/Note/), "Goodwill correction");
    await userEvent.click(within(dialog).getByRole("button", { name: "Adjust points" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/loyalty/adjust", body: { customerId: "c1", points: -10, note: "Goodwill correction" } });
  });
});

// ============================================================
describe("reservations", () => {
  const res = (status: string, over = {}) => ({ id: "r1", customerId: "c1", customer: { name: "Meera", phone: "900" }, tableId: null, partySize: 4, reservedAt: at, status, notes: null, ...over });
  const tables = [{ id: "t2", code: "T2", capacity: 2, status: "AVAILABLE", floor: null }, { id: "t6", code: "T6", capacity: 6, status: "AVAILABLE", floor: { name: "Main" } }];

  it("lists today's bookings with guest names and offers actions from the transition table", async () => {
    state.routes = { "GET /api/reservations": () => ({ items: [res("BOOKED")], nextCursor: null }), "GET /api/master/tables": () => tables, "POST /api/reservations/r1/seat": () => ({}) };
    renderAs(<ReservationsScreen />, ["reservation.manage"]);
    const table = await screen.findByRole("table", { name: "Reservations" });
    await within(table).findByText("Meera");
    const q = gets("/api/reservations")[0].query;
    expect(q.get("outletId")).toBe(OUT_A);
    expect(q.get("from")).toBeTruthy(); // defaults to today
    for (const name of ["Confirm", "Seat", "Assign table", "No-show", "Cancel"]) expect(within(table).getByRole("button", { name })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();

    await userEvent.click(within(table).getByRole("button", { name: "Seat" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: /T2 .*too small/ })).toBeDisabled());
    await userEvent.selectOptions(within(dialog).getByRole("combobox"), "t6");
    await userEvent.click(within(dialog).getByRole("button", { name: "Seat" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/reservations/r1/seat", body: { tableId: "t6" } });
  });

  it("a seated party can only be completed", async () => {
    state.routes = { "GET /api/reservations": () => ({ items: [res("SEATED", { tableId: "t6" })], nextCursor: null }), "GET /api/master/tables": () => tables };
    renderAs(<ReservationsScreen />, ["reservation.manage"]);
    const table = await screen.findByRole("table", { name: "Reservations" });
    await within(table).findByText("T6");
    expect(within(table).getByRole("button", { name: "Complete" })).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /Seat|Cancel|Confirm/ })).not.toBeInTheDocument();
  });

  it("waitlist: seat promotes the entry to a table", async () => {
    state.routes = {
      "GET /api/reservations": () => ({ items: [], nextCursor: null }), "GET /api/master/tables": () => tables,
      "GET /api/reservations/waitlist": () => [{ id: "w1", customerName: "Rao", phone: null, partySize: 2, status: "WAITING", estWaitMins: 15, createdAt: new Date().toISOString() }],
      "POST /api/reservations/waitlist/w1/promote": () => ({}),
    };
    renderAs(<ReservationsScreen />, ["reservation.manage"]);
    await userEvent.click(await screen.findByRole("tab", { name: "Waitlist" }));
    const table = await screen.findByRole("table", { name: "Waitlist" });
    await userEvent.click(await within(table).findByRole("button", { name: "Seat" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("option").length).toBeGreaterThan(1));
    await userEvent.selectOptions(within(dialog).getByRole("combobox"), "t2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Seat" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/reservations/waitlist/w1/promote", body: { tableId: "t2" } });
  });
});

// ============================================================
describe("staff", () => {
  const roles = { permissions: [], roles: [{ role: "OWNER", rank: 100, permissions: [], grantable: false }, { role: "MANAGER", rank: 60, permissions: [], grantable: true }, { role: "CASHIER", rank: 20, permissions: [], grantable: true }] };

  it("team: only grantable roles are offered; you cannot act on yourself; revoke is one DELETE", async () => {
    state.routes = {
      "GET /api/staff/roles": () => roles,
      "GET /api/staff": () => ({ items: [{ id: ME, email: "a@x", name: "Asha", phone: null, active: true, lastLoginAt: null, memberships: [] }, { id: "u2", email: "b@x", name: "Bala", phone: null, active: true, lastLoginAt: null, memberships: [{ id: "m1", role: "CASHIER", outletId: OUT_A }] }], nextCursor: null }),
      "DELETE /api/staff/memberships/m1": () => ({}),
    };
    renderAs(<TeamScreen />, ["staff.manage"]);
    const table = await screen.findByRole("table", { name: "Staff" });
    const me = (await within(table).findByText("You")).closest("tr")!;
    expect(within(me).queryByRole("button")).not.toBeInTheDocument();
    const bala = within(table).getByText("Bala").closest("tr")!;
    await userEvent.click(within(bala).getByRole("button", { name: "Access" }));
    const dialog = await screen.findByRole("dialog", { name: /Access — Bala/ });
    const roleSelect = within(dialog).getAllByRole("combobox")[0];
    expect(within(roleSelect).queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    expect(within(roleSelect).getByRole("option", { name: "Manager" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Revoke role?" })).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ method: "DELETE", path: "/api/staff/memberships/m1" });
  });

  it("leave: managers decide others' pending requests, never their own", async () => {
    const leave = (id: string, userId: string) => ({ id, outletId: OUT_A, userId, userName: userId === ME ? "Asha" : "Bala", fromDate: at, toDate: at, reason: null, status: "PENDING", approvedByName: null, createdAt: at });
    state.routes = { "GET /api/staff/leave": () => ({ items: [leave("l1", "u2"), leave("l2", ME)], nextCursor: null }), "POST /api/staff/leave/l1/approve": () => ({}) };
    renderAs(<LeaveScreen />, ["staff.manage"]);
    const table = await screen.findByRole("table", { name: "Leave requests" });
    await within(table).findByText("Bala");
    expect(gets("/api/staff/leave")[0].query.get("status")).toBe("PENDING");
    expect(within(within(table).getByText("Asha").closest("tr")!).queryByRole("button")).not.toBeInTheDocument();
    await userEvent.click(within(within(table).getByText("Bala").closest("tr")!).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].path).toBe("/api/staff/leave/l1/approve");
  });

  it("tasks: work actions for the assignee, verify only for a manager who did not complete it", async () => {
    const task = (id: string, status: string, over = {}) => ({ id, outletId: OUT_A, title: `Task ${id}`, description: null, assignedToId: ME, priority: "HIGH", status, dueAt: null, completedById: null, createdAt: at, ...over });
    state.routes = { "GET /api/staff/tasks": () => ({ items: [task("a", "OPEN"), task("b", "DONE", { completedById: ME }), task("c", "DONE", { completedById: "u2" })], nextCursor: null }) };
    renderAs(<TasksScreen />, ["task.view", "task.manage"]);
    const table = await screen.findByRole("table", { name: "Tasks" });
    const row = async (t: string) => (await within(table).findByText(t)).closest("tr")!;
    expect(within(await row("Task a")).getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(within(await row("Task b")).queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(within(await row("Task c")).getByRole("button", { name: "Verify" })).toBeInTheDocument();
  });
});

// ============================================================
describe("finance", () => {
  const payment = { id: "p1", outletId: OUT_A, orderId: "o1", method: "CARD", status: "SUCCESS", amount: 500, refunded: 100, provider: "mock", providerRef: "pay_1", createdAt: at, order: { invoiceNo: "INV-1", channel: "DINE_IN" } };

  it("refunds reuse one idempotency key across retries of the same dialog", async () => {
    let attempt = 0;
    state.routes = { "GET /api/finance/payments": () => ({ items: [payment], nextCursor: null }), "POST /api/payments/p1/refund": () => (++attempt === 1 ? fail(503, "ProviderUnavailable", "Gateway timeout") : {}) };
    renderAs(<PaymentsScreen />, ["finance.view", "payment.refund"]);
    await userEvent.click(await screen.findByRole("button", { name: "Refund" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Amount/)).toHaveValue(400); // server amount − refunded
    await userEvent.click(within(dialog).getByRole("button", { name: "Refund" }));
    await within(dialog).findByRole("alert");
    await userEvent.click(within(dialog).getByRole("button", { name: "Refund" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].body.idempotencyKey).toBeTruthy();
    expect(posts()[1].body.idempotencyKey).toBe(posts()[0].body.idempotencyKey);
  });

  it("refund is not offered without payment.refund", async () => {
    state.routes = { "GET /api/finance/payments": () => ({ items: [payment], nextCursor: null }) };
    renderAs(<PaymentsScreen />, ["finance.view"]);
    await screen.findByText("INV-1");
    expect(screen.queryByRole("button", { name: "Refund" })).not.toBeInTheDocument();
  });

  it("overview shows the server's closing blockers and sends business dates as date-only strings", async () => {
    const sales = { orders: 10, covers: 20, grossSales: 1100, discounts: 100, taxes: 50, refunds: 0, netSales: 1000, revenue: 1050, aov: 100 };
    state.routes = {
      "GET /api/finance/closing": () => ({ outletId: OUT_A, businessDate: "2026-09-30", sales, collections: [{ method: "CASH", expected: 1000 }], expenses: 0, pettyCashNet: 0, unsettledOrders: 2, openDrawers: 0, reconciliationStatus: null, readyToClose: false, blockers: ["2 unsettled order(s)", "reconciliation not completed"] }),
      "GET /api/finance/pnl": () => ({ revenue: 1050, grossSales: 1100, discounts: 100, taxes: 50, refunds: 0, netSales: 1000, theoreticalFoodCost: 300, wastage: 20, countVariance: -5, expenses: 100, purchases: 400, grossMargin: 700, marginPct: 70, netProfit: 575, payments: [] }),
    };
    renderAs(<FinanceOverviewScreen />, ["finance.view"]);
    expect(await screen.findByText(/2 unsettled order\(s\) · reconciliation not completed/)).toBeInTheDocument();
    expect(gets("/api/finance/closing")[0].query.get("businessDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(gets("/api/finance/pnl")[0].query.get("from")).toMatch(/^\d{4}-\d{2}-01$/);
    const stmt = await screen.findByRole("table", { name: "Profit and loss statement" });
    expect(within(stmt).getByText("₹575.00")).toBeInTheDocument();
  });

  it("expenses page by offset", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, category: "MISC", amount: "10", description: `Item ${i}`, paidVia: "CASH", spentAt: at }));
    state.routes = { "GET /api/finance/expenses": (c) => (c.query.get("skip") === "50" ? [] : rows), "GET /api/finance/expenses/by-category": () => [{ category: "MISC", amount: 500, count: 50 }] };
    renderAs(<ExpensesScreen />, ["finance.view"]);
    await screen.findByText("Item 0");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(gets("/api/finance/expenses").at(-1)!.query.get("skip")).toBe("50"));
  });

  it("closing a drawer sends the count and reports the server-computed variance", async () => {
    state.routes = {
      "GET /api/finance/drawer": () => ({ items: [{ id: "d1", status: "OPEN", openingFloat: 1000, closingCount: null, openedAt: at, closedAt: null, openedByName: "Asha" }], nextCursor: null }),
      "POST /api/finance/drawer/d1/close": () => ({ expectedCash: 1500, closingCount: 1450, variance: -50, session: {} }),
    };
    renderAs(<DrawerScreen />, ["finance.view", "payment.take"]);
    const close = await screen.findByRole("button", { name: "Close" });
    expect(screen.queryByRole("button", { name: /Open drawer/ })).not.toBeInTheDocument(); // one is already open
    await userEvent.click(close);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Counted cash/), "1450");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close drawer" }));
    expect(await screen.findByText(/variance -₹50.00/)).toBeInTheDocument();
    expect(posts()[0].body).toEqual({ closingCount: 1450 });
  });
});

// ============================================================
describe("reports and exports", () => {
  const meta = [{ id: "DAILY_SALES", title: "Daily sales", permission: "reports.view", maxRows: 5000, aggregate: true, columns: [{ key: "date", header: "Date" }, { key: "netSales", header: "Net sales" }] }];

  it("runs the selected report with outlet + business-date filters and pages by server offset", async () => {
    state.routes = {
      "GET /api/reports": () => meta,
      "GET /api/reports/DAILY_SALES": (c) => ({ report: "DAILY_SALES", title: "Daily sales", columns: meta[0].columns, rows: [{ date: c.query.get("offset") === "200" ? "2026-09-02" : "2026-09-01", netSales: 1234.5 }], rowCount: 1, truncated: c.query.get("offset") !== "200", offset: Number(c.query.get("offset")), nextOffset: c.query.get("offset") === "200" ? null : 200 }),
    };
    renderAs(<ReportsScreen />, ["reports.view"]);
    expect(await screen.findByText("₹1,234.50")).toBeInTheDocument();
    const q = gets("/api/reports/DAILY_SALES")[0].query;
    expect(q.get("outletId")).toBe(OUT_A);
    expect(q.get("from")).toMatch(/^\d{4}-\d{2}-01$/);
    expect(screen.queryByRole("button", { name: /Download CSV/ })).not.toBeInTheDocument(); // no export.run
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("2026-09-02");
  });

  it("inline export downloads the CSV; background export queues a job", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    state.routes = {
      "GET /api/reports": () => meta,
      "GET /api/reports/DAILY_SALES": () => ({ report: "DAILY_SALES", title: "Daily sales", columns: meta[0].columns, rows: [], rowCount: 0, truncated: false, offset: 0, nextOffset: null }),
      "POST /api/exports": (c) => (c.body.mode === "inline" ? new Response("Date,Net sales\r\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="daily.csv"', "x-row-count": "0" } }) : { id: "job1", status: "PENDING" }),
    };
    renderAs(<ReportsScreen />, ["reports.view", "export.run"]);
    await userEvent.click(await screen.findByRole("button", { name: /Download CSV/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Export in background/ }));
    await screen.findByText(/Export queued/);
    expect(posts().map((p) => p.body.mode)).toEqual(["inline", "background"]);
    expect(posts()[0].body).toMatchObject({ report: "DAILY_SALES", filters: { outletId: OUT_A } });
  });

  it("formats cells by column meaning", () => {
    expect(renderCell("netSales", 10)).toBe("₹10.00");
    expect(renderCell("orders", 3)).toBe("3");
    expect(renderCell("qty", 1.23456)).toBe("1.235");
    expect(renderCell("x", null)).toBe("—");
  });
});

// ============================================================
describe("anomalies", () => {
  const anomaly = { id: "a1", outletId: OUT_A, type: "COUNT_VARIANCE", severity: "HIGH", entityType: "StockCount", entityId: "sc1", message: "Variance ₹900", status: "OPEN", resolutionNote: null, detectedAt: at, resolvedAt: null };

  it("dismissing requires a note and sends it; entity links resolve to screens", async () => {
    state.routes = { "GET /api/anomalies": () => ({ items: [anomaly], nextCursor: null }), "POST /api/anomalies/a1/dismiss": () => ({}) };
    renderAs(<AnomaliesScreen />, ["anomaly.view", "anomaly.resolve"]);
    expect(await screen.findByRole("link", { name: "View" })).toHaveAttribute("href", "/inventory/counts/sc1");
    expect(gets("/api/anomalies")[0].query.get("status")).toBe("OPEN");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByText(/Reason is required/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    await userEvent.type(within(dialog).getByRole("textbox"), "Counted twice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ note: "Counted twice" });
  });

  it("view-only users see anomalies without actions", async () => {
    state.routes = { "GET /api/anomalies": () => ({ items: [anomaly], nextCursor: null }) };
    renderAs(<AnomaliesScreen />, ["anomaly.view"]);
    await screen.findByText(/Variance ₹900/);
    expect(screen.queryByRole("button", { name: /Acknowledge|Resolve|Dismiss/ })).not.toBeInTheDocument();
    expect(anomalyEntityHref("Order", "o1")).toBeNull();
  });
});

// ============================================================
describe("dialogs", () => {
  it("keep focus in the field being typed into (no focus theft on re-render)", async () => {
    state.routes = { "GET /api/finance/expenses": () => [], "GET /api/finance/expenses/by-category": () => [], "POST /api/finance/expenses": () => ({}) };
    renderAs(<ExpensesScreen />, ["finance.view", "expense.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: /Record expense/ }));
    const dialog = await screen.findByRole("dialog");
    const description = within(dialog).getByLabelText(/Description/);
    await userEvent.type(description, "Gas cylinder refill");
    expect(description).toHaveValue("Gas cylinder refill");
    expect(description).toHaveFocus();
  });
});

describe("admin", () => {
  it("audit rows open a before/after inspector", async () => {
    state.routes = { "GET /api/audit": () => ({ items: [{ id: "x1", outletId: OUT_A, actorId: "u2", actorName: "Bala", action: "UPDATE", entityType: "Outlet", entityId: "o1", before: { name: "Old" }, after: { name: "New" }, createdAt: at }], nextCursor: null }) };
    renderAs(<AuditScreen />, ["audit.view"]);
    await userEvent.click(await screen.findByText("Bala"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/"Old"/)).toBeInTheDocument();
    expect(within(dialog).getByText(/"New"/)).toBeInTheDocument();
    expect(gets("/api/audit")[0].query.get("outletId")).toBe(OUT_A);
  });

  it("organization editing follows the server's canManage flag", async () => {
    state.routes = { "GET /api/master/organization": () => ({ id: "org", name: "Aharos Foods", legalName: null, gstin: null, currency: "INR", timezone: "Asia/Kolkata", active: true, createdAt: at, canManage: false }) };
    renderAs(<OrganizationScreen />, ["org.manage"]);
    await screen.findByText("Aharos Foods");
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
  });

  it("outlet-level managers edit names/hours but never send structural fields", async () => {
    state.routes = {
      "GET /api/master/outlets": () => [{ id: OUT_A, code: "A1", name: "Andheri", address: null, gstin: null, phone: null, currency: "INR", timezone: "Asia/Kolkata", openTime: null, closeTime: null, active: true }],
      "PATCH /api/master/outlets/out-a": () => ({}),
    };
    renderAs(<OutletsScreen />, ["outlet.manage"]);
    expect(screen.queryByRole("button", { name: /New outlet/ })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/Code/)).toBeDisabled();
    const name = within(dialog).getByLabelText(/Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "Andheri West");
    setValue(within(dialog).getByLabelText("Opens"), "09:00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ name: "Andheri West", openTime: "09:00" });
  });
});
