import { test, expect, type Browser, type Page } from "@playwright/test";
import { statePath, appAlert, confirmPasswordIfPrompted } from "./helpers";

/**
 * Account provisioning + password lifecycle through the real UI. Uses only
 * users created by this spec (never the demo accounts' passwords).
 */
const RUN = Date.now().toString(36);
const FIRST = "Masala#Dosa2026";
const SECOND = "Filter!Coffee88";
const THIRD = "Mango@Lassi4321";

async function freshPage(browser: Browser) {
  // Explicitly signed out: browser.newContext() otherwise inherits the spec's manager storageState.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, storageState: { cookies: [], origins: [] } });
  return { context, page: await context.newPage() };
}

async function signInAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function readLinkDialog(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  const link = await dialog.getByTestId("password-link").inputValue();
  expect(link).toMatch(/\/set-password#token=[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  return link;
}

async function setPasswordVia(page: Page, link: string, password: string) {
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible();
  await expect(page).toHaveURL(/\/set-password$/); // token removed from the address bar
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Repeat new password").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
}

test.describe.serial("account provisioning and password lifecycle", () => {
  test.use({ storageState: statePath("manager") });
  const email = `e2e-cashier-${RUN}@example.test`;
  let setupLink = "";

  test("PWD-001 manager adds staff and receives a one-time setup link", async ({ page }) => {
    await page.goto("/staff");
    await page.getByRole("button", { name: "Add staff" }).click();
    const dialog = page.getByRole("dialog", { name: "Add staff member" });
    await dialog.getByLabel("Name").fill("Priya E2E");
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByRole("combobox").first().selectOption("CASHIER");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await confirmPasswordIfPrompted(page, page.getByRole("dialog", { name: "Password setup link" }));
    setupLink = await readLinkDialog(page, "Password setup link");
    await expect(page.getByRole("row").filter({ hasText: email })).toBeVisible();
  });

  test("PWD-002 new staff sets a password via the link, then signs in with it; the link is single-use", async ({ browser }) => {
    const { context, page } = await freshPage(browser);
    await setPasswordVia(page, setupLink, "password123");
    await expect(appAlert(page)).toContainText("too common");

    await page.getByLabel("New password", { exact: true }).fill(FIRST);
    await page.getByLabel("Repeat new password").fill(FIRST);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Password set for ${email}` })).toBeVisible();
    expect(await page.content()).not.toContain(FIRST);

    await page.getByRole("link", { name: "Go to sign in" }).click();
    await signInAs(page, email, FIRST);
    await expect(page).toHaveURL(/\/dashboard$/);
    await context.close();

    const again = await freshPage(browser);
    await setPasswordVia(again.page, setupLink, SECOND);
    await expect(appAlert(again.page)).toContainText("invalid or has expired");
    await again.context.close();
  });

  test("PWD-003 changing the password keeps this session and signs out the others", async ({ browser }) => {
    const a = await freshPage(browser);
    const b = await freshPage(browser);
    await signInAs(a.page, email, FIRST);
    await expect(a.page).toHaveURL(/\/dashboard$/);
    await signInAs(b.page, email, FIRST);
    await expect(b.page).toHaveURL(/\/dashboard$/);

    await a.page.getByRole("link", { name: "Password", exact: true }).click();
    await expect(a.page.getByRole("heading", { name: "Change password" })).toBeVisible();
    await a.page.getByLabel("Current password").fill("Wrong#Guess123");
    await a.page.getByLabel("New password", { exact: true }).fill(SECOND);
    await a.page.getByLabel("Repeat new password").fill(SECOND);
    await a.page.getByRole("button", { name: "Change password" }).click();
    await expect(appAlert(a.page)).toContainText("Current password is incorrect");

    await a.page.getByLabel("Current password").fill(FIRST);
    await a.page.getByRole("button", { name: "Change password" }).click();
    // b's session plus the one left over from PWD-002.
    await expect(a.page.getByRole("status").filter({ hasText: /^Password changed\. Signed out 2 other sessions\.$/ })).toBeVisible();

    await a.page.goto("/dashboard");
    await expect(a.page).toHaveURL(/\/dashboard$/);
    await b.page.goto("/dashboard");
    await expect(b.page).toHaveURL(/\/login/);

    const c = await freshPage(browser);
    await signInAs(c.page, email, FIRST);
    await expect(appAlert(c.page)).toHaveText("Invalid email or password");
    await signInAs(c.page, email, SECOND);
    await expect(c.page).toHaveURL(/\/dashboard$/);
    await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
  });

  test("PWD-004 manager issues a reset link; using it replaces the password and revokes sessions", async ({ page, browser }) => {
    const staff = await freshPage(browser);
    await signInAs(staff.page, email, SECOND);
    await expect(staff.page).toHaveURL(/\/dashboard$/);

    await page.goto("/staff");
    const row = page.getByRole("row").filter({ hasText: email });
    await row.getByRole("button", { name: "Password link" }).click();
    await page.getByRole("dialog", { name: /Issue password link/ }).getByRole("button", { name: "Issue link" }).click();
    await confirmPasswordIfPrompted(page, page.getByRole("dialog", { name: "Password reset link" }));
    const resetLink = await readLinkDialog(page, "Password reset link");

    const user = await freshPage(browser);
    await setPasswordVia(user.page, resetLink, THIRD);
    await expect(user.page.getByRole("status").filter({ hasText: "Password set" })).toBeVisible();

    await staff.page.goto("/dashboard");
    await expect(staff.page).toHaveURL(/\/login/);
    await signInAs(user.page, email, SECOND);
    await expect(appAlert(user.page)).toHaveText("Invalid email or password");
    await signInAs(user.page, email, THIRD);
    await expect(user.page).toHaveURL(/\/dashboard$/);
    await Promise.all([staff.context.close(), user.context.close()]);
  });

  test("PWD-005 forgot-password gives the same answer for known and unknown emails", async ({ browser }) => {
    const messages: string[] = [];
    for (const address of [email, `nobody-${RUN}@example.test`]) {
      const { context, page } = await freshPage(browser);
      await page.goto("/login");
      await page.getByRole("link", { name: "Forgot password?" }).click();
      await page.getByLabel("Email").fill(address);
      await page.getByRole("button", { name: "Request reset link" }).click();
      const status = page.getByRole("status").filter({ hasText: "If an active account exists" });
      await expect(status).toBeVisible();
      messages.push(await status.innerText());
      await context.close();
    }
    expect(messages[0]).toBe(messages[1]);
  });

  test("PWD-006 the change-password page requires a session", async ({ browser }) => {
    const { context, page } = await freshPage(browser);
    await page.goto("/account/password");
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fpassword$/);
    await context.close();
  });
});
