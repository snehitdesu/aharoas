/**
 * Menu and recipe back office against the real POS:
 *  - an org-wide owner creates a menu item; the cashier's POS offers it
 *  - an outlet price override applies at that outlet only
 *  - "sold out here" is enforced by the server, not just hidden in the UI
 *  - a recipe is authored as a draft, costed at the outlet, approved, and then
 *    drives the item's plate cost
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, materialByName, apiData, apiCall, apiAs, openPos, CENTRAL, money } from "./helpers";

test.use({ storageState: statePath("owner") });
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const ITEM = `E2E Masala Dosa ${RUN}`;
let itemId = "";

type MenuRow = { id: string; name: string; effectivePrice: number; effectiveSoldOut: boolean; offered: boolean };

test.describe("menu and recipes", () => {
  test("MENU-001 create an item, override its price at one outlet, 86 it there (server-enforced)", async ({ page, browser }) => {
    const central = await outletByCode(page.request, CENTRAL);
    const jubilee = await outletByCode(page.request, "HYDJUB");

    await page.goto("/menu");
    await page.getByRole("button", { name: "New item" }).click();
    const dlg = page.getByRole("dialog", { name: "New menu item" });
    await dlg.getByLabel(/^Name/).fill(ITEM);
    await dlg.getByLabel(/^Category/).selectOption({ label: "Starters" });
    await dlg.getByLabel(/^Price/).fill("150");
    await dlg.getByRole("button", { name: "Create item" }).click();
    await expect(page).toHaveURL(/\/menu\/items\/[^/]+$/);
    itemId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1 })).toContainText(ITEM);

    // The cashier's POS offers it at the menu price.
    const cashier = await apiAs("cashier");
    const at = async (req: typeof cashier, outletId: string) => (await apiData<MenuRow[]>(req, `/api/menu?outletId=${outletId}`)).find((m) => m.id === itemId)!;
    expect((await at(cashier, central.id)).effectivePrice).toBe(150);
    const pos = await browser.newContext({ storageState: statePath("cashier"), viewport: { width: 1440, height: 900 } });
    const posPage = await pos.newPage();
    await openPos(posPage);
    await expect(posPage.getByRole("button", { name: new RegExp(`^${ITEM},`) })).toBeVisible();

    // Outlet price override at Central only.
    await page.getByRole("button", { name: "Set price" }).click();
    const price = page.getByRole("dialog", { name: "Price at Hyderabad Central" });
    await price.getByLabel("Outlet price (₹)").fill("140");
    await price.getByRole("button", { name: "Save price" }).click();
    await expect(page.getByText("Override").first()).toBeVisible();
    expect((await at(cashier, central.id)).effectivePrice).toBe(140);
    expect((await at(page.request, jubilee.id)).effectivePrice).toBe(150);

    // Sold out at Central: the POS marks it and the server refuses to sell it.
    await page.getByRole("button", { name: "Sold out here" }).click();
    await expect(page.getByRole("button", { name: "Back in stock here" })).toBeVisible();
    expect((await at(cashier, central.id)).effectiveSoldOut).toBe(true);
    expect((await at(page.request, jubilee.id)).effectiveSoldOut).toBe(false);
    const refused = await apiCall(cashier, "POST", "/api/orders", { outletId: central.id, channel: "TAKEAWAY", items: [{ menuItemId: itemId, qty: 1 }], submit: false }, { "Idempotency-Key": `e2e-soldout-${RUN}` });
    expect(refused.status).toBe(422);
    expect(refused.body?.error?.message).toMatch(/sold out/i);
    await posPage.reload();
    await expect(posPage.getByRole("button", { name: new RegExp(`^${ITEM},`) })).toBeDisabled();

    await page.getByRole("button", { name: "Back in stock here" }).click();
    await expect(page.getByRole("button", { name: "Sold out here" })).toBeVisible();
    expect((await at(cashier, central.id)).effectiveSoldOut).toBe(false);
    await pos.close();
    await cashier.dispose();
  });

  test("RECIPE-001 author a draft, cost it at the outlet, approve it; the item's plate cost follows", async ({ page }) => {
    expect(itemId, "MENU-001 must run first").toBeTruthy();
    const central = await outletByCode(page.request, CENTRAL);
    const potato = await materialByName(page.request, "Potato");
    const oil = await materialByName(page.request, "Refined Oil");

    await page.goto("/recipes");
    await page.getByRole("button", { name: "New recipe" }).click();
    const dlg = page.getByRole("dialog", { name: "New recipe" });
    await dlg.getByLabel(/^Name/).fill(ITEM);
    await dlg.getByLabel(/^Menu item/).selectOption({ label: ITEM });
    await dlg.getByRole("button", { name: "Create draft" }).click();
    await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
    const recipeId = page.url().split("/").pop()!;

    for (const [m, qty] of [[potato.id, "0.15"], [oil.id, "0.02"]] as const) {
      await page.getByRole("button", { name: "Add line" }).click();
      const line = page.getByRole("dialog", { name: "Add line to v1" });
      await line.getByLabel("Material", { exact: true }).selectOption(m);
      await line.getByLabel(/^Quantity/).fill(qty);
      await line.getByRole("button", { name: "Add line" }).click();
      await expect(line).toBeHidden();
    }
    const lines = page.getByRole("table", { name: "Recipe lines" });
    await expect(lines.getByText("0.15 kg")).toBeVisible();
    await expect(lines.getByText("0.02 L")).toBeVisible();

    // Costing is the server's: the card shows exactly the API's total.
    const recipe = await apiData<{ versions: Array<{ id: string; status: string }> }>(page.request, `/api/recipes/${recipeId}`);
    const versionId = recipe.versions[0].id;
    const cost = await apiData<{ total: number }>(page.request, `/api/recipes/versions/${versionId}/cost?outletId=${central.id}`);
    expect(cost.total).toBeGreaterThan(0);
    await expect(page.getByRole("table", { name: "Cost breakdown" })).toBeVisible();
    await expect(page.getByText(money(cost.total)).first()).toBeVisible();

    // No approved recipe yet -> the item has no plate cost.
    expect((await apiCall(page.request, "GET", `/api/recipes/menu-items/${itemId}/margin?outletId=${central.id}`)).status).toBe(422);

    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("dialog", { name: "Approve version 1?" }).getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add line/ })).toHaveCount(0); // approved = immutable
    expect((await apiData<{ versions: Array<{ status: string }> }>(page.request, `/api/recipes/${recipeId}`)).versions[0].status).toBe("APPROVED");

    const margin = await apiData<{ cost: number; price: number; foodCostPct: number }>(page.request, `/api/recipes/menu-items/${itemId}/margin?outletId=${central.id}`);
    expect(margin.cost).toBeCloseTo(cost.total, 2);
    await page.goto(`/menu/items/${itemId}`);
    await expect(page.getByText(`${margin.foodCostPct.toFixed(1)}%`)).toBeVisible();
  });
});
