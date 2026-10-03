import { test, expect, type Page } from "@playwright/test";
import { statePath, outletByCode, apiData } from "./helpers";

/** Value shown in a dashboard stat tile. */
async function tile(page: Page, label: string): Promise<string> {
  const card = page.locator("div").filter({ has: page.getByText(label, { exact: true }) }).last();
  return (await card.locator("p").nth(1).innerText()).trim();
}

async function expectedCounts(page: Page, outletId: string) {
  const orders = await apiData<{ items: unknown[]; nextCursor: string | null }>(page.request, `/api/orders?outletId=${outletId}&active=true&take=200`);
  const kots = await apiData<unknown[]>(page.request, `/api/kitchen/kots?outletId=${outletId}`);
  return { orders: String(orders.items.length), kots: String(kots.length) };
}

test.describe("dashboard", () => {
  test.describe("manager", () => {
    test.use({ storageState: statePath("manager") });

    test("DASHBOARD-001 shows real outlet data and the operator shell", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { level: 1, name: "Hyderabad Central" })).toBeVisible();
      await expect(page.getByText(/^Business day \d{4}-\d{2}-\d{2} · Asia\/Kolkata$/)).toBeVisible();
      for (const label of ["Net sales today", "Open orders", "Kitchen tickets", "Reservations today"]) {
        await expect(page.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(page.getByRole("heading", { name: "Open anomalies" })).toBeVisible();
      expect(await tile(page, "Net sales today")).toMatch(/^₹[\d,]+\.\d{2}$/);

      const outlet = await outletByCode(page.request, "HYDCEN");
      const expected = await expectedCounts(page, outlet.id);
      expect(await tile(page, "Open orders")).toBe(expected.orders);
      expect(await tile(page, "Kitchen tickets")).toBe(expected.kots);

      await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      await expect(page.getByText("Manoj Manager")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      // Single-outlet manager: outlet shown, no switcher.
      await expect(page.getByRole("combobox", { name: "Outlet" })).toHaveCount(0);
    });
  });

  test.describe("owner (multi-outlet)", () => {
    test.use({ storageState: statePath("owner") });

    test("DASHBOARD-002 switching outlets switches the data", async ({ page }) => {
      await page.goto("/dashboard");
      const central = await outletByCode(page.request, "HYDCEN");
      const jubilee = await outletByCode(page.request, "HYDJUB");
      const select = page.getByRole("combobox", { name: "Outlet" });

      await select.selectOption(central.id);
      await expect(page.getByRole("heading", { level: 1, name: "Hyderabad Central" })).toBeVisible();
      const c = await expectedCounts(page, central.id);
      expect(await tile(page, "Kitchen tickets")).toBe(c.kots);
      expect(await tile(page, "Open orders")).toBe(c.orders);

      await select.selectOption(jubilee.id);
      await expect(page.getByRole("heading", { level: 1, name: "Hyderabad Jubilee Hills" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1, name: "Hyderabad Central" })).toHaveCount(0);
      const j = await expectedCounts(page, jubilee.id);
      expect(await tile(page, "Kitchen tickets")).toBe(j.kots);
      expect(await tile(page, "Open orders")).toBe(j.orders);
      expect(c.kots === j.kots && c.orders === j.orders, "fixture outlets should differ so the switch is observable").toBe(false);

      // The choice persists across reloads (preference cookie, re-validated by the server).
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Hyderabad Jubilee Hills" })).toBeVisible();
    });
  });
});
