/**
 * Authorization through the real app: navigation is only a convenience — every
 * page gates itself and every API refuses on its own. Outlet isolation between
 * two managers, org-wide vs outlet authority on the menu, and staff
 * deactivation (sessions revoked, sign-in refused, audited).
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { statePath, outletByCode, apiCall, apiAs, sessionFor, signIn, CENTRAL } from "./helpers";

test.describe.configure({ mode: "serial" });

const nav = (page: import("@playwright/test").Page) => page.getByRole("navigation", { name: "Main" });

test.describe("authorization", () => {
  test("RBAC-001 a cashier cannot reach purchasing, inventory, recipes or admin, and sees the menu read-only — pages and APIs", async ({ browser }) => {
    const { context, page } = await sessionFor(browser, "cashier");
    const central = await outletByCode(page.request, CENTRAL);
    await page.goto("/dashboard");
    for (const hidden of ["Purchase orders", "Stock", "Recipes", "Materials", "Staff", "Audit log"]) {
      await expect(nav(page).getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
    }
    for (const path of ["/procurement/purchase-orders", "/inventory", "/recipes", "/master/materials", "/staff", "/audit"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Not available" }), path).toBeVisible();
    }
    // menu.view: the menu is readable, with no management actions.
    await page.goto("/menu");
    await expect(page.getByRole("table", { name: "Menu items" }).getByText("Veg Biryani")).toBeVisible();
    await expect(page.getByRole("button", { name: "New item" })).toHaveCount(0);
    // The APIs refuse regardless of what the UI shows.
    expect((await apiCall(page.request, "GET", `/api/procurement/purchase-orders?outletId=${central.id}`)).status).toBe(403);
    // A well-formed request (real vendor + material) is refused on authority, not validation.
    // (Services validate before authorizing, so a malformed body gets 422 — see PROJECT_STATUS security notes.)
    const owner = await apiAs("owner");
    const vendor = (await apiCall<{ items: Array<{ id: string }> }>(owner, "GET", "/api/master/vendors?take=1")).body!.data.items[0];
    const material = (await apiCall<{ items: Array<{ id: string }> }>(owner, "GET", "/api/master/materials?take=1")).body!.data.items[0];
    await owner.dispose();
    const po = await apiCall(page.request, "POST", "/api/procurement/purchase-orders", { outletId: central.id, vendorId: vendor.id, lines: [{ materialId: material.id, qty: 1, rate: 1 }] });
    expect(po.status).toBe(403);
    expect((await apiCall(page.request, "GET", "/api/master/materials")).status).toBe(403);
    expect((await apiCall(page.request, "POST", "/api/menu/items", { name: "Hack", price: 1 })).status).toBe(403);
    expect((await apiCall(page.request, "GET", "/api/audit")).status).toBe(403);
    await context.close();
  });

  test("RBAC-002 the kitchen can run the KDS but not take orders", async ({ browser }) => {
    const { context, page } = await sessionFor(browser, "kitchen");
    const central = await outletByCode(page.request, CENTRAL);
    await page.goto("/pos");
    await expect(page.getByRole("heading", { name: "POS not available" })).toBeVisible();
    const [dish] = (await apiCall<Array<{ id: string }>>(page.request, "GET", `/api/menu?outletId=${central.id}&activeOnly=true`)).body!.data;
    const res = await apiCall(page.request, "POST", "/api/orders", { outletId: central.id, channel: "TAKEAWAY", items: [{ menuItemId: dish.id, qty: 1 }] }, { "Idempotency-Key": `rbac-${Date.now()}` });
    expect(res.status).toBe(403);
    await page.goto("/kitchen");
    await expect(page.getByRole("region", { name: /^New/ })).toBeVisible();
    await context.close();
  });

  test("RBAC-003 org-wide vs outlet authority: an outlet manager may 86 an item here but not change the org menu", async ({ browser }) => {
    const { context, page } = await sessionFor(browser, "manager");
    const central = await outletByCode(page.request, CENTRAL);
    await page.goto("/menu");
    await expect(page.getByRole("table", { name: "Menu items" }).getByText("Veg Biryani")).toBeVisible();
    await expect(page.getByRole("button", { name: "New item" })).toHaveCount(0);
    await page.getByRole("table", { name: "Menu items" }).getByText("Veg Biryani").click();
    await expect(page.getByRole("button", { name: "Sold out here" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Take off menu|^Edit$/ })).toHaveCount(0);
    const itemId = page.url().split("/").pop()!;
    expect((await apiCall(page.request, "POST", `/api/menu/items/${itemId}/availability`, { active: false })).status).toBe(403);
    // ...and it cannot override another outlet's menu.
    const jubilee = await outletByCode(await apiAs("owner"), "HYDJUB");
    expect((await apiCall(page.request, "POST", `/api/menu/outlets/${jubilee.id}/items/${itemId}`, { soldOut: true })).status).toBe(403);
    expect((await apiCall(page.request, "POST", `/api/menu/outlets/${central.id}/items/${itemId}`, { soldOut: false })).status).toBe(200);
    await context.close();
  });

  test("RBAC-004 outlet isolation: the Jubilee manager sees only Jubilee and cannot read Central", async ({ page }) => {
    const owner: APIRequestContext = await apiAs("owner");
    const central = await outletByCode(owner, CENTRAL);
    await signIn(page, "manager2@demo.local");
    await expect(page.getByRole("combobox", { name: "Outlet" })).toHaveCount(0); // single outlet: no switcher
    await expect(page.getByText("Hyderabad Jubilee Hills").first()).toBeVisible();
    for (const url of [`/api/orders?outletId=${central.id}`, `/api/master/tables?outletId=${central.id}`, `/api/inventory/stock?outletId=${central.id}`, `/api/finance/expenses?outletId=${central.id}`, `/api/reservations?outletId=${central.id}`]) {
      expect((await apiCall(page.request, "GET", url)).status, url).toBe(403);
    }
    const outlets = (await apiCall<Array<{ code: string }>>(page.request, "GET", "/api/master/outlets")).body!.data.map((o) => o.code);
    expect(outlets).toEqual(["HYDJUB"]);
    // Choosing Central through the outlet cookie is re-validated server-side.
    await page.context().addCookies([{ name: "aharos_outlet", value: central.id, url: "http://localhost:3210" }]);
    await page.goto("/dashboard");
    await expect(page.getByText("Hyderabad Jubilee Hills").first()).toBeVisible();
    await expect(page.getByText("Hyderabad Central")).toHaveCount(0);
    await owner.dispose();
  });

  test("ADMIN-001 deactivating a user kills their live session, blocks sign-in and is audited", async ({ browser }) => {
    // The Jubilee manager signs in on their own device.
    const victim = await browser.newContext();
    const vp = await victim.newPage();
    await signIn(vp, "manager2@demo.local");
    expect((await vp.request.get("/api/auth/me")).status()).toBe(200);

    const { context, page } = await sessionFor(browser, "owner");
    await page.goto("/staff");
    await page.getByRole("tab", { name: "All my outlets" }).click();
    const row = page.getByRole("table", { name: "Staff" }).getByRole("row").filter({ hasText: "manager2@demo.local" });
    await row.getByRole("button", { name: "Deactivate", exact: true }).click();
    await page.getByRole("dialog", { name: "Deactivate Meera Manager?" }).getByRole("button", { name: "Deactivate" }).click();
    await expect(row.getByRole("button", { name: "Activate", exact: true })).toBeVisible();

    // Their existing session is dead and they cannot sign back in.
    expect((await vp.request.get("/api/auth/me")).status()).toBe(401);
    await vp.goto("/dashboard");
    await expect(vp).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await vp.getByLabel("Email").fill("manager2@demo.local");
    await vp.getByLabel("Password").fill("Demo@12345");
    await vp.getByRole("button", { name: "Sign in" }).click();
    await expect(vp.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
    await expect(vp).toHaveURL(/\/login/);

    // Audited, with before/after.
    await page.goto("/audit");
    await page.getByRole("tab", { name: /Organization|All my outlets/ }).click();
    await page.getByLabel("Entity type").fill("User");
    const entry = page.getByRole("table", { name: "Audit log" }).getByRole("row").filter({ hasText: "Priya Owner" }).filter({ hasText: "User" }).first();
    await entry.click();
    const detail = page.getByRole("dialog", { name: "Update · User" });
    await expect(detail.getByText('"active": false')).toBeVisible();
    await detail.getByRole("button", { name: "Close" }).first().click();

    // Restore for re-runs.
    await page.goto("/staff");
    await page.getByRole("tab", { name: "All my outlets" }).click();
    await page.getByRole("table", { name: "Staff" }).getByRole("row").filter({ hasText: "manager2@demo.local" }).getByRole("button", { name: "Activate", exact: true }).click();
    await victim.close();
    await context.close();
  });
});
