// @vitest-environment jsdom
/**
 * Phase 3 stock-screen workflows in a DOM: opening stock and manual adjustment
 * dialogs (permission-gated, one call each, adjustment carries an
 * Idempotency-Key that survives a retry), and the unmapped-sale queue
 * (resolution offered only with recipe.manage).
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StockScreen } from "@/features/backoffice/inventory";
import { state, installFetch, teardown, renderAs, posts, fail, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/inventory" }));

beforeEach(installFetch);
afterEach(teardown);

const materials = [{ id: "m-rice", sku: "RM-1", name: "Rice", active: true, baseUnitId: "kg", baseUnit: { code: "kg" }, categoryId: null, reorderLevel: "0", minStock: "0", taxPct: "0", perishable: false, trackBatch: false, purchaseUnitId: null, preferredVendorId: null }];
const base = (extra: Record<string, (c: never) => unknown> = {}) => ({
  "GET /api/master/materials": () => ({ items: materials, nextCursor: null }),
  "GET /api/inventory/stock": () => [{ materialId: "m-rice", quantity: 10, avgCost: 50, value: 500, name: "Rice", sku: "RM-1", unit: "kg", reorderLevel: 0, active: true, categoryId: null }],
  "GET /api/inventory/low-stock": () => [],
  "GET /api/inventory/unmapped": () => [],
  ...extra,
});

describe("stock screen: adjustments and opening stock", () => {
  it("offers the actions only with inventory.adjust", async () => {
    state.routes = base();
    renderAs(<StockScreen />, ["inventory.view"]);
    await screen.findByRole("table", { name: "Stock on hand" });
    expect(screen.queryByRole("button", { name: "Adjust stock" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Opening stock" })).toBeNull();
  });

  it("an adjustment is one signed POST with a reason, a note and an Idempotency-Key reused on retry", async () => {
    let attempt = 0;
    state.routes = base({ "POST /api/inventory/adjustments": () => (++attempt === 1 ? fail(422, "ValidationError", "Insufficient stock of Rice") : { row: { id: "l1" }, replayed: false }) });
    renderAs(<StockScreen />, ["inventory.view", "inventory.adjust"]);
    await userEvent.click(await screen.findByRole("button", { name: "Adjust stock" }));
    const dlg = await screen.findByRole("dialog", { name: "Adjust stock" });
    await userEvent.selectOptions(within(dlg).getByLabelText(/Material/), "m-rice");
    await userEvent.type(within(dlg).getByLabelText(/Quantity/), "2");
    await userEvent.selectOptions(within(dlg).getByLabelText(/Reason/), "THEFT_OR_LOSS");
    await userEvent.type(within(dlg).getByLabelText(/Explanation/), "Sack missing");
    await userEvent.click(within(dlg).getByRole("button", { name: "Post adjustment" }));
    expect(await within(dlg).findByText(/Insufficient stock of Rice/)).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Post adjustment" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Adjust stock" })).toBeNull());
    const sent = posts().filter((c) => c.path === "/api/inventory/adjustments");
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toEqual({ outletId: OUT_A, materialId: "m-rice", qty: -2, reason: "THEFT_OR_LOSS", note: "Sack missing" });
    expect(sent[0].headers["Idempotency-Key"]).toMatch(/^adj-/);
    expect(sent[1].headers["Idempotency-Key"]).toBe(sent[0].headers["Idempotency-Key"]); // same body: same key
  });

  it("opening stock posts the lines once", async () => {
    state.routes = base({ "POST /api/inventory/opening-stock": () => ({ lines: [] }) });
    renderAs(<StockScreen />, ["inventory.view", "inventory.adjust"]);
    await userEvent.click(await screen.findByRole("button", { name: "Opening stock" }));
    const dlg = await screen.findByRole("dialog", { name: "Opening stock" });
    await userEvent.selectOptions(within(dlg).getAllByRole("combobox")[0], "m-rice");
    const nums = within(dlg).getAllByRole("spinbutton");
    await userEvent.type(nums[0], "25");
    await userEvent.type(nums[1], "48");
    await userEvent.click(within(dlg).getByRole("button", { name: "Post opening stock" }));
    await waitFor(() => expect(posts().filter((c) => c.path === "/api/inventory/opening-stock")).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ outletId: OUT_A, lines: [{ materialId: "m-rice", qty: 25, rate: 48 }] });
  });
});

describe("unmapped-sale queue", () => {
  const sale = { id: "u1", posCode: "PP-9", posName: "Lassi", qty: 3, source: "PETPOOJA", firstSeenAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-10-01T10:00:00.000Z" };

  it("is listed for inventory.view; resolving needs recipe.manage", async () => {
    state.routes = base({ "GET /api/inventory/unmapped": () => [sale] });
    renderAs(<StockScreen />, ["inventory.view"]);
    const list = await screen.findByRole("list", { name: "Unmapped sales" });
    expect(within(list).getByText("Lassi")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Map" })).toBeNull();
  });

  it("ignore is one confirmed call to the resolve endpoint", async () => {
    state.routes = base({ "GET /api/inventory/unmapped": () => [sale], "POST /api/inventory/unmapped/u1/resolve": () => ({ sale: { ...sale, status: "IGNORED" }, consumed: [] }) });
    renderAs(<StockScreen />, ["inventory.view", "recipe.manage"]);
    const list = await screen.findByRole("list", { name: "Unmapped sales" });
    await userEvent.click(within(list).getByRole("button", { name: "Ignore" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Ignore Lassi?" })).getByRole("button", { name: /Confirm|Ignore/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/inventory/unmapped/u1/resolve", body: { action: "IGNORE" } });
  });
});
