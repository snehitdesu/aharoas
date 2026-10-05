/**
 * H3 step-up re-authentication in the real browser against the real server:
 * a sensitive action opens "Confirm your password"; cancel and a wrong password
 * change nothing; the right password performs the action exactly once; an
 * ended session is reported; the password never appears in a URL; and a
 * cashier gains nothing by confirming their own password.
 */
import { test, expect, type Request } from "@playwright/test";
import { apiCall, confirmPassword, reauthDialog, signIn, PASSWORD, ROLES } from "./helpers";

const RUN = Date.now().toString(36);
type Org = { name: string; legalName: string | null };
const readOrg = async (page: import("@playwright/test").Page) => (await apiCall<Org>(page.request, "GET", "/api/master/organization")).body!.data;
const isOrgPatch = (r: Request) => r.method() === "PATCH" && new URL(r.url()).pathname === "/api/master/organization";

test.describe("step-up re-authentication (H3)", () => {
  test("REAUTH-001 organization settings: cancel and wrong password change nothing; correct password saves exactly once", async ({ browser }) => {
    // A fresh owner session: no grant carried over from other specs.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const urls: string[] = [];
    const patches: Request[] = [];
    page.on("request", (r) => {
      urls.push(r.url());
      if (isOrgPatch(r)) patches.push(r);
    });
    await signIn(page, ROLES.owner);
    const before = await readOrg(page);
    const legal = `Aharos Legal ${RUN}`;

    await page.goto("/settings/organization");
    await page.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit organization" });
    await edit.getByLabel("Legal name").fill(legal);
    await edit.getByRole("button", { name: "Save" }).click();

    // 1. The dialog explains why, and Cancel leaves the data unchanged.
    const dlg = reauthDialog(page);
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("Confirm your password to change restaurant settings.");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    await expect(edit.getByRole("alert")).toContainText("Password confirmation was cancelled — nothing was changed.");
    expect((await readOrg(page)).legalName).toBe(before.legalName);

    // 2. A wrong password is refused, the field is cleared, nothing changes.
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByLabel("Current password").fill("Wrong#Password1");
    await dlg.getByRole("button", { name: "Confirm" }).click();
    await expect(dlg.getByRole("alert")).toContainText("That password is incorrect. Nothing was changed.");
    await expect(dlg.getByLabel("Current password")).toHaveValue("");
    expect((await readOrg(page)).legalName).toBe(before.legalName);
    const patchesBeforeGrant = patches.length;
    expect(patchesBeforeGrant).toBe(2); // each refused by the gate, before the action

    // 3. The right password: the original save is retried once and succeeds once.
    const saved = page.waitForResponse((r) => isOrgPatch(r.request()) && r.status() === 200);
    await confirmPassword(page);
    await saved;
    await expect(edit).toBeHidden();
    expect((await readOrg(page)).legalName).toBe(legal);
    expect(patches.length).toBe(patchesBeforeGrant + 1);
    expect(patches.at(-1)!.postData()).toBe(patches[0].postData()); // the same request, no client "reauth" flag
    expect(patches.at(-1)!.postData()).not.toMatch(/reauth|password/i);

    // The password only ever travelled in a POST body to /api/auth/reauth.
    for (const u of urls) expect(u).not.toContain(PASSWORD);

    // Put the profile back (the grant is still fresh: no prompt).
    await page.getByRole("button", { name: "Edit" }).click();
    await edit.getByLabel("Legal name").fill(before.legalName ?? "");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(dlg).toBeHidden();
    await context.close();
  });

  test("REAUTH-002 a session that ended while the dialog was open is reported; nothing changes", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signIn(page, ROLES.owner);
    const before = await readOrg(page);
    await page.goto("/settings/organization");
    await page.getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit organization" });
    await edit.getByLabel("Legal name").fill(`Ended ${RUN}`);
    await edit.getByRole("button", { name: "Save" }).click();
    const dlg = reauthDialog(page);
    await expect(dlg).toBeVisible();

    // The session is signed out elsewhere (same cookie) while the dialog is open.
    expect((await apiCall(page.request, "POST", "/api/auth/logout")).status).toBe(200);
    await dlg.getByLabel("Current password").fill(PASSWORD);
    await dlg.getByRole("button", { name: "Confirm" }).click();
    await expect(dlg).toContainText("Your session has ended. Sign in again to continue");
    await expect(dlg.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", /^\/login\?next=%2Fsettings%2Forganization$/);
    await dlg.getByRole("button", { name: "Close", exact: true }).click();
    await expect(edit.getByRole("alert")).toContainText("Your session has ended");

    const check = await browser.newContext();
    const owner = await check.newPage();
    await signIn(owner, ROLES.owner);
    expect((await readOrg(owner)).legalName).toBe(before.legalName);
    await check.close();
    await context.close();
  });

  test("REAUTH-003 a cashier who confirms their own password gains no privilege", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, ROLES.cashier);
    const before = await readOrg(page).catch(() => null);
    const grant = await apiCall(page.request, "POST", "/api/auth/reauth", { password: PASSWORD, scope: "settings.manage" });
    expect(grant.status).toBe(200);
    const res = await page.request.patch("/api/master/organization", { data: { name: "Hijacked" }, headers: { origin: new URL(page.url()).origin } });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ForbiddenError");
    if (before) expect((await readOrg(page)).name).toBe(before.name);
    await context.close();
  });
});
