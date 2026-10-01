// @vitest-environment jsdom
/**
 * Menu, recipes, master data (materials / vendors / units) and floors & tables.
 * Same contract as the other back-office suites: data only from the API,
 * outlet-scoped reads use the selected outlet, actions are offered per the
 * service's authority rules (org-wide role for org data, outlet permission for
 * outlet overrides / tables) and per the shared transition tables, one API
 * call per action, and server validation / errors are surfaced.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor, renderHook, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { state, installFetch, teardown, renderAs, OUT_A, OUT_B, posts, gets, setValue, fail } from "./harness";
import { MenuItemsScreen, MenuItemDetail, MenuCategoriesScreen, ModifiersScreen, ruleText } from "@/features/backoffice/menu";
import { RecipesScreen, RecipeDetail } from "@/features/backoffice/recipes";
import { MaterialsScreen, MaterialDetail, VendorsScreen, VendorDetail, UnitsScreen } from "@/features/backoffice/master";
import { TablesScreen } from "@/features/backoffice/tables";
import { useLocalPage } from "@/lib/hooks/useLocalPage";
import { NAV_ITEMS, visibleNav } from "@/lib/nav";
import { formatPrecise } from "@/lib/format";

const router = { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/" }));

beforeEach(() => {
  router.push.mockReset();
  installFetch();
});
afterEach(teardown);

const at = "2026-09-30T10:00:00Z";
const dialog = () => screen.findByRole("dialog");
const invalid = (field: string, msg: string) => fail(422, "ValidationError", "Validation failed", { formErrors: [], fieldErrors: { [field]: [msg] } });

// ============================================================
describe("navigation", () => {
  it("the new screens are built and follow their backend read permissions", () => {
    for (const href of ["/menu", "/menu/categories", "/menu/modifiers", "/recipes", "/master/materials", "/master/vendors", "/master/units", "/tables"]) {
      expect(NAV_ITEMS.find((n) => n.href === href)?.planned).toBeUndefined();
    }
    const hrefs = (perms: string[]) => visibleNav(new Set(perms)).map((n) => n.href);
    expect(hrefs(["menu.view"])).toEqual(expect.arrayContaining(["/menu", "/menu/categories", "/menu/modifiers"]));
    expect(hrefs(["menu.view"])).not.toContain("/recipes");
    expect(hrefs(["recipe.view"])).toContain("/recipes");
    expect(hrefs(["vendor.view"])).toEqual(expect.arrayContaining(["/master/vendors"]));
    expect(hrefs(["vendor.view"])).not.toContain("/master/materials");
    expect(hrefs(["master.view"])).toEqual(expect.arrayContaining(["/master/materials", "/master/units"]));
    for (const p of ["order.view", "reservation.manage", "outlet.manage"]) expect(hrefs([p])).toContain("/tables");
    expect(hrefs(["kot.view"])).not.toContain("/tables");
  });

  it("conversion factors and recipe quantities keep their precision", () => {
    expect(formatPrecise(0.001)).toBe("0.001");
    expect(formatPrecise("0.1575")).toBe("0.1575");
    expect(formatPrecise(1000)).toBe("1000");
    expect(formatPrecise("2.50")).toBe("2.5");
  });

  it("local paging over a bounded list resets when the filters change", () => {
    const rows = Array.from({ length: 120 }, (_, i) => i);
    const { result, rerender } = renderHook(({ key }) => useLocalPage(rows, 50, key), { initialProps: { key: "a" } });
    expect(result.current.items).toHaveLength(50);
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current).toMatchObject({ page: 3, hasNext: false, hasPrev: true });
    expect(result.current.items).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119]);
    rerender({ key: "b" });
    expect(result.current.page).toBe(1);
  });
});

// ============================================================
describe("menu items", () => {
  const cats = [{ id: "c1", name: "Starters", sortOrder: 1, active: true }, { id: "c2", name: "Mains", sortOrder: 2, active: true }];
  const group = { id: "g1", name: "Spice", minSelect: 1, maxSelect: 1, active: true, options: [{ id: "o1", groupId: "g1", name: "Hot", priceDelta: "0", active: true }] };
  const item = (over = {}) => ({
    id: "m1", name: "Paneer Tikka", description: null, categoryId: "c1", category: { id: "c1", name: "Starters" }, price: "250", taxPct: "5", station: "KITCHEN", posCode: "PT", isVeg: true,
    active: true, soldOut: false, variants: [], modifierGroups: [], outletOverrides: [], effectivePrice: 250, offered: true, effectiveSoldOut: false, ...over,
  });
  const dal = item({ id: "m2", name: "Dal Makhani", categoryId: "c2", category: { id: "c2", name: "Mains" }, price: "220", outletOverrides: [{ price: "199", active: true, soldOut: true }], effectivePrice: 199, effectiveSoldOut: true });

  it("shows the outlet's effective price and availability; category filters on the server, search / status locally", async () => {
    state.routes = { "GET /api/menu": () => [item(), dal], "GET /api/menu/categories": () => cats };
    renderAs(<MenuItemsScreen />, ["menu.view"]);
    const table = await screen.findByRole("table", { name: "Menu items" });
    await within(table).findByText("Paneer Tikka");
    expect(gets("/api/menu")[0].query.get("outletId")).toBe(OUT_A);
    const dalRow = within(table).getByText("Dal Makhani").closest("tr")!;
    expect(within(dalRow).getByText("₹199.00")).toBeInTheDocument();
    expect(within(dalRow).getByText("Override")).toBeInTheDocument();
    expect(within(dalRow).getByText("Sold out")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New item/ })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Status"), "soldout");
    expect(within(table).queryByText("Paneer Tikka")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "");
    await userEvent.type(screen.getByRole("searchbox"), "paneer");
    await waitFor(() => expect(within(table).queryByText("Dal Makhani")).not.toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText("Category"), "c2");
    await waitFor(() => expect(gets("/api/menu").at(-1)!.query.get("categoryId")).toBe("c2"));
    await userEvent.click(await within(table).findByText("Paneer Tikka"));
    expect(router.push).toHaveBeenCalledWith("/menu/items/m1");
  });

  it("uses the selected outlet for scoping", async () => {
    state.routes = { "GET /api/menu": () => [], "GET /api/menu/categories": () => [] };
    renderAs(<MenuItemsScreen />, ["menu.view"], { outletId: OUT_B });
    await screen.findByText("No menu items yet");
    expect(gets("/api/menu").every((c) => c.query.get("outletId") === OUT_B)).toBe(true);
  });

  it("loading, server error with retry, then empty state", async () => {
    let broken = true;
    state.routes = { "GET /api/menu": () => (broken ? fail(500, "Internal", "boom") : []), "GET /api/menu/categories": () => [] };
    renderAs(<MenuItemsScreen />, ["menu.view"]);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(await screen.findByText("Something went wrong on the server. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText("boom")).not.toBeInTheDocument(); // internal messages never shown
    broken = false;
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("No menu items yet")).toBeInTheDocument();
  });

  it("create is for org-wide menu managers; server field errors stay in the dialog; success opens the item", async () => {
    let n = 0;
    state.routes = { "GET /api/menu": () => [], "GET /api/menu/categories": () => cats, "POST /api/menu/items": () => (++n === 1 ? invalid("posCode", "POS code PT is already mapped") : { id: "m9" }) };
    const { unmount } = renderAs(<MenuItemsScreen />, ["menu.view", "menu.manage"]);
    await screen.findByText("No menu items yet");
    expect(screen.queryByRole("button", { name: /New item/ })).not.toBeInTheDocument(); // outlet-level menu.manage only
    unmount();

    renderAs(<MenuItemsScreen />, ["menu.view", "menu.manage"], { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: /New item/ }));
    const d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Veg Biryani");
    await userEvent.selectOptions(within(d).getByLabelText(/^Category/), "c2");
    setValue(within(d).getByLabelText(/^Price/), "280");
    await userEvent.type(within(d).getByLabelText(/^POS code/), "PT");
    await userEvent.click(within(d).getByRole("button", { name: "Create item" }));
    expect(await within(d).findByText("POS code PT is already mapped")).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "Create item" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/menu/items/m9"));
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body).toEqual({ name: "Veg Biryani", categoryId: "c2", price: 280, taxPct: 5, station: "KITCHEN", posCode: "PT", isVeg: true });
  });

  it("an outlet manager overrides price / sold-out / offered for this outlet only; no structural actions", async () => {
    state.routes = {
      "GET /api/menu": () => [item()], "GET /api/menu/categories": () => cats, "GET /api/menu/modifier-groups": () => [group],
      "POST /api/menu/outlets/out-a/items/m1": () => ({}),
    };
    renderAs(<MenuItemDetail id="m1" />, ["menu.view", "menu.manage"]);
    await screen.findByRole("heading", { name: /Paneer Tikka/ });
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Take off menu/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add variant/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sold out here" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/menu/outlets/out-a/items/m1", body: { soldOut: true } });

    await userEvent.click(screen.getByRole("button", { name: "Set price" }));
    const d = await dialog();
    setValue(within(d).getByLabelText(/Outlet price/), "230");
    await userEvent.click(within(d).getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ price: 230 });

    await userEvent.click(screen.getByRole("button", { name: "Stop offering here" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop offering" }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2].body).toEqual({ active: false });
  });

  it("clearing the outlet price sends null (the menu price applies again)", async () => {
    state.routes = { "GET /api/menu": () => [dal], "GET /api/menu/categories": () => cats, "GET /api/menu/modifier-groups": () => [], "POST /api/menu/outlets/out-a/items/m2": () => ({}) };
    renderAs(<MenuItemDetail id="m2" />, ["menu.view", "menu.manage"]);
    await userEvent.click(await screen.findByRole("button", { name: "Set price" }));
    const d = await dialog();
    expect(within(d).getByLabelText(/Outlet price/)).toHaveValue(199);
    setValue(within(d).getByLabelText(/Outlet price/), "");
    await userEvent.click(within(d).getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ price: null });
  });

  it("org-wide managers manage variants and modifier groups; plate cost comes from the recipe API", async () => {
    state.routes = {
      "GET /api/menu": () => [item({ modifierGroups: [{ id: "l1", groupId: "g1", group }] })], "GET /api/menu/categories": () => cats,
      "GET /api/menu/modifier-groups": () => [group, { ...group, id: "g2", name: "Add-ons", minSelect: 0, maxSelect: 3 }],
      "GET /api/recipes/menu-items/m1/margin": () => ({ price: 250, cost: 80, margin: 170, foodCostPct: 32, versionId: "v1" }),
      "POST /api/menu/items/m1/variants": () => ({}), "POST /api/menu/items/m1/modifier-groups/g2": () => ({}), "DELETE /api/menu/items/m1/modifier-groups/g1": () => ({}),
    };
    renderAs(<MenuItemDetail id="m1" />, ["menu.view", "menu.manage", "recipe.view"], { orgWide: true });
    expect(await screen.findByText("32.0%")).toBeInTheDocument();
    expect(gets("/api/recipes/menu-items/m1/margin")[0].query.get("outletId")).toBe(OUT_A);
    expect(screen.getByText("Required · choose 1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Add variant/ }));
    let d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Half");
    setValue(within(d).getByLabelText(/Price change/), "-100");
    await userEvent.click(within(d).getByRole("button", { name: "Add variant" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ name: "Half", priceDelta: -100 });

    await userEvent.click(screen.getByRole("button", { name: /Attach group/ }));
    d = await dialog();
    expect(within(d).queryByRole("option", { name: /^Spice/ })).not.toBeInTheDocument(); // already attached
    await userEvent.selectOptions(within(d).getByLabelText(/^Group/), "g2");
    await userEvent.click(within(d).getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ method: "POST", path: "/api/menu/items/m1/modifier-groups/g2" });

    await userEvent.click(screen.getByRole("button", { name: "Detach" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Detach Spice?" })).getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toMatchObject({ method: "DELETE", path: "/api/menu/items/m1/modifier-groups/g1" });
  });

  it("without an approved recipe the plate cost explains why", async () => {
    state.routes = { "GET /api/menu": () => [item()], "GET /api/menu/categories": () => cats, "GET /api/menu/modifier-groups": () => [], "GET /api/recipes/menu-items/m1/margin": () => fail(422, "ValidationError", "Paneer Tikka has no approved recipe") };
    renderAs(<MenuItemDetail id="m1" />, ["menu.view", "recipe.view"]);
    expect(await screen.findByText("No approved recipe")).toBeInTheDocument();
  });

  it("an unknown item shows not found", async () => {
    state.routes = { "GET /api/menu": () => [item()], "GET /api/menu/categories": () => cats, "GET /api/menu/modifier-groups": () => [] };
    renderAs(<MenuItemDetail id="other-org-item" />, ["menu.view"]);
    expect(await screen.findByText("Menu item not found")).toBeInTheDocument();
  });
});

// ============================================================
describe("menu categories", () => {
  const cats = [{ id: "c1", name: "Starters", sortOrder: 1, active: true }, { id: "c2", name: "Desserts", sortOrder: 5, active: false }];

  it("lists in POS order; viewers get no actions", async () => {
    state.routes = { "GET /api/menu/categories": () => cats };
    renderAs(<MenuCategoriesScreen />, ["menu.view", "menu.manage"]);
    const table = await screen.findByRole("table", { name: "Menu categories" });
    await within(table).findByText("Starters");
    expect(within(table).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New category/ })).not.toBeInTheDocument();
  });

  it("create, edit sort order and reactivate", async () => {
    state.routes = { "GET /api/menu/categories": () => cats, "POST /api/menu/categories": () => ({}), "PATCH /api/menu/categories/c1": () => ({}), "PATCH /api/menu/categories/c2": () => ({}) };
    renderAs(<MenuCategoriesScreen />, ["menu.view", "menu.manage"], { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: /New category/ }));
    let d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Breads");
    setValue(within(d).getByLabelText(/^Sort order/), "3");
    await userEvent.click(within(d).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ name: "Breads", sortOrder: 3 });

    const table = screen.getByRole("table", { name: "Menu categories" });
    await userEvent.click(within(within(table).getByText("Starters").closest("tr")!).getByRole("button", { name: "Edit" }));
    d = await dialog();
    setValue(within(d).getByLabelText(/^Sort order/), "0");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ method: "PATCH", path: "/api/menu/categories/c1", body: { name: "Starters", sortOrder: 0 } });

    await userEvent.click(within(within(table).getByText("Desserts").closest("tr")!).getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toMatchObject({ path: "/api/menu/categories/c2", body: { active: true } });
  });
});

// ============================================================
describe("modifiers", () => {
  const groups = [{ id: "g1", name: "Spice", minSelect: 1, maxSelect: 1, active: true, itemCount: 4, options: [{ id: "o1", groupId: "g1", name: "Hot", priceDelta: 0, active: true }, { id: "o2", groupId: "g1", name: "Extra hot", priceDelta: 10, active: false }] }];

  it("rule text", () => {
    expect(ruleText(0, 3)).toBe("Optional · up to 3");
    expect(ruleText(1, 1)).toBe("Required · choose 1");
    expect(ruleText(1, 2)).toBe("Required · choose 1–2");
  });

  it("shows groups with rules, options and usage; read-only without org-wide menu.manage", async () => {
    state.routes = { "GET /api/menu/modifier-groups": () => groups };
    renderAs(<ModifiersScreen />, ["menu.view"]);
    expect(await screen.findByText("Required · choose 1")).toBeInTheDocument();
    expect(screen.getByText("Used by 4 items")).toBeInTheDocument();
    expect(screen.getByText("+₹10.00")).toBeInTheDocument();
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("empty state", async () => {
    state.routes = { "GET /api/menu/modifier-groups": () => [] };
    renderAs(<ModifiersScreen />, ["menu.view"]);
    expect(await screen.findByText("No modifier groups yet")).toBeInTheDocument();
  });

  it("group rules are checked before sending; edit, retire and option changes go to their endpoints", async () => {
    state.routes = {
      "GET /api/menu/modifier-groups": () => groups, "POST /api/menu/modifier-groups": () => ({}), "PATCH /api/menu/modifier-groups/g1": () => ({}),
      "POST /api/menu/modifier-groups/g1/options": () => ({}), "PATCH /api/menu/modifier-options/o2": () => ({}),
    };
    renderAs(<ModifiersScreen />, ["menu.view", "menu.manage"], { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: /New group/ }));
    let d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Add-ons");
    setValue(within(d).getByLabelText(/^Minimum/), "3");
    setValue(within(d).getByLabelText(/^Maximum/), "2");
    await userEvent.click(within(d).getByRole("button", { name: "Create group" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(/Minimum must be between 0 and the maximum/);
    expect(posts()).toHaveLength(0);
    setValue(within(d).getByLabelText(/^Maximum/), "4");
    expect(within(d).getByText("Required · choose 3–4")).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ name: "Add-ons", minSelect: 3, maxSelect: 4 });

    await userEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]); // the group (header) edit precedes its options
    d = await dialog();
    setValue(within(d).getByLabelText(/^Minimum/), "0");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ method: "PATCH", path: "/api/menu/modifier-groups/g1", body: { name: "Spice", minSelect: 0, maxSelect: 1 } });

    await userEvent.click(screen.getByRole("button", { name: /Option/ }));
    d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Mild");
    await userEvent.click(within(d).getByRole("button", { name: "Add option" }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toMatchObject({ path: "/api/menu/modifier-groups/g1/options", body: { name: "Mild", priceDelta: 0 } });

    const opts = screen.getByRole("table", { name: "Spice options" });
    await userEvent.click(within(within(opts).getByText("Extra hot").closest("tr")!).getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(posts()).toHaveLength(4));
    expect(posts()[3]).toMatchObject({ path: "/api/menu/modifier-options/o2", body: { active: true } });

    await userEvent.click(screen.getAllByRole("button", { name: "Deactivate" })[0]);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Deactivate Spice?" })).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(posts()).toHaveLength(5));
    expect(posts()[4]).toMatchObject({ path: "/api/menu/modifier-groups/g1", body: { active: false } });
  });
});

// ============================================================
describe("recipes", () => {
  const listRow = (i: number, over = {}) => ({ id: `r${i}`, name: `Recipe ${i}`, outputType: "MENU_ITEM", active: true, menuItemId: `m${i}`, outputMaterialId: null, menuItem: { name: `Dish ${i}` }, versions: [{ id: `v${i}`, version: 2, status: "DRAFT", effectiveFrom: at }, { id: `w${i}`, version: 1, status: "APPROVED", effectiveFrom: at }], ...over });
  const line = (over = {}) => ({ id: "l1", componentType: "MATERIAL", materialId: "mat1", subRecipeId: null, qty: "150", unitId: "g", wastagePct: "5", sortOrder: 0, name: "Paneer", sku: "RM-1", unit: "g", ...over });
  const version = (over = {}) => ({ id: "v2", version: 2, status: "DRAFT", effectiveFrom: at, yieldQty: "1", yieldUnitId: null, yieldUnit: null, servingSize: "1", notes: null, approvedAt: null, createdAt: at, lines: [line(), line({ id: "l2", componentType: "SUB_RECIPE", materialId: null, subRecipeId: "rs", name: "Tikka masala", sku: null, unit: null, qty: "0.1", wastagePct: "0" })], ...over });
  const recipe = (versions = [version(), version({ id: "v1", version: 1, status: "APPROVED", approvedAt: at })]) => ({ id: "r1", name: "Paneer Tikka", outputType: "MENU_ITEM", active: true, menuItemId: "m1", outputMaterialId: null, createdAt: at, menuItem: { id: "m1", name: "Paneer Tikka", price: "250" }, outputMaterial: null, versions });
  const cost = { total: 42.5, quantity: 1, lines: [{ materialId: "mat1", name: "Paneer", sku: "RM-1", unit: "kg", quantity: 0.1575, unitCost: 250, cost: 39.38 }, { materialId: "mat2", name: "Chilli", sku: "RM-2", unit: "kg", quantity: 0.01, unitCost: 0, cost: 0 }] };

  it("list: server search / type filter, array paging, latest version status; create only for org-wide authors", async () => {
    state.routes = { "GET /api/recipes": (c) => (c.query.get("cursor") ? [listRow(99)] : Array.from({ length: 25 }, (_, i) => listRow(i, i === 3 ? { versions: [{ id: "x", version: 1, status: "DRAFT", effectiveFrom: at }] } : {}))) };
    renderAs(<RecipesScreen />, ["recipe.view", "recipe.manage"]);
    const table = await screen.findByRole("table", { name: "Recipes" });
    await within(table).findByText("Recipe 0");
    expect(screen.queryByRole("button", { name: /New recipe/ })).not.toBeInTheDocument();
    expect(within(within(table).getByText("Recipe 3").closest("tr")!).getByText("None")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "tikka");
    await waitFor(() => expect(gets("/api/recipes").some((c) => c.query.get("search") === "tikka")).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText("Produces"), "SUB_RECIPE");
    await waitFor(() => expect(gets("/api/recipes").at(-1)!.query.get("outputType")).toBe("SUB_RECIPE"));
    await userEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await within(table).findByText("Recipe 99");
    expect(gets("/api/recipes").at(-1)!.query.get("cursor")).toBe("r24");
  });

  it("create a menu-item recipe as a draft and open it", async () => {
    state.routes = {
      "GET /api/recipes": () => [], "GET /api/menu": () => [{ id: "m1", name: "Paneer Tikka", active: true }, { id: "m2", name: "Old dish", active: false }],
      "GET /api/master/materials": () => ({ items: [], nextCursor: null }), "GET /api/master/units": () => [],
      "POST /api/recipes": () => ({ recipe: { id: "r7" }, version: { id: "v7" } }),
    };
    renderAs(<RecipesScreen />, ["recipe.view", "recipe.manage", "menu.view", "master.view"], { orgWide: true });
    await screen.findByText("No recipes yet");
    await userEvent.click(screen.getByRole("button", { name: /New recipe/ }));
    const d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Paneer Tikka");
    await waitFor(() => expect(within(d).getByRole("option", { name: "Paneer Tikka" })).toBeInTheDocument());
    expect(within(d).queryByRole("option", { name: "Old dish" })).not.toBeInTheDocument();
    await userEvent.selectOptions(within(d).getByLabelText(/^Menu item/), "m1");
    await userEvent.click(within(d).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/recipes/r7"));
    expect(posts()[0].body).toEqual({ name: "Paneer Tikka", outputType: "MENU_ITEM", menuItemId: "m1", yieldQty: 1, servingSize: 1 });
  });

  it("viewers see history, lines with names and cost, but no authoring or approval actions", async () => {
    state.routes = { "GET /api/recipes/r1": () => recipe(), "GET /api/recipes/versions/v2/cost": () => cost };
    renderAs(<RecipeDetail id="r1" />, ["recipe.view"]);
    await screen.findByRole("heading", { name: "Paneer Tikka" });
    const lines = screen.getByRole("table", { name: "Recipe lines" });
    expect(within(lines).getByText("Paneer")).toBeInTheDocument();
    expect(within(lines).getByText("150 g")).toBeInTheDocument();
    expect(within(lines).getByRole("link", { name: "Tikka masala" })).toHaveAttribute("href", "/recipes/rs");
    const breakdown = await screen.findByRole("table", { name: "Cost breakdown" });
    expect(within(breakdown).getByText("No cost")).toBeInTheDocument();
    expect(screen.getByText("₹42.50")).toBeInTheDocument();
    expect(gets("/api/recipes/versions/v2/cost")[0].query.get("outletId")).toBe(OUT_A);
    for (const name of [/Approve/, /Discard/, /Archive/, /Edit draft/, /Add line/, /New version/]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  it("draft workflow: edit, add a line in another unit, remove a line, approve (transition table × recipe.approve)", async () => {
    state.routes = {
      "GET /api/recipes/r1": () => recipe(), "GET /api/recipes/versions/v2/cost": () => cost,
      "GET /api/master/units": () => [{ id: "kg", code: "kg", name: "Kilogram", kind: "WEIGHT", active: true }, { id: "g", code: "g", name: "Gram", kind: "WEIGHT", active: true }],
      "GET /api/master/materials": () => ({ items: [{ id: "mat3", sku: "RM-3", name: "Onion", active: true, baseUnitId: "kg", baseUnit: { code: "kg" } }], nextCursor: null }),
      "PATCH /api/recipes/versions/v2": () => ({}), "POST /api/recipes/versions/v2/lines": () => ({}), "DELETE /api/recipes/lines/l1": () => ({}), "POST /api/recipes/versions/v2/approve": () => ({}),
    };
    renderAs(<RecipeDetail id="r1" />, ["recipe.view", "recipe.manage", "recipe.approve", "master.view"], { orgWide: true });
    await screen.findByRole("heading", { name: "Paneer Tikka" });
    expect(screen.queryByRole("button", { name: /New version/ })).not.toBeInTheDocument(); // a draft already exists
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Edit draft/ }));
    let d = await dialog();
    setValue(within(d).getByLabelText(/^Yield qty/), "4");
    await userEvent.click(within(d).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ method: "PATCH", path: "/api/recipes/versions/v2", body: { yieldQty: 4, servingSize: 1, effectiveFrom: expect.any(String) } });

    await userEvent.click(screen.getByRole("button", { name: /Add line/ }));
    d = await dialog();
    await waitFor(() => expect(within(d).getByRole("option", { name: /Onion/ })).toBeInTheDocument());
    await userEvent.selectOptions(within(d).getByLabelText("Material"), "mat3");
    setValue(within(d).getByLabelText(/^Quantity/), "200");
    await userEvent.selectOptions(within(d).getByLabelText(/^Unit/), "g");
    await userEvent.click(within(d).getByRole("button", { name: "Add line" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ componentType: "MATERIAL", materialId: "mat3", qty: 200, unitId: "g", wastagePct: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Remove Paneer" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove Paneer?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toMatchObject({ method: "DELETE", path: "/api/recipes/lines/l1" });

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Approve version 2?" })).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(posts()).toHaveLength(4));
    expect(posts()[3]).toMatchObject({ path: "/api/recipes/versions/v2/approve" });
  });

  it("approval refused by the server (e.g. sub-recipe without an approved version) is shown in the dialog", async () => {
    state.routes = { "GET /api/recipes/r1": () => recipe(), "GET /api/recipes/versions/v2/cost": () => cost, "POST /api/recipes/versions/v2/approve": () => fail(422, "ValidationError", "Sub-recipe rs has no approved version in effect") };
    renderAs(<RecipeDetail id="r1" />, ["recipe.view", "recipe.approve"], { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const d = await screen.findByRole("dialog", { name: "Approve version 2?" });
    await userEvent.click(within(d).getByRole("button", { name: "Confirm" }));
    expect(await within(d).findByText("Sub-recipe rs has no approved version in effect")).toBeInTheDocument();
  });

  it("approved versions are immutable: archive only; a new version copies a chosen version", async () => {
    const approved = recipe([version({ id: "v1", version: 1, status: "APPROVED", approvedAt: at })]);
    state.routes = { "GET /api/recipes/r1": () => approved, "GET /api/recipes/versions/v1/cost": () => cost, "POST /api/recipes/r1/versions": () => ({ id: "v2" }), "GET /api/master/units": () => [] };
    renderAs(<RecipeDetail id="r1" />, ["recipe.view", "recipe.manage", "recipe.approve"], { orgWide: true });
    await screen.findByRole("heading", { name: "Paneer Tikka" });
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit draft/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add line/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /New version/ }));
    const d = await dialog();
    await userEvent.click(within(d).getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/recipes/r1/versions", body: { copyFromVersionId: "v1" } });
  });

  it("cost errors (e.g. missing unit conversion) are shown without hiding the recipe", async () => {
    state.routes = { "GET /api/recipes/r1": () => recipe(), "GET /api/recipes/versions/v2/cost": () => fail(422, "ValidationError", "No unit conversion from g to base unit of material mat1") };
    renderAs(<RecipeDetail id="r1" />, ["recipe.view"]);
    expect(await screen.findByText("No unit conversion from g to base unit of material mat1")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Recipe lines" })).toBeInTheDocument();
  });

  it("a recipe from another organization is not found", async () => {
    state.routes = { "GET /api/recipes/rx": () => fail(404, "NotFoundError", "Recipe not found") };
    renderAs(<RecipeDetail id="rx" />, ["recipe.view"]);
    expect(await screen.findByText("Recipe not found")).toBeInTheDocument();
  });
});

// ============================================================
describe("materials", () => {
  const units = [{ id: "kg", code: "kg", name: "Kilogram", kind: "WEIGHT", active: true }, { id: "g", code: "g", name: "Gram", kind: "WEIGHT", active: true }, { id: "pc", code: "pc", name: "Piece", kind: "COUNT", active: true }];
  const mat = (over = {}) => ({ id: "mat1", sku: "RM-1", name: "Paneer", active: true, baseUnitId: "kg", baseUnit: { code: "kg" }, category: { name: "Dairy" }, categoryId: "cat1", reorderLevel: "5", minStock: "2", taxPct: "5", perishable: true, trackBatch: false, purchaseUnitId: null, preferredVendorId: null, ...over });

  it("filters on the server (active by default) and pages; create only for org-wide master managers", async () => {
    state.routes = { "GET /api/master/materials": (c) => ({ items: [mat()], nextCursor: c.query.get("cursor") ? null : "mat1" }), "GET /api/master/material-categories": () => [{ id: "cat1", name: "Dairy", parentId: null, active: true }] };
    renderAs(<MaterialsScreen />, ["master.view"]);
    const table = await screen.findByRole("table", { name: "Materials" });
    await within(table).findByText("Paneer");
    expect(within(table).getByText("Perishable")).toBeInTheDocument();
    expect(gets("/api/master/materials")[0].query.get("active")).toBe("true");
    expect(screen.queryByRole("button", { name: /New material/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "RM-1");
    await waitFor(() => expect(gets("/api/master/materials").some((c) => c.query.get("search") === "RM-1")).toBe(true));
    await userEvent.selectOptions(screen.getByLabelText("Category"), "cat1");
    await waitFor(() => expect(gets("/api/master/materials").at(-1)!.query.get("categoryId")).toBe("cat1"));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(gets("/api/master/materials").at(-1)!.query.get("cursor")).toBe("mat1"));
  });

  it("create sends only filled fields; a duplicate SKU is shown on the field", async () => {
    let n = 0;
    state.routes = {
      "GET /api/master/materials": () => ({ items: [], nextCursor: null }), "GET /api/master/material-categories": () => [], "GET /api/master/units": () => units,
      "POST /api/master/materials": () => (++n === 1 ? invalid("sku", 'SKU "RM-9" already exists') : { id: "mat9" }),
    };
    renderAs(<MaterialsScreen />, ["master.view", "master.manage"], { orgWide: true });
    await screen.findByText("No materials yet");
    await userEvent.click(screen.getByRole("button", { name: /New material/ }));
    const d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^SKU/), "RM-9");
    await userEvent.type(within(d).getByLabelText(/^Name/), "Onion");
    await waitFor(() => expect(within(d).getAllByRole("option", { name: /kg — Kilogram/ }).length).toBeGreaterThan(0));
    await userEvent.selectOptions(within(d).getByLabelText(/^Base unit/), "kg");
    await userEvent.click(within(d).getByRole("button", { name: "Create material" }));
    expect(await within(d).findByText('SKU "RM-9" already exists')).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "Create material" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/master/materials/mat9"));
    expect(posts()[1].body).toEqual({ sku: "RM-9", name: "Onion", baseUnitId: "kg", taxPct: 0, minStock: 0, reorderLevel: 0, perishable: false, trackBatch: false });
  });

  it("detail: base unit is locked once stock has moved; edits send only changed fields", async () => {
    state.routes = {
      "GET /api/master/materials/mat1": () => ({ ...mat(), baseUnit: units[0], category: { id: "cat1", name: "Dairy", parentId: null, active: true }, vendorLinks: [{ id: "vl1", vendorId: "v1", materialId: "mat1", lastRate: "320", leadTimeDays: 2, preferred: true }], stockMoved: true }),
      "GET /api/master/units": () => units, "GET /api/master/unit-conversions": () => [{ id: "cv1", fromUnitId: "g", toUnitId: "kg", from: "g", to: "kg", factor: 0.001, materialId: null, material: null }],
      "GET /api/master/material-categories": () => [], "GET /api/master/vendors": () => ({ items: [{ id: "v1", name: "Fresh Dairy", active: true }], nextCursor: null }),
      "PATCH /api/master/materials/mat1": () => ({}),
    };
    renderAs(<MaterialDetail id="mat1" />, ["master.view", "master.manage", "vendor.view"], { orgWide: true });
    await screen.findByRole("heading", { name: "Paneer" });
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Fresh Dairy" })).toHaveAttribute("href", "/master/vendors/v1");
    expect(within(screen.getByRole("table", { name: "Material conversions" })).getByText("1 g = 0.001 kg")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const d = await dialog();
    expect(within(d).getByLabelText(/^Base unit/)).toBeDisabled();
    setValue(within(d).getByLabelText(/^Reorder level/), "8");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ reorderLevel: 8 });
  });

  it("categories tab lists and creates material categories", async () => {
    state.routes = { "GET /api/master/materials": () => ({ items: [], nextCursor: null }), "GET /api/master/material-categories": () => [{ id: "cat1", name: "Dairy", parentId: null, active: true }], "POST /api/master/material-categories": () => ({}) };
    renderAs(<MaterialsScreen />, ["master.view", "master.manage"], { orgWide: true });
    await userEvent.click(await screen.findByRole("tab", { name: "Categories" }));
    await screen.findByRole("table", { name: "Material categories" });
    await userEvent.click(screen.getByRole("button", { name: /New category/ }));
    const d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Cheese");
    await userEvent.selectOptions(within(d).getByLabelText(/^Parent/), "cat1");
    await userEvent.click(within(d).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ name: "Cheese", parentId: "cat1" });
  });
});

// ============================================================
describe("vendors", () => {
  const vendor = (over = {}) => ({ id: "v1", name: "Fresh Dairy", companyName: "Fresh Dairy Pvt", phone: "9000", email: null, gstin: "27ABCDE1234F1Z5", active: true, paymentTerms: "NET15", creditLimit: "50000", address: null, bankAccount: "••••6789", bankIfsc: "••••", notes: null, ...over });

  it("list searches on the server; creation needs vendor.manage from an org-wide role", async () => {
    state.routes = { "GET /api/master/vendors": () => ({ items: [vendor()], nextCursor: null }) };
    renderAs(<VendorsScreen />, ["vendor.view"]);
    const table = await screen.findByRole("table", { name: "Vendors" });
    await within(table).findByText("Fresh Dairy");
    expect(screen.queryByRole("button", { name: /New vendor/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "27ABC");
    await waitFor(() => expect(gets("/api/master/vendors").some((c) => c.query.get("search") === "27ABC")).toBe(true));
    await userEvent.click(within(table).getByText("Fresh Dairy"));
    expect(router.push).toHaveBeenCalledWith("/master/vendors/v1");
  });

  it("detail shows server-masked bank details to non-managers and no edit actions", async () => {
    state.routes = { "GET /api/master/vendors/v1": () => ({ ...vendor(), materials: [{ id: "vl1", vendorId: "v1", materialId: "mat1", lastRate: "320", leadTimeDays: 2, preferred: true, material: { sku: "RM-1", name: "Paneer" } }] }) };
    renderAs(<VendorDetail id="v1" />, ["vendor.view"]);
    expect(await screen.findByText("••••6789")).toBeInTheDocument();
    expect(screen.getByText(/Bank details are masked/)).toBeInTheDocument();
    expect(screen.getByText("Preferred")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit|Link material|Deactivate/ })).not.toBeInTheDocument();
  });

  it("managers edit (changed fields only, field errors mapped) and link materials", async () => {
    let n = 0;
    state.routes = {
      "GET /api/master/vendors/v1": () => ({ ...vendor({ bankAccount: "1234506789", bankIfsc: "HDFC0001234" }), materials: [] }),
      "GET /api/master/materials": () => ({ items: [{ id: "mat1", sku: "RM-1", name: "Paneer", active: true, baseUnitId: "kg", baseUnit: { code: "kg" } }], nextCursor: null }),
      "PATCH /api/master/vendors/v1": () => (++n === 1 ? invalid("gstin", "GSTIN must be 15 characters") : {}),
      "POST /api/master/vendors/v1/materials": () => ({}),
    };
    renderAs(<VendorDetail id="v1" />, ["vendor.view", "vendor.manage", "master.view"], { orgWide: true });
    expect(await screen.findByText("1234506789")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Edit/ }));
    const d = await dialog();
    await userEvent.clear(within(d).getByLabelText(/^GSTIN/));
    await userEvent.type(within(d).getByLabelText(/^GSTIN/), "27abc");
    await userEvent.clear(within(d).getByLabelText(/^Payment terms/));
    await userEvent.type(within(d).getByLabelText(/^Payment terms/), "NET30");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(await within(d).findByText("GSTIN must be 15 characters")).toBeInTheDocument();
    expect(posts()[0].body).toEqual({ gstin: "27ABC", paymentTerms: "NET30" });

    await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: /Link material/ }));
    const l = await dialog();
    await waitFor(() => expect(within(l).getByRole("option", { name: /Paneer/ })).toBeInTheDocument());
    await userEvent.selectOptions(within(l).getByLabelText("Material"), "mat1");
    setValue(within(l).getByLabelText(/^Last rate/), "310");
    await userEvent.click(within(l).getByLabelText(/Preferred vendor/));
    await userEvent.click(within(l).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ path: "/api/master/vendors/v1/materials", body: { materialId: "mat1", lastRate: 310, preferred: true } });
  });

  it("deactivation is confirmed and sent as one PATCH", async () => {
    state.routes = { "GET /api/master/vendors/v1": () => ({ ...vendor(), materials: [] }), "PATCH /api/master/vendors/v1": () => ({}) };
    renderAs(<VendorDetail id="v1" />, ["vendor.view", "vendor.manage"], { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Deactivate Fresh Dairy?" })).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ method: "PATCH", path: "/api/master/vendors/v1", body: { active: false } });
  });
});

// ============================================================
describe("units", () => {
  const units = [{ id: "kg", code: "kg", name: "Kilogram", kind: "WEIGHT", active: true }, { id: "g", code: "g", name: "Gram", kind: "WEIGHT", active: true }, { id: "crate", code: "crate", name: "Crate", kind: "COUNT", active: true }];
  const convs = [{ id: "cv1", fromUnitId: "kg", toUnitId: "g", from: "kg", to: "g", factor: 1000, materialId: null, material: null }, { id: "cv2", fromUnitId: "crate", toUnitId: "kg", from: "crate", to: "kg", factor: 12, materialId: "mat1", material: "Tomato (RM-2)" }];

  it("lists units and global / material conversions; read-only without org-wide master.manage", async () => {
    state.routes = { "GET /api/master/units": () => units, "GET /api/master/unit-conversions": () => convs };
    renderAs(<UnitsScreen />, ["master.view"]);
    const table = await screen.findByRole("table", { name: "Unit conversions" });
    expect(await within(table).findByText("1 kg = 1000 g")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Tomato (RM-2)" })).toHaveAttribute("href", "/master/materials/mat1");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("invalid conversions are stopped before the API: same unit, zero factor, cross-kind without a material", async () => {
    state.routes = { "GET /api/master/units": () => units, "GET /api/master/unit-conversions": () => convs, "GET /api/master/materials": () => ({ items: [{ id: "mat1", sku: "RM-2", name: "Tomato", active: true, baseUnitId: "kg", baseUnit: { code: "kg" } }], nextCursor: null }), "POST /api/master/unit-conversions": () => ({}) };
    renderAs(<UnitsScreen />, ["master.view", "master.manage"], { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: /New conversion/ }));
    const d = await dialog();
    const submit = () => userEvent.click(within(d).getByRole("button", { name: "Add conversion" }));
    await userEvent.selectOptions(within(d).getByLabelText(/^From unit/), "kg");
    await userEvent.selectOptions(within(d).getByLabelText(/^To unit/), "kg");
    setValue(within(d).getByLabelText(/^Factor/), "2");
    await submit();
    expect(await within(d).findByRole("alert")).toHaveTextContent("Choose two different units.");
    await userEvent.selectOptions(within(d).getByLabelText(/^From unit/), "g");
    setValue(within(d).getByLabelText(/^Factor/), "0");
    await submit();
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent("The factor must be greater than zero."));
    setValue(within(d).getByLabelText(/^Factor/), "2");
    await userEvent.selectOptions(within(d).getByLabelText(/^From unit/), "crate");
    await submit();
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent(/different kinds/));
    expect(posts()).toHaveLength(0);
    await waitFor(() => expect(within(d).getByRole("option", { name: /Tomato/ })).toBeInTheDocument());
    await userEvent.selectOptions(within(d).getByLabelText("Material"), "mat1");
    await submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ fromUnitId: "crate", toUnitId: "kg", factor: 2, materialId: "mat1" });
  });

  it("unit edits send changed fields; the server's in-use rule is surfaced", async () => {
    state.routes = { "GET /api/master/units": () => units, "GET /api/master/unit-conversions": () => [], "GET /api/master/materials": () => ({ items: [], nextCursor: null }), "PATCH /api/master/units/kg": () => fail(422, "ValidationError", "A unit in use cannot change its code or kind (it would corrupt quantities)"), "POST /api/master/units": () => ({}) };
    renderAs(<UnitsScreen />, ["master.view", "master.manage"], { orgWide: true });
    const table = await screen.findByRole("table", { name: "Units" });
    await userEvent.click(within((await within(table).findByText("kg")).closest("tr")!).getByRole("button", { name: "Edit" }));
    const d = await dialog();
    await userEvent.selectOptions(within(d).getByLabelText(/^Kind/), "VOLUME");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(await within(d).findByText(/A unit in use cannot change its code or kind/)).toBeInTheDocument();
    expect(posts()[0].body).toEqual({ kind: "VOLUME" });
    await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("button", { name: /New unit/ }));
    const c = await dialog();
    await userEvent.type(within(c).getByLabelText(/^Code/), "L");
    await userEvent.type(within(c).getByLabelText(/^Name/), "Litre");
    await userEvent.selectOptions(within(c).getByLabelText(/^Kind/), "VOLUME");
    await userEvent.click(within(c).getByRole("button", { name: "Create unit" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ code: "L", name: "Litre", kind: "VOLUME" });
  });
});

// ============================================================
describe("floors & tables", () => {
  const tables = [
    { id: "t1", outletId: OUT_A, floorId: "f1", code: "T1", capacity: 4, status: "OCCUPIED", qrToken: "tok_1", floor: { name: "Ground" } },
    { id: "t2", outletId: OUT_A, floorId: "f2", code: "T2", capacity: 2, status: "AVAILABLE", qrToken: null, floor: { name: "Terrace" } },
  ];
  const floors = [{ id: "f1", outletId: OUT_A, name: "Ground", sortOrder: 0, tableCount: 1 }, { id: "f2", outletId: OUT_A, name: "Terrace", sortOrder: 1, tableCount: 1 }];

  it("front of house: running orders and bookings per table, status changes only; outlet-scoped reads", async () => {
    state.routes = {
      "GET /api/master/tables": () => tables,
      "GET /api/orders": () => ({ items: [{ id: "o1", tableId: "t1", status: "SERVED", total: "840", invoiceNo: null, createdAt: at }], nextCursor: null }),
      "GET /api/reservations": () => ({ items: [{ id: "r1", tableId: "t2", partySize: 2, reservedAt: at, status: "CONFIRMED", customer: { name: "Meera" } }, { id: "r2", tableId: "t2", partySize: 2, reservedAt: at, status: "CANCELLED", customer: { name: "Gone" } }], nextCursor: null }),
      "POST /api/master/tables/t1/status": () => fail(422, "ValidationError", "Table has an active order"),
    };
    renderAs(<TablesScreen />, ["order.view", "order.modify", "reservation.manage"], { outletId: OUT_B });
    const table = await screen.findByRole("table", { name: "Tables" });
    const t1 = (await within(table).findByText("T1")).closest("tr")!;
    expect(await within(t1).findByText("₹840.00")).toBeInTheDocument();
    const t2 = within(table).getByText("T2").closest("tr")!;
    expect(await within(t2).findByText(/Meera/)).toBeInTheDocument();
    expect(within(t2).queryByText(/Gone/)).not.toBeInTheDocument();
    for (const path of ["/api/master/tables", "/api/orders", "/api/reservations"]) expect(gets(path)[0].query.get("outletId")).toBe(OUT_B);
    expect(gets("/api/orders")[0].query.get("active")).toBe("true");
    expect(gets("/api/master/floors")).toHaveLength(0); // no master.view: floors come from the table rows
    expect(screen.queryByRole("button", { name: /New table|New floor/ })).not.toBeInTheDocument();
    expect(within(t1).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(t1).queryByRole("button", { name: "QR for T1" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Floor"), "f2");
    expect(within(table).queryByText("T1")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Floor"), "");

    await userEvent.click(within(within(table).getByText("T1").closest("tr")!).getByRole("button", { name: "Status" }));
    const d = await dialog();
    await userEvent.selectOptions(within(d).getByLabelText(/^Status/), "AVAILABLE");
    await userEvent.click(within(d).getByRole("button", { name: "Update status" }));
    expect(await within(d).findByText("Table has an active order")).toBeInTheDocument();
    expect(posts()[0]).toMatchObject({ path: "/api/master/tables/t1/status", body: { status: "AVAILABLE" } });
  });

  it("managers set up floors and tables (outlet from the shell) and rotate QR tokens", async () => {
    state.routes = {
      "GET /api/master/tables": () => tables, "GET /api/master/floors": () => floors,
      "POST /api/master/floors": () => ({}), "POST /api/master/tables": () => ({}), "PATCH /api/master/tables/t2": () => ({}), "POST /api/master/tables/t1/qr": () => ({}),
    };
    renderAs(<TablesScreen />, ["outlet.manage", "master.view"]);
    const floorTable = await screen.findByRole("table", { name: "Floors" });
    expect(await within(floorTable).findByText("Terrace")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Running order" })).not.toBeInTheDocument(); // no order.view

    await userEvent.click(screen.getByRole("button", { name: /New floor/ }));
    let d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Name/), "Rooftop");
    await userEvent.click(within(d).getByRole("button", { name: "Create floor" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ outletId: OUT_A, name: "Rooftop", sortOrder: 0 });

    await userEvent.click(screen.getByRole("button", { name: /New table/ }));
    d = await dialog();
    await userEvent.type(within(d).getByLabelText(/^Table code/), "T3");
    setValue(within(d).getByLabelText(/^Seats/), "6");
    await userEvent.selectOptions(within(d).getByLabelText(/^Floor/), "f1");
    await userEvent.click(within(d).getByRole("button", { name: "Create table" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].body).toEqual({ outletId: OUT_A, code: "T3", capacity: 6, floorId: "f1" });

    const table = screen.getByRole("table", { name: "Tables" });
    await userEvent.click(within(within(table).getByText("T2").closest("tr")!).getByRole("button", { name: "Edit" }));
    d = await dialog();
    await userEvent.selectOptions(within(d).getByLabelText(/^Floor/), "");
    await userEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(3));
    expect(posts()[2]).toMatchObject({ method: "PATCH", path: "/api/master/tables/t2", body: { code: "T2", capacity: 2, floorId: null } });

    await userEvent.click(within(table).getByRole("button", { name: "QR for T1" }));
    const qr = await screen.findByRole("dialog", { name: "QR — table T1" });
    expect(within(qr).getByLabelText("QR token")).toHaveTextContent("tok_1");
    await userEvent.click(within(qr).getByRole("button", { name: "Rotate token" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Rotate the QR for T1?" })).getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(posts()).toHaveLength(4));
    expect(posts()[3]).toMatchObject({ path: "/api/master/tables/t1/qr" });
  });

  it("empty and error states", async () => {
    state.routes = { "GET /api/master/tables": () => fail(403, "ForbiddenError", "Missing permission to view tables") };
    renderAs(<TablesScreen />, ["order.view"]);
    expect(await screen.findByText("Missing permission to view tables")).toBeInTheDocument();
    teardown();
    installFetch();
    state.routes = { "GET /api/master/tables": () => [], "GET /api/orders": () => ({ items: [], nextCursor: null }) };
    renderAs(<TablesScreen />, ["order.view"]);
    expect(await screen.findByText("No tables yet")).toBeInTheDocument();
  });
});
