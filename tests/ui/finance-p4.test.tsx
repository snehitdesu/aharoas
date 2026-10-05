// @vitest-environment jsdom
/**
 * Phase 4 finance screens in a DOM: expense categories come from the server and
 * an expense carries an Idempotency-Key reused on retry; voiding requires a
 * reason and is one call; the drawer shows frozen expected / variance and
 * records a cash-in/out with a key.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExpensesScreen, DrawerScreen } from "@/features/backoffice/finance";
import { state, installFetch, teardown, renderAs, posts, fail, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/finance/expenses" }));
beforeEach(installFetch);
afterEach(teardown);

const at = "2026-10-05T06:30:00.000Z";

describe("expenses", () => {
  it("offers the server's categories; a retried submission reuses its Idempotency-Key", async () => {
    let n = 0;
    state.routes = {
      "GET /api/finance/expenses": () => [],
      "GET /api/finance/expenses/by-category": () => [],
      "GET /api/finance/expense-categories": () => [{ id: "c1", name: "GAS" }, { id: "c2", name: "LAUNDRY" }],
      "POST /api/finance/expenses": () => (++n === 1 ? fail(500, "Internal", "Try again") : { id: "e1" }), // 500: never auto-retried (a 503 is — tests/ui/api-busy-retry.test.ts); the USER retries
    };
    renderAs(<ExpensesScreen />, ["finance.view", "expense.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: /Record expense/ }));
    const dlg = await screen.findByRole("dialog", { name: "Record expense" });
    await waitFor(() => expect(within(dlg).getByRole("option", { name: "Laundry" })).toBeInTheDocument());
    await userEvent.selectOptions(within(dlg).getByLabelText(/Category/), "LAUNDRY");
    await userEvent.type(within(dlg).getByLabelText(/Amount/), "320.50");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save expense" }));
    await within(dlg).findByText(/server|Try again|wrong/i);
    await userEvent.click(within(dlg).getByRole("button", { name: "Save expense" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].body).toMatchObject({ outletId: OUT_A, category: "LAUNDRY", amount: 320.5, paidVia: "CASH" });
    expect(posts()[0].headers["Idempotency-Key"]).toMatch(/^exp-/);
    expect(posts()[1].headers["Idempotency-Key"]).toBe(posts()[0].headers["Idempotency-Key"]);
  });

  it("void requires a reason and sends it in one call; hidden without expense.manage", async () => {
    const row = { id: "e9", category: "GAS", amount: "1200", description: "Cylinder", paidVia: "CASH", spentAt: at };
    state.routes = { "GET /api/finance/expenses": () => [row], "GET /api/finance/expenses/by-category": () => [], "GET /api/finance/expense-categories": () => [], "POST /api/finance/expenses/e9/void": () => ({}) };
    const view = renderAs(<ExpensesScreen />, ["finance.view"]);
    await screen.findByText("Cylinder");
    expect(screen.queryByRole("button", { name: "Void" })).toBeNull();
    view.unmount();
    renderAs(<ExpensesScreen />, ["finance.view", "expense.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Void" }));
    const confirm = await screen.findByRole("dialog", { name: "Void this expense?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Void" }));
    expect(await within(confirm).findByText(/Reason is required/)).toBeInTheDocument();
    await userEvent.type(within(confirm).getByRole("textbox"), "Entered twice");
    await userEvent.click(within(confirm).getByRole("button", { name: "Void" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/finance/expenses/e9/void", body: { reason: "Entered twice" } });
  });
});

describe("cash drawer", () => {
  it("shows the frozen expected cash and variance and records cash in/out with a key", async () => {
    state.routes = {
      "GET /api/finance/drawer": () => ({ items: [
        { id: "d1", status: "OPEN", openingFloat: 500, closingCount: null, openedAt: at, closedAt: null, openedByName: "Asha", expectedCash: null, variance: null },
        { id: "d0", status: "CLOSED", openingFloat: 1000, closingCount: 1400, openedAt: at, closedAt: at, openedByName: "Bala", expectedCash: 1410, variance: -10 },
      ], nextCursor: null }),
      "POST /api/finance/drawer/d1/movements": () => ({ id: "m1" }),
    };
    renderAs(<DrawerScreen />, ["finance.view", "payment.take"]);
    const table = await screen.findByRole("table", { name: "Drawer sessions" });
    const closed = within(table).getByText("Bala").closest("tr")!;
    expect(closed).toHaveTextContent("1,410.00");
    expect(closed).toHaveTextContent("-₹10.00");
    await userEvent.click(within(table).getByRole("button", { name: "Cash in/out" }));
    const dlg = await screen.findByRole("dialog", { name: "Cash in / out" });
    await userEvent.type(within(dlg).getByLabelText(/Amount/), "120");
    await userEvent.type(within(dlg).getByLabelText(/Reason/), "Ice delivery");
    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/finance/drawer/d1/movements", body: { type: "PAY_OUT", amount: 120, reason: "Ice delivery" } });
    expect(posts()[0].headers["Idempotency-Key"]).toMatch(/^drw-/);
  });
});
