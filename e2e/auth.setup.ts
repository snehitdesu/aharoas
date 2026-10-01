/**
 * Logs each staff role in through the REAL /login page once and saves the
 * browser storage state (httpOnly session cookie) for the specs. This keeps the
 * per-account login rate limit untouched while still never bypassing auth.
 */
import { test as setup, expect } from "@playwright/test";
import { ROLES, statePath, PASSWORD } from "./helpers";

for (const [role, email] of Object.entries(ROLES)) {
  setup(`authenticate ${role}`, async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.context().storageState({ path: statePath(role as keyof typeof ROLES) });
  });
}
