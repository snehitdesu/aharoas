// @vitest-environment jsdom
/**
 * Back-office screens in a DOM against a mocked fetch that records every
 * request: data comes only from the API, filters/pagination go to the server,
 * actions are offered per status (shared transition table) AND permission, and
 * each action is exactly one call to the existing workflow endpoint.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Permission } from "@/server/auth/rbac";
import { StockScreen, LedgerScreen, TransferDetail, StockCountDetail, WastageScreen, ProductionDetail, IssueDetail, ledgerSourceHref, changedEntries } from "@/features/backoffice/inventory";
import { PurchaseOrderDetail, IndentsScreen } from "@/features/backoffice/procurement";
import { state, installFetch, teardown, renderAs as render, OUT_A, OUT_B, posts, setValue, type Call } from "./harness";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/inventory" }));

// Local aliases keep the assertions below short.
let calls: Call[] = [];
let routes: Record<string, (c: Call) => unknown> = {};
beforeEach(() => {
  router.push.mockReset();
  installFetch();
  calls = state.calls;
  routes = {};
  state.routes = new Proxy({}, { get: (_t, k: string) => routes[k] });
});
afterEach(teardown);

const renderAs = (ui: React.ReactNode, permissions: Permission[], outletId = OUT_A) => render(ui, permissions, { outletId });

const materials = [
  { id: "m-tom", sku: "RM-1", name: "Tomato", active: true, baseUnitId: "kg", baseUnit: { code: "kg" }, categoryId: null, reorderLevel: "5", minStock: "0", taxPct: "0", perishable: true, trackBatch: false, purchaseUnitId: null, preferredVendorId: null },
  { id: "m-oil", sku: "RM-2", name: "Oil", active: true, baseUnitId: "l", baseUnit: { code: "l" }, categoryId: null, reorderLevel: "0", minStock: "0", taxPct: "0", perishable: false, trackBatch: false, purchaseUnitId: null, preferredVendorId: null },
];
const baseRoutes = {
  "GET /api/master/materials": () => ({ items: materials, nextCursor: null }),
  "GET /api/master/departments": () => [{ id: "d-store", name: "Main store", kind: "STORE", active: true, outletId: OUT_A }, { id: "d-kit", name: "Kitchen", kind: "KITCHEN", active: true, outletId: OUT_A }],
  "GET /api/master/vendors": () => ({ items: [{ id: "v1", name: "FreshCo", active: true }], nextCursor: null }),
};

describe("inventory: stock on hand", () => {
  it("renders server stock, flags low stock from /low-stock, searches, and opens the material movement page", async () => {
    routes = {
      ...baseRoutes,
      "GET /api/inventory/stock": () => [
        { materialId: "m-tom", quantity: 3, avgCost: 40, value: 120, name: "Tomato", sku: "RM-1", unit: "kg", reorderLevel: 5, active: true, categoryId: null },
        { materialId: "m-oil", quantity: -2, avgCost: 150, value: -300, name: "Oil", sku: "RM-2", unit: "l", reorderLevel: 0, active: true, categoryId: null },
      ],
      "GET /api/inventory/low-stock": () => [{ materialId: "m-tom", sku: "RM-1", name: "Tomato", quantity: 3, reorderLevel: 5 }],
    };
    renderAs(<StockScreen />, ["inventory.view"]);
    const table = await screen.findByRole("table", { name: "Stock on hand" });
    await within(table).findByText("Tomato");
    expect(calls.find((c) => c.path === "/api/inventory/stock")!.query.get("outletId")).toBe(OUT_A);
    const tomato = within(table).getByText("Tomato").closest("tr")!;
    expect(within(tomato).getByText("Low")).toBeInTheDocument();
    expect(within(within(table).getByText("Oil").closest("tr")!).getByText("Negative")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /Negative/ }));
    expect(within(table).queryByText("Tomato")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    await userEvent.type(screen.getByRole("searchbox"), "tom");
    await waitFor(() => expect(within(table).queryByText("Oil")).not.toBeInTheDocument());

    await userEvent.click(within(table).getByText("Tomato"));
    expect(router.push).toHaveBeenCalledWith("/inventory/stock/m-tom");
  });

  it("shows a retryable error on server failure and a non-retryable one when forbidden", async () => {
    let fail = true;
    routes = { ...baseRoutes, "GET /api/inventory/stock": () => (fail ? { __status: 500, error: { code: "InternalError", message: "boom" } } : []), "GET /api/inventory/low-stock": () => [] };
    const { unmount } = renderAs(<StockScreen />, ["inventory.view"]);
    fail = false;
    await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
    expect(await screen.findByText("No stock movements at this outlet yet")).toBeInTheDocument();
    unmount();

    routes = { ...baseRoutes, "GET /api/inventory/stock": () => ({ __status: 403, error: { code: "ForbiddenError", message: "Missing permission: inventory.view" } }), "GET /api/inventory/low-stock": () => [] };
    renderAs(<StockScreen />, ["inventory.view"]);
    expect(await screen.findByText("Not allowed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe("inventory: ledger", () => {
  it("filters and pages on the server and links rows to their source documents", async () => {
    const row = (id: string, over = {}) => ({ id, createdAt: "2026-09-01T10:00:00Z", materialId: "m-tom", materialName: "Tomato", sku: "RM-1", unit: "kg", txnType: "WASTAGE", qty: -1.5, rate: 40, amount: -60, sourceType: "WASTAGE", sourceId: "w123456", departmentId: null, batchNo: null, note: "SPOILAGE WST-1", ...over });
    routes = {
      ...baseRoutes,
      "GET /api/inventory/ledger": (c) => (c.query.get("cursor") ? { items: [row("r2", { txnType: "PURCHASE_RECEIPT", qty: 10, sourceType: "GRN", sourceId: "g1" })], nextCursor: null } : { items: [row("r1")], nextCursor: "r1" }),
    };
    renderAs(<LedgerScreen />, ["inventory.view"]);
    const table = await screen.findByRole("table", { name: "Inventory ledger" });
    const link = await within(table).findByRole("link", { name: /Wastage #/ });
    expect(link).toHaveAttribute("href", "/inventory/wastage/w123456");
    expect(within(table).getByText("-1.5 kg")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Type"), "WASTAGE");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/inventory/ledger" && c.query.get("txnType") === "WASTAGE" && c.query.get("outletId") === OUT_A)).toBe(true));

    await userEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await within(table).findByRole("link", { name: /Grn #/ });
    expect(calls.filter((c) => c.path === "/api/inventory/ledger").at(-1)!.query.get("cursor")).toBe("r1");
  });

  it("maps source types to detail routes (no link for orders / manual rows)", () => {
    expect(ledgerSourceHref("GRN", "g1")).toBe("/procurement/grns/g1");
    expect(ledgerSourceHref("COUNT", "c1")).toBe("/inventory/counts/c1");
    expect(ledgerSourceHref("PRODUCTION", "p1")).toBe("/inventory/production/p1");
    expect(ledgerSourceHref("ORDER", "o1")).toBeNull();
    expect(ledgerSourceHref(null, null)).toBeNull();
  });
});

describe("inventory: transfers", () => {
  const transfer = (status: string) => ({
    id: "t1", number: "TRF-0001", status, fromOutletId: OUT_A, toOutletId: OUT_B, notes: null, createdAt: "2026-09-01T10:00:00Z", dispatchedAt: null, receivedAt: null,
    lines: [{ id: "l1", materialId: "m-tom", requestedQty: "4", dispatchedQty: status === "DRAFT" ? "0" : "4", receivedQty: "0", damagedQty: "0" }],
  });

  it("the sending outlet dispatches (one call with line quantities); the other end sees no dispatch", async () => {
    routes = { ...baseRoutes, "GET /api/inventory/transfers/t1": () => transfer("DRAFT"), "POST /api/inventory/transfers/t1/dispatch": () => ({ id: "t1", status: "DISPATCHED" }) };
    renderAs(<TransferDetail id="t1" />, ["inventory.view", "inventory.transfer"]);
    await userEvent.click(await screen.findByRole("button", { name: /Dispatch/ }));
    const dialog = await screen.findByRole("dialog");
    const qty = await within(dialog).findByLabelText(/Dispatch qty Tomato/);
    setValue(qty, "3.5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Dispatch" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/inventory/transfers/t1/dispatch", body: { lines: [{ lineId: "l1", dispatchedQty: 3.5 }] } });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("receiving is offered only at the receiving outlet", async () => {
    routes = { ...baseRoutes, "GET /api/inventory/transfers/t1": () => transfer("DISPATCHED"), "POST /api/inventory/transfers/t1/receive": () => ({}) };
    const { unmount } = renderAs(<TransferDetail id="t1" />, ["inventory.view", "inventory.transfer"], OUT_A);
    await screen.findByText(/Receiving happens at Bandra/);
    expect(screen.queryByRole("button", { name: /Receive/ })).not.toBeInTheDocument();
    unmount();

    renderAs(<TransferDetail id="t1" />, ["inventory.view", "inventory.transfer"], OUT_B);
    await userEvent.click(await screen.findByRole("button", { name: /Receive/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(await within(dialog).findByLabelText(/Damaged qty Tomato/), "1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Receive" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ lines: [{ lineId: "l1", receivedQty: 4, damagedQty: 1 }] });
  });

  it("view-only users get no actions", async () => {
    routes = { ...baseRoutes, "GET /api/inventory/transfers/t1": () => transfer("DRAFT") };
    renderAs(<TransferDetail id="t1" />, ["inventory.view"]);
    await screen.findByRole("table", { name: "Transfer lines" });
    expect(screen.queryByRole("button", { name: /Dispatch|Cancel/ })).not.toBeInTheDocument();
  });
});

describe("inventory: issues", () => {
  it("offers post + cancel on a draft and posts once after confirmation", async () => {
    let status = "DRAFT";
    routes = {
      ...baseRoutes,
      "GET /api/inventory/issues/i1": () => ({ id: "i1", number: "ISS-0001", status, outletId: OUT_A, fromDepartmentId: "d-store", toDepartmentId: "d-kit", notes: null, createdAt: "2026-09-01T10:00:00Z", issuedAt: null, lines: [{ id: "x", materialId: "m-tom", qty: "2" }] }),
      "POST /api/inventory/issues/i1/post": () => { status = "ISSUED"; return {}; },
    };
    renderAs(<IssueDetail id="i1" />, ["inventory.view", "inventory.issue"]);
    expect(await screen.findByText("Main store")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Post issue" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.dblClick(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Post issue" })).not.toBeInTheDocument()); // reloaded: ISSUED is terminal
  });
});

describe("inventory: stock counts", () => {
  const count = (status: string, lines = [{ id: "c1", materialId: "m-tom", bookQty: "10", physicalQty: "10", variance: "0", costImpact: "0" }, { id: "c2", materialId: "m-oil", bookQty: "5", physicalQty: "5", variance: "0", costImpact: "0" }]) =>
    ({ id: "sc1", number: "SC-0001", status, outletId: OUT_A, departmentId: null, createdAt: "2026-09-01T10:00:00Z", frozenAt: "2026-09-01T10:05:00Z", approvedAt: null, lines });

  it("sends only changed physical quantities and shows the server's variance; submit waits for saved entries", async () => {
    routes = {
      ...baseRoutes,
      "GET /api/inventory/counts/sc1": () => count("COUNTING"),
      "POST /api/inventory/counts/sc1/entries": () => count("COUNTING", [{ id: "c1", materialId: "m-tom", bookQty: "10", physicalQty: "8", variance: "-2", costImpact: "-80" }, { id: "c2", materialId: "m-oil", bookQty: "5", physicalQty: "5", variance: "0", costImpact: "0" }]),
    };
    renderAs(<StockCountDetail id="sc1" />, ["inventory.view", "inventory.count"]);
    const input = await screen.findByLabelText(/Physical qty Tomato/);
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "8");
    expect(screen.queryByRole("button", { name: "Submit for review" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Save 1 entry/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ entries: [{ materialId: "m-tom", physicalQty: 8 }] });
    expect((await screen.findAllByText("-₹80.00")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument(); // not a legal transition from COUNTING
  });

  it("approval requires the adjustment permission", async () => {
    routes = { ...baseRoutes, "GET /api/inventory/counts/sc1": () => count("REVIEW") };
    const { unmount } = renderAs(<StockCountDetail id="sc1" />, ["inventory.view", "inventory.count"]);
    await screen.findByRole("table", { name: "Count sheet" });
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Physical qty/)).not.toBeInTheDocument(); // read-only outside COUNTING
    unmount();
    renderAs(<StockCountDetail id="sc1" />, ["inventory.view", "inventory.count", "inventory.approve_adjustment"]);
    expect(await screen.findByRole("button", { name: "Approve & post adjustments" })).toBeInTheDocument();
  });

  it("changedEntries ignores untouched, blank and unchanged values", () => {
    const lines = count("COUNTING").lines;
    expect(changedEntries(lines, { "m-tom": "10", "m-oil": "" })).toEqual([]);
    expect(changedEntries(lines, { "m-tom": "9.5", "m-oil": "5" })).toEqual([{ materialId: "m-tom", physicalQty: 9.5 }]);
  });
});

describe("inventory: wastage", () => {
  it("creates a draft through the API and hides creation without the permission", async () => {
    routes = { ...baseRoutes, "GET /api/inventory/wastage": () => ({ items: [], nextCursor: null }), "POST /api/inventory/wastage": () => ({ id: "w9" }) };
    const { unmount } = renderAs(<WastageScreen />, ["inventory.view"]);
    await screen.findByText("No documents yet");
    expect(screen.queryByRole("button", { name: /Record wastage/ })).not.toBeInTheDocument();
    unmount();

    renderAs(<WastageScreen />, ["inventory.view", "inventory.wastage"]);
    await userEvent.click(await screen.findByRole("button", { name: /Record wastage/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/Reason/), "EXPIRED");
    await waitFor(() => expect(within(dialog).getAllByRole("option", { name: /Tomato/ }).length).toBeGreaterThan(0));
    await userEvent.selectOptions(within(dialog).getByLabelText("Line 1 material"), "m-tom");
    setValue(within(dialog).getByLabelText("Line 1 Qty"), "1.25");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ outletId: OUT_A, reason: "EXPIRED", lines: [{ materialId: "m-tom", qty: 1.25 }] });
    expect(router.push).toHaveBeenCalledWith("/inventory/wastage/w9");
  });

  it("keeps the dialog open with the server's validation message", async () => {
    routes = { ...baseRoutes, "GET /api/inventory/wastage": () => ({ items: [], nextCursor: null }), "POST /api/inventory/wastage": () => ({ __status: 422, error: { code: "ValidationError", message: "Each material may appear only once per wastage document" } }) };
    renderAs(<WastageScreen />, ["inventory.view", "inventory.wastage"]);
    await userEvent.click(await screen.findByRole("button", { name: /Record wastage/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(posts()).toHaveLength(0); // required fields block an empty submit
    await waitFor(() => expect(within(dialog).getAllByRole("option", { name: /Tomato/ }).length).toBeGreaterThan(0));
    await userEvent.selectOptions(within(dialog).getByLabelText("Line 1 material"), "m-tom");
    await userEvent.type(within(dialog).getByLabelText("Line 1 Qty"), "2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog).findByText(/only once per wastage document/)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("inventory: production", () => {
  it("completes a batch sending actual output and only the inputs that differ from the plan", async () => {
    routes = {
      ...baseRoutes,
      "GET /api/inventory/production/p1": () => ({ id: "p1", number: "PRD-0001", status: "IN_PROGRESS", outletId: OUT_A, outputMaterialId: "m-oil", recipeVersionId: "rv", plannedQty: "2", actualQty: "0", batchNo: null, expiryDate: null, completedAt: null, createdAt: "2026-09-01T10:00:00Z", lines: [{ id: "a", materialId: "m-tom", qty: "1" }] }),
      "POST /api/inventory/production/p1/complete": () => ({}),
    };
    renderAs(<ProductionDetail id="p1" />, ["inventory.view", "inventory.produce"]);
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Complete/ }));
    const dialog = await screen.findByRole("dialog");
    const actual = within(dialog).getByLabelText(/Actual output/);
    setValue(actual, "1.9");
    await userEvent.click(within(dialog).getByRole("button", { name: "Complete batch" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ actualQty: 1.9 });
  });
});

describe("procurement (shared document infrastructure)", () => {
  it("offers only transitions that are legal for the status and held by the user", async () => {
    const po = { id: "po1", number: "PO-0001", status: "SUBMITTED", vendorId: "v1", outletId: OUT_A, expectedDate: null, subtotal: "100", tax: "5", total: "105", notes: null, approvedAt: null, createdAt: "2026-09-01T10:00:00Z", lines: [], receipts: [] };
    routes = { ...baseRoutes, "GET /api/procurement/purchase-orders/po1": () => po, "POST /api/procurement/purchase-orders/po1/transition": () => ({}) };
    const { unmount } = renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.create"]);
    await screen.findByText("FreshCo");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument(); // needs purchase.approve
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument(); // not legal from SUBMITTED
    unmount();

    renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.approve"]);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ to: "APPROVED" });
  });

  it("list filters are sent to the server scoped to the selected outlet", async () => {
    routes = { ...baseRoutes, "GET /api/procurement/indents": () => ({ items: [], nextCursor: null }) };
    renderAs(<IndentsScreen />, ["purchase.view"]);
    await screen.findByText("No documents yet");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "APPROVED");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/procurement/indents" && c.query.get("status") === "APPROVED" && c.query.get("outletId") === OUT_A)).toBe(true));
    expect(screen.queryByRole("button", { name: /New indent/ })).not.toBeInTheDocument();
  });
});
