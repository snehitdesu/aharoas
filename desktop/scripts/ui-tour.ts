/**
 * Desktop UI tour: drives the real desktop app (Electron main, preload, DB tool,
 * production Next.js server) on a fresh, isolated data directory, seeds a small
 * catalog through the API, and screenshots the setup wizard, sign-in and every
 * navigable screen at common desktop window sizes. It also reports pages that
 * overflow horizontally, so layout regressions are caught without eyeballing
 * every image.
 *
 *   npm run desktop:build && npx tsx desktop/scripts/ui-tour.ts [outDir]
 *
 * The fused, packaged Aharos.exe refuses the debugging switches Playwright needs,
 * so this tour runs the unpacked build (same app code, stock Electron binary).
 */
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = path.resolve(process.argv[2] ?? path.join("e2e", ".results-desktop", "ui-tour"));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "restora ui tour-"));
const OWNER = { name: "Asha Rao", email: "asha.owner@example.com", password: "Tandoor#Night42" };
const SIZES: [number, number][] = [
  [1280, 720],
  [1366, 768],
  [1536, 864], // 1920×1080 at 125 % scaling
  [1920, 1080],
  [1024, 700], // the main window's minimum size
];
const ROUTES = [
  "/dashboard", "/pos", "/kitchen", "/captain", "/manager", "/tables", "/reservations",
  "/menu", "/menu/categories", "/menu/modifiers", "/recipes",
  "/inventory", "/inventory/ledger", "/inventory/counts", "/inventory/wastage", "/inventory/transfers", "/inventory/production", "/inventory/issues",
  "/procurement/indents", "/procurement/purchase-orders", "/procurement/grns", "/procurement/bills", "/procurement/payments",
  "/master/materials", "/master/units", "/master/vendors",
  "/finance", "/finance/payments", "/finance/expenses", "/finance/drawer", "/finance/petty-cash", "/finance/reconciliation",
  "/customers", "/customers/feedback", "/customers/segments",
  "/staff", "/staff/attendance", "/staff/leave", "/staff/tasks",
  "/analytics", "/reports", "/anomalies", "/audit", "/exports", "/notifications",
  "/settings/organization", "/settings/outlets", "/settings/departments", "/settings/printers", "/settings/integrations",
  "/account/password",
];

fs.mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const slug = (p: string) => p.replace(/^\//, "").replace(/\//g, "_") || "root";

async function windowWhere(app: ElectronApplication, pred: (url: string) => boolean, timeout = 120_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) if (!w.isClosed() && pred(w.url())) return w;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("window not found");
}

/**
 * Lays the page out at exactly w×h CSS px. The real window is resized too when it
 * fits the screen; larger sizes (e.g. 1920×1080 on a 125 %-scaled 1080p monitor,
 * which is only 1536×864 logical px) are emulated over CDP so the layout is still
 * the real renderer's.
 */
async function resize(app: ElectronApplication, page: Page, w: number, h: number) {
  await app.evaluate(({ BrowserWindow, screen }, [cw, ch]) => {
    const win = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http://localhost:"))!;
    const area = screen.getPrimaryDisplay().workAreaSize;
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(Math.min(cw, area.width - 40), Math.min(ch, area.height - 80));
  }, [w, h] as const);
  await page.setViewportSize({ width: w, height: h });
  await new Promise((r) => setTimeout(r, 250));
}

async function api(page: Page, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: (await r.json().catch(() => null)) as { data?: { id?: string } } | null };
    },
    [method, url, body] as const
  );
}

async function main() {
  const env = { ...process.env, AHAROS_DATA_DIR: DATA_DIR } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join("build", "desktop", "app")], env });
  const problems: string[] = [];
  try {
    const splash = app.windows().find((w) => w.url().endsWith("splash.html"));
    if (splash) await shot(splash, "00-splash").catch(() => undefined);

    const setup = await windowWhere(app, (u) => u.endsWith("/static/setup.html"));
    await setup.waitForLoadState();
    await shot(setup, "01-setup-choose");
    await setup.getByRole("button", { name: /Set up a new restaurant/ }).click();
    await setup.getByRole("button", { name: "Continue" }).click();
    await shot(setup, "02-setup-validation");
    await setup.getByLabel("Organization name").fill("Coders Cafe Hospitality");
    await setup.getByLabel("Outlet name").fill("Indiranagar");
    await setup.getByLabel("Outlet code").fill("blr01");
    await setup.getByRole("button", { name: "Continue" }).click();
    await setup.getByLabel("Full name").fill(OWNER.name);
    await setup.getByLabel("Email").fill(OWNER.email);
    await setup.getByLabel("Password", { exact: true }).fill(OWNER.password);
    await setup.getByLabel("Repeat password").fill(OWNER.password);
    await shot(setup, "03-setup-owner");
    await setup.getByRole("button", { name: "Create restaurant" }).click();
    await setup.getByRole("heading", { name: "RESTORA is ready" }).waitFor();
    await shot(setup, "04-setup-ready");
    await setup.getByRole("button", { name: "Open RESTORA" }).click();

    const page = await windowWhere(app, (u) => u.startsWith("http://localhost:"));
    // `where` names the current step (window size + route) so errors are attributable.
    let where = "login";
    let expectingBadLogin = false;
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // The deliberate wrong-password attempt below answers 401: expected, not an error.
      if (expectingBadLogin && /status of 401/.test(m.text())) return;
      problems.push(`console error at ${where}: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`runtime error at ${where}: ${e.message.slice(0, 160)}`));
    await page.waitForURL(/\/login/);
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    const cls = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let total = 0;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) total += e.value;
          }).observe({ type: "layout-shift", buffered: true });
          setTimeout(() => resolve(total), 500);
        })
    );
    console.log(`login cumulative layout shift: ${cls.toFixed(4)}`);
    if (cls > 0.02) problems.push(`login layout shift ${cls.toFixed(4)}`);
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    console.log(`window titles: ${JSON.stringify(title)}`);
    for (const [w, h] of SIZES) {
      await resize(app, page, w, h);
      await shot(page, `05-login-${w}x${h}`);
    }
    await resize(app, page, 1366, 768);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill("Wrong#Password1");
    expectingBadLogin = true;
    await page.getByRole("button", { name: "Sign in" }).click();
    // (Next's route announcer is also role="alert": wait for the form's own message.)
    await page.locator("form [role=alert]").waitFor();
    expectingBadLogin = false;
    await shot(page, "06-login-error");
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/dashboard$/);

    // Seed a small catalog so POS / KDS / tables show real content.
    const me = await api(page, "GET", "/api/auth/me");
    const outletId = (me.body?.data as unknown as { access: { outletIds: string[] } }).access.outletIds[0];
    const cats: Record<string, string> = {};
    for (const [i, name] of ["Starters", "Mains", "Breads", "Beverages"].entries()) cats[name] = (await api(page, "POST", "/api/menu/categories", { name, sortOrder: i + 1 })).body!.data!.id!;
    const items: [string, string, number, string, boolean][] = [
      ["Paneer Tikka", "Starters", 280, "KITCHEN", true], ["Chicken 65", "Starters", 320, "KITCHEN", false], ["Veg Spring Roll", "Starters", 220, "KITCHEN", true],
      ["Butter Chicken", "Mains", 420, "KITCHEN", false], ["Dal Makhani", "Mains", 290, "KITCHEN", true], ["Hyderabadi Biryani", "Mains", 380, "KITCHEN", false],
      ["Butter Naan", "Breads", 60, "KITCHEN", true], ["Garlic Roti", "Breads", 50, "KITCHEN", true],
      ["Masala Chai", "Beverages", 40, "BAR", true], ["Cold Coffee", "Beverages", 140, "BAR", true], ["Fresh Lime Soda", "Beverages", 90, "BAR", true],
    ];
    for (const [name, cat, price, station, isVeg] of items) await api(page, "POST", "/api/menu/items", { name, categoryId: cats[cat], price, taxPct: 5, station, isVeg });
    for (const [code, capacity] of [["T1", 2], ["T2", 4], ["T3", 4], ["T4", 6], ["T5", 2], ["T6", 8]] as const) await api(page, "POST", "/api/master/tables", { outletId, code, capacity });

    // One order in the kitchen (POS through the UI), so KDS / orders are populated.
    await page.goto(new URL("/pos", page.url()).href);
    await page.getByRole("button", { name: /^Paneer Tikka,/ }).waitFor();
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await page.getByRole("dialog", { name: "Choose table" }).getByRole("button", { name: /^Table T2,/ }).click();
    await page.getByRole("button", { name: /^Paneer Tikka,/ }).click();
    await page.getByRole("button", { name: /^Butter Chicken,/ }).click();
    await page.getByRole("button", { name: /^Butter Naan,/ }).click();
    await page.getByRole("button", { name: /^Butter Naan,/ }).click();
    await shot(page, "07-pos-cart");
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    await page.waitForTimeout(1_500);

    for (const [w, h] of SIZES) {
      await resize(app, page, w, h);
      for (const route of ROUTES) {
        where = `${w}x${h} ${route}`;
        const res = await page.goto(new URL(route, page.url()).href);
        await page.waitForLoadState("networkidle").catch(() => undefined);
        await page.waitForTimeout(200);
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
          err: /Something went wrong/i.test(document.body.innerText),
          title: document.title,
        }));
        if (res && res.status() >= 400) problems.push(`${w}x${h} ${route}: HTTP ${res.status()}`);
        if (m.sw > m.cw + 1) problems.push(`${w}x${h} ${route}: horizontal overflow ${m.sw} > ${m.cw}`);
        if (m.err) problems.push(`${w}x${h} ${route}: error boundary shown`);
        if (/aharos/i.test(m.title)) problems.push(`${w}x${h} ${route}: title "${m.title}"`);
        await shot(page, `${w}x${h}-${slug(route)}`);
      }
    }
    // Dialog examples at the smallest common size.
    await resize(app, page, 1280, 720);
    await page.goto(new URL("/pos", page.url()).href);
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await shot(page, "08-pos-table-dialog");
    await page.keyboard.press("Escape");
    const body = await page.evaluate(() => document.body.innerText);
    if (/aharos/i.test(body)) problems.push("visible text mentions Aharos on /pos");
  } finally {
    await app.close();
    if (process.env.AHAROS_KEEP_E2E_DATA) console.log(`data kept in ${DATA_DIR}`);
    else fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`screenshots → ${OUT}`);
  console.log(problems.length ? `PROBLEMS (${problems.length}):\n- ${problems.join("\n- ")}` : "no layout problems detected");
  if (problems.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
