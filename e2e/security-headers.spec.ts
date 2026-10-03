/**
 * Security headers + CSP against the real production server (`next start`):
 *  - every page and API response carries the expected headers;
 *  - the main screens load with ZERO CSP violations. Violations are detected with
 *    the browser's own `securitypolicyviolation` event (precise, not console
 *    heuristics), plus CSP console errors and uncaught page errors. Unrelated
 *    browser noise (e.g. failed resource loads) does not count;
 *  - a background export runs end to end through the UI (queued, not generated in
 *    the request; downloadable from Exports once the runner finishes).
 */
import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { statePath } from "./helpers";

test.use({ storageState: statePath("manager") });

type Problems = { violations: string[]; console: string[]; pageErrors: string[] };

async function watch(page: Page): Promise<Problems> {
  const p: Problems = { violations: [], console: [], pageErrors: [] };
  await page.exposeFunction("__reportCspViolation", (v: string) => p.violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __reportCspViolation(v: string): void }).__reportCspViolation(`${e.violatedDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`)
    );
  });
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(m.text())) p.console.push(m.text());
  });
  page.on("pageerror", (e) => p.pageErrors.push(e.message));
  return p;
}

const EXPECTED = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-permitted-cross-domain-policies": "none",
};

test.describe("security headers and CSP (production build)", () => {
  test("SEC-HDR-001 pages and API responses carry the security headers", async ({ page, request }) => {
    for (const path of ["/login", "/dashboard", "/api/health"]) {
      const res = path.startsWith("/api") ? await request.get(path) : await page.goto(path);
      const h = res!.headers();
      expect(h, path).toMatchObject(EXPECTED);
      expect(h["permissions-policy"], path).toContain("camera=()");
      expect(h["strict-transport-security"], path).toBe("max-age=31536000; includeSubDomains"); // NODE_ENV=production
      const csp = h["content-security-policy"];
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("connect-src 'self';");
      expect(csp, path).not.toContain("unsafe-eval");
    }
    expect((await request.get("/api/health")).headers()["cache-control"]).toBe("no-store");
  });

  test("SEC-HDR-002 the main screens run with zero CSP violations or page errors", async ({ page }) => {
    const p = await watch(page);
    for (const [path, ready] of [
      ["/dashboard", () => page.locator("main#main")],
      ["/pos", () => page.getByRole("region", { name: "Current order" })],
      ["/kitchen", () => page.getByRole("region", { name: /^New/ })],
      ["/menu", () => page.locator("main#main")],
      ["/inventory", () => page.locator("main#main")],
      ["/reports", () => page.getByLabel("Report")],
      ["/exports", () => page.getByRole("table", { name: "Export jobs" })],
    ] as const) {
      await page.goto(path);
      await expect(ready()).toBeVisible();
      // Client navigation too (RSC fetch + client chunks), not only full loads.
      await page.waitForLoadState("networkidle").catch(() => undefined); // KDS polls; idle may never come
    }
    expect(p.violations, "CSP violations").toEqual([]);
    expect(p.console, "CSP console errors").toEqual([]);
    expect(p.pageErrors, "uncaught page errors").toEqual([]);

    // Control: the CSP is really enforced and the detector really fires (so the
    // zero above is meaningful) — a cross-origin fetch is blocked by connect-src.
    const outcome = await page.evaluate(() => fetch("https://example.com/").then(() => "loaded", () => "blocked"));
    expect(outcome).toBe("blocked");
    await expect.poll(() => p.violations.length).toBe(1);
    expect(p.violations[0]).toMatch(/^connect-src blocked https:\/\/example\.com/);
  });

  test("SEC-EXP-001 background export: queued by the request, completed by the runner, downloaded from Exports", async ({ page }) => {
    const p = await watch(page);
    await page.goto("/reports");
    await page.getByLabel("Report").selectOption({ label: "Orders (sales)" });
    const queued = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/exports");
    await page.getByRole("button", { name: "Export in background" }).click();
    const body = (await (await queued).json()) as { data: Record<string, unknown> };
    expect(body.data.status).toBe("PENDING"); // the request only creates the job
    expect(body.data).not.toHaveProperty("filePath"); // storage keys never leave the server
    const jobId = body.data.id as string;

    await page.goto("/exports");
    const row = page.getByRole("row").filter({ hasText: "Orders" }).first();
    await expect(async () => {
      await page.getByRole("button", { name: "Refresh exports" }).click();
      await expect(row.getByRole("button", { name: "Download" })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "Download" }).click();
    const csv = fs.readFileSync((await (await download).path())!, "utf8");
    expect(csv.split("\r\n")[0]).toBe("Date,Outlet,Order,Invoice,Channel,Source,Status,Table,Customer,Covers,Subtotal,Discount,Tax,Total,Paid");
    expect(csv.split("\r\n").length).toBeGreaterThan(2); // the demo outlet has orders
    expect((await page.request.get(`/api/exports/${jobId}`)).status()).toBe(200);
    expect(p.violations).toEqual([]);
    expect(p.pageErrors).toEqual([]);
  });
});
