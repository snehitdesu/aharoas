/**
 * Session lifecycle through the real browser: sign-out revokes the session on
 * the server (a copied cookie stops working), and an expired session is
 * rejected by the pages and the API. Uses dedicated accounts so the shared
 * role sessions (e2e/.auth) are never revoked.
 */
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { e2eDb, signIn } from "./helpers";

const cookieOf = async (page: import("@playwright/test").Page) => (await page.context().cookies()).find((c) => c.name === "aharos_session");

test.describe("sessions", () => {
  test("SESSION-001 sign out revokes the session server-side; a replayed cookie is rejected", async ({ page, browser }) => {
    await signIn(page, "admin@demo.local");
    const before = await cookieOf(page);
    expect(before?.value).toBeTruthy();
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(await cookieOf(page)).toBeUndefined();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);

    // An attacker who copied the cookie before sign-out gets nothing.
    const replay = await browser.newContext();
    await replay.addCookies([{ ...before!, expires: -1 }]);
    const p = await replay.newPage();
    expect((await p.request.get("/api/auth/me")).status()).toBe(401);
    expect((await p.request.get("/api/orders?outletId=x")).status()).toBe(401);
    await p.goto("/dashboard");
    await expect(p).toHaveURL(/\/login\?next=%2Fdashboard$/);
    await replay.close();

    const db = await e2eDb();
    const row = await db.session.findUnique({ where: { tokenHash: createHash("sha256").update(before!.value).digest("hex") } });
    expect(row?.revokedAt).not.toBeNull();
    await db.$disconnect();
  });

  test("SESSION-002 an expired session is rejected by pages and API and the user must sign in again", async ({ page }) => {
    await signIn(page, "area@demo.local");
    const cookie = await cookieOf(page);
    expect((await page.request.get("/api/auth/me")).status()).toBe(200);

    // Simulate the TTL elapsing for this one session.
    const db = await e2eDb();
    await db.session.update({ where: { tokenHash: createHash("sha256").update(cookie!.value).digest("hex") }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await db.$disconnect();

    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(401);
    await page.goto("/finance");
    await expect(page).toHaveURL(/\/login\?next=%2Ffinance$/);
    await page.getByLabel("Email").fill("area@demo.local");
    await page.getByLabel("Password").fill("Demo@12345");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/finance$/);
  });

  test("SESSION-003 an unknown account gets the same generic error as a wrong password (no enumeration)", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("nobody@demo.local");
    await page.getByLabel("Password").fill("Demo@12345");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveText("Invalid email or password");
  });

  test("SESSION-004 a crafted post-login destination cannot send the user off-site", async ({ page }) => {
    // "/\evil.example" is read by browsers as "//evil.example" (protocol-relative).
    await page.goto("/login?next=%2F%5Cevil.example%2Fphish");
    await page.getByLabel("Email").fill("store@demo.local");
    await page.getByLabel("Password").fill("Demo@12345");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("http://localhost:3210/dashboard");
    // Already signed in: the server-side redirect on /login is guarded the same way.
    await page.goto("/login?next=%2F%5Cevil.example");
    await expect(page).toHaveURL("http://localhost:3210/dashboard");
  });
});
