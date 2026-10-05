// @vitest-environment jsdom
/**
 * Phase 5 analytics screen in a DOM: tabs follow permissions; filters are sent
 * as date-only business days; the trend regroups by week; insights show the
 * server's explanation and rule; the P&L is labelled an estimate.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalyticsScreen } from "@/features/backoffice/analytics";
import { state, installFetch, teardown, renderAs, gets, setValue, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/analytics" }));
beforeEach(installFetch);
afterEach(teardown);

const summary = { orders: 4, refundedOrders: 1, covers: 0, grossSales: 669.99, discounts: 30, taxes: 35.2, refunds: 125, refundsExTax: 119.04, netSales: 520.95, revenue: 550.19, aov: 168.8 };
const insights = {
  window: { from: "2026-03-13", to: "2026-03-19" },
  insights: [{ code: "SALES_DROP", severity: "CRITICAL", category: "sales", title: "Net sales down 60%", detail: "Net sales for 2026-03-13 – 2026-03-19 were ₹800.00 against a 7-day average of ₹2,000.00. Rule: a drop of 30% or more.", link: "/analytics" }],
};

function salesRoutes() {
  state.routes = {
    "GET /api/analytics/sales-summary": () => summary,
    "GET /api/analytics/sales-trend": (c) => (c.query.get("granularity") === "week" ? [{ period: "2026-03-09", orders: 4, grossSales: 669.99, discounts: 30, refunds: 125, netSales: 520.95, taxes: 35.2, total: 675.19, aov: 168.8 }] : [{ period: "2026-03-10", orders: 1, grossSales: 299.99, discounts: 30, refunds: 0, netSales: 269.99, taxes: 25.2, total: 295.19, aov: 295.19 }]),
    "GET /api/analytics/payments": () => [{ method: "CASH", count: 3, collected: 325, refunded: 105, net: 220 }],
    "GET /api/analytics/outlet-comparison": () => [],
    "GET /api/analytics/insights": () => insights,
    "GET /api/analytics/finance": () => ({
      sales: summary,
      collections: { byMethod: [], collected: 675.19, refunded: 125, netCollected: 550.19 },
      revenueVsPayments: { billedNet: 550.19, netCollected: 550.19, difference: 0 },
      refunds: { amount: 125, exTax: 119.04, tax: 5.96, fullyRefundedOrders: 1 },
      expenses: { total: 300, count: 1, voidedCount: 1, voidedAmount: 200 },
      tax: { invoicedTaxable: 0, invoicedTax: 35.2, creditNoteTaxable: 0, creditNoteTax: 5.96, netOutputTax: 29.24 },
      vendorDues: { vendors: 1, totalDue: 1000, overdue: 1000, advances: 0, netPayable: 1000 },
      cashDrawer: { closedSessions: 0, sessionsWithVariance: 0, netVariance: 0, absoluteVariance: 0 },
      reconciliation: [],
      pnl: { netSales: 520.95, theoreticalFoodCost: 100, wastage: 50, countVariance: 0, expenses: 300, grossMargin: 420.95, marginPct: 80.8, netProfit: 70.95, basis: "Operational estimate … It is not accounting profit." },
    }),
  };
}

describe("analytics screen", () => {
  it("sales tab: KPIs, date-only business-day filters, weekly regrouping, net per method", async () => {
    salesRoutes();
    renderAs(<AnalyticsScreen />, ["reports.view"]);
    expect(await screen.findByText("₹520.95")).toBeInTheDocument();
    const call = gets("/api/analytics/sales-summary")[0];
    expect(call.query.get("outletId")).toBe(OUT_A);
    expect(call.query.get("from")).toMatch(/^\d{4}-\d{2}-01$/);
    expect(call.query.get("to")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await screen.findByText("2026-03-10");
    await userEvent.selectOptions(screen.getByLabelText("Group by"), "week");
    expect(await screen.findByText("2026-03-09")).toBeInTheDocument();
    expect(gets("/api/analytics/sales-trend").at(-1)!.query.get("granularity")).toBe("week");
    const methods = screen.getByRole("table", { name: "Payment methods" });
    expect(within(methods).getByText("₹220.00")).toBeInTheDocument();
    // No finance.view: no Finance tab.
    expect(screen.queryByRole("tab", { name: "Finance" })).toBeNull();
  });

  it("insights explain why they fired; a role without reports.view sees only insights", async () => {
    salesRoutes();
    renderAs(<AnalyticsScreen />, ["inventory.view"]);
    const card = await screen.findByTestId("insight-SALES_DROP");
    expect(card).toHaveTextContent("Critical");
    expect(card).toHaveTextContent(/Rule: a drop of 30% or more/);
    expect(screen.queryByRole("tab", { name: "Sales" })).toBeNull();
    expect(gets("/api/analytics/sales-summary")).toHaveLength(0);
  });

  it("finance tab labels the P&L as an estimate, not accounting profit", async () => {
    salesRoutes();
    renderAs(<AnalyticsScreen />, ["reports.view", "finance.view"]);
    await userEvent.click(await screen.findByRole("tab", { name: "Finance" }));
    expect(await screen.findByText("Operational P&L (estimate)")).toBeInTheDocument();
    expect(screen.getByText(/not accounting profit/)).toBeInTheDocument();
    expect(screen.getByText(/1 voided \(₹200.00\) excluded/)).toBeInTheDocument();
  });

  it("refuses a reversed date range without calling the API", async () => {
    salesRoutes();
    renderAs(<AnalyticsScreen />, ["reports.view"]);
    await screen.findByText("₹520.95");
    const before = gets("/api/analytics/sales-summary").length;
    setValue(screen.getByLabelText("From"), "2099-01-01");
    await waitFor(() => expect(screen.getByText(/start date must be on or before/)).toBeInTheDocument());
    expect(gets("/api/analytics/sales-summary").length).toBe(before);
  });
});
