import { test, expect } from "@playwright/test";
import { PASSWORD, ROLES, appAlert } from "./helpers";

test.describe("authentication", () => {
  test("LOGIN-001 manager signs in and reaches dashboard, POS and KDS", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Aharos" })).toBeVisible();
    await page.getByLabel("Email").fill(ROLES.manager);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "POS" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Kitchen" })).toBeVisible();

    // No secret material in the rendered document; the session cookie is httpOnly.
    const html = await page.content();
    expect(html).not.toContain(PASSWORD);
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "aharos_session");
    expect(session?.httpOnly).toBe(true);
    expect(html).not.toContain(session!.value);
    expect(await page.evaluate(() => document.cookie)).not.toContain("aharos_session");

    await page.goto("/pos");
    await expect(page.getByRole("region", { name: "Menu" })).toBeVisible();
    await page.goto("/kitchen");
    await expect(page.getByRole("region", { name: /^New/ })).toBeVisible();
  });

  test("LOGIN-002 wrong password stays signed out with a clear error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ROLES.manager);
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(appAlert(page)).toHaveText("Invalid email or password");
    await expect(page).toHaveURL(/\/login/);
    expect((await page.context().cookies()).some((c) => c.name === "aharos_session")).toBe(false);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  });

  test("LOGIN-003 signed-out /pos redirects to login", async ({ page }) => {
    await page.goto("/pos");
    await expect(page).toHaveURL(/\/login\?next=%2Fpos$/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("LOGIN-004 signed-out /kitchen redirects to login", async ({ page }) => {
    await page.goto("/kitchen");
    await expect(page).toHaveURL(/\/login\?next=%2Fkitchen$/);
  });

  test("LOGIN-005 after login the user returns to the page they asked for", async ({ page }) => {
    await page.goto("/kitchen");
    await page.getByLabel("Email").fill(ROLES.kitchen);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/kitchen$/);
  });
});
