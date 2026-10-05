/**
 * Aharos desktop app, end to end, on a fresh isolated data directory:
 *   first run (setup wizard → local DB init → bootstrap) → login → POS order →
 *   KOT → KDS lifecycle → payment → back office navigation → renderer isolation →
 *   RBAC through the desktop shell → logout → restart → data persists + auto backup.
 *
 * Runs the unpacked build (`npm run desktop:build`) or, with AHAROS_DESKTOP_EXE,
 * the packaged Aharos.exe.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.AHAROS_DESKTOP_EXE ? path.resolve(process.env.AHAROS_DESKTOP_EXE) : undefined;
// A space in the path on purpose: Windows user names often contain one.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aharos desktop e2e-"));
const OWNER = { name: "Asha Rao", email: "asha.owner@example.com", password: "Tandoor#Night42" };
const CASHIER = { name: "Ravi Kumar", email: "ravi.cashier@example.com", password: "Counter#Shift77" };

async function launch(): Promise<ElectronApplication> {
  const env = { ...process.env, AHAROS_DATA_DIR: DATA_DIR } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return EXE ? electron.launch({ executablePath: EXE, env }) : electron.launch({ args: [path.join("build", "desktop", "app")], env });
}

async function windowWhere(app: ElectronApplication, pred: (url: string) => boolean, timeout = 120_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) if (!w.isClosed() && pred(w.url())) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No window matched within ${timeout} ms; open: ${app.windows().map((w) => w.url()).join(", ")}`);
}
const isApp = (u: string) => u.startsWith("http://localhost:");

type Res<T = unknown> = { status: number; body: { ok: boolean; data: T; error?: { message: string } } | null };
/** Call the local API from inside the renderer (same origin, the window's own session cookie). */
function api<T = unknown>(page: Page, method: string, url: string, body?: unknown): Promise<Res<T>> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, url, body] as const
  ) as Promise<Res<T>>;
}

/** Electron pages have no baseURL: resolve app paths against the window's own origin. */
const goto = (page: Page, p: string) => page.goto(new URL(p, page.url()).href);

async function login(page: Page, email: string, password: string) {
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test.describe.configure({ mode: "serial" });

let orderId = "";
let outletId = "";

test.afterAll(() => {
  if (!process.env.AHAROS_KEEP_E2E_DATA) fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("first run: setup wizard initializes the local database and owner", async () => {
  const t0 = Date.now();
  const app = await launch();
  try {
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(DATA_DIR);
    const setup = await windowWhere(app, (u) => u.endsWith("/static/setup.html"));
    test.info().annotations.push({ type: "timing", description: `setup window after ${Date.now() - t0} ms` });

    // The wizard renderer is isolated: no Node, only the narrow bridge.
    expect(await setup.evaluate(() => [typeof (globalThis as { require?: unknown }).require, typeof (globalThis as { process?: unknown }).process])).toEqual(["undefined", "undefined"]);
    expect(await setup.evaluate(() => Object.keys((window as unknown as { aharosSetup: object }).aharosSetup).sort())).toEqual(["defaults", "finish", "submit"]);
    // Junk sent straight over IPC is rejected by the main-process validator.
    const junk = await setup.evaluate(() => (window as unknown as { aharosSetup: { submit(x: unknown): Promise<{ ok: boolean; fieldErrors?: object }> } }).aharosSetup.submit({ organizationName: 42, evil: true }));
    expect(junk.ok).toBe(false);
    expect(Object.keys(junk.fieldErrors ?? {})).toContain("input");

    await setup.getByRole("button", { name: /Set up a new restaurant/ }).click();
    await setup.getByLabel("Organization name").fill("Desktop Test Hospitality");
    await setup.getByLabel("Outlet name").fill("Indiranagar");
    await setup.getByLabel("Outlet code").fill("blr01");
    await expect(setup.getByLabel("Time zone")).not.toHaveValue("");
    await expect(setup.getByLabel("Currency")).toHaveValue("INR");
    await setup.getByRole("button", { name: "Continue" }).click();
    await setup.getByLabel("Full name").fill(OWNER.name);
    await setup.getByLabel("Email").fill(OWNER.email);
    // The Phase 5A password policy is enforced by bootstrapOwner.
    await setup.getByLabel("Password", { exact: true }).fill("password1");
    await setup.getByLabel("Repeat password").fill("password1");
    await setup.getByRole("button", { name: "Create restaurant" }).click();
    await expect(setup.getByRole("alert")).toBeVisible();
    expect(fs.readdirSync(DATA_DIR)).toContain("data");

    await setup.getByLabel("Password", { exact: true }).fill(OWNER.password);
    await setup.getByLabel("Repeat password").fill(OWNER.password);
    await setup.getByRole("button", { name: "Create restaurant" }).click();
    await expect(setup.getByRole("heading", { name: "RESTORA is ready" })).toBeVisible();
    await expect(setup.getByText(OWNER.email)).toBeVisible();
    await setup.getByRole("button", { name: "Open RESTORA" }).click();

    const page = await windowWhere(app, isApp);
    await expect(page).toHaveURL(/\/login/);
    await expect(page).toHaveTitle(/RESTORA/);
    test.info().annotations.push({ type: "timing", description: `login page after setup at ${Date.now() - t0} ms` });

    // Data directory layout + the per-install secret is not stored in clear text.
    for (const p of ["config.json", path.join("data", "aharos.db"), "backups", "logs"]) expect(fs.existsSync(path.join(DATA_DIR, p)), p).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
    expect(cfg.secret.enc).toBe("dpapi");
    // A second bootstrap is refused (database no longer empty).
    await login(page, OWNER.email, OWNER.password);
  } finally {
    await app.close();
  }
});

test("owner: POS order → KOT → KDS lifecycle → payment; back office pages load", async () => {
  const app = await launch();
  try {
    const page = await windowWhere(app, isApp);
    // The session cookie survived the restart.
    await page.waitForLoadState();
    if (/\/login/.test(page.url())) await login(page, OWNER.email, OWNER.password);
    const me = await api<{ access: { outletIds: string[]; roles: string[] } }>(page, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body!.data.access.roles).toContain("OWNER");
    outletId = me.body!.data.access.outletIds[0];

    // Catalog through the real API (same as the back office forms do).
    const cat = await api<{ id: string }>(page, "POST", "/api/menu/categories", { name: "Mains", sortOrder: 1 });
    expect(cat.status, JSON.stringify(cat.body)).toBe(200);
    const item = await api(page, "POST", "/api/menu/items", { name: "Desktop Thali", categoryId: cat.body!.data.id, price: 250, taxPct: 5, station: "KITCHEN", isVeg: true });
    expect(item.status, JSON.stringify(item.body)).toBe(200);
    const table = await api(page, "POST", "/api/master/tables", { outletId, code: "D1", capacity: 4 });
    expect(table.status, JSON.stringify(table.body)).toBe(200);

    // POS: dine-in order to D1, sent to the kitchen.
    await goto(page, "/pos");
    await expect(page.getByRole("button", { name: /^Desktop Thali,/ })).toBeVisible();
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    const dlg = page.getByRole("dialog", { name: "Choose table" });
    await dlg.getByRole("button", { name: /^Table D1,/ }).click();
    await expect(dlg).toBeHidden();
    await page.getByRole("button", { name: /^Desktop Thali,/ }).click();
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders");
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    orderId = ((await (await created).json()) as { data: { id: string } }).data.id;
    let o = await api<{ status: string; total: string; kots: { status: string }[] }>(page, "GET", `/api/orders/${orderId}`);
    expect(o.body!.data.status).toBe("SENT");
    expect(o.body!.data.kots).toHaveLength(1);

    // KDS: Accept → Start → Ready → Served.
    await goto(page, "/kitchen");
    const ticket = (col: string) => page.getByRole("region", { name: new RegExp(`^${col}`) }).getByRole("article", { name: /Table D1$/ });
    await expect(ticket("New")).toHaveCount(1);
    await ticket("New").getByRole("button", { name: "Accept" }).click();
    await expect(ticket("In progress")).toHaveCount(1);
    await ticket("In progress").getByRole("button", { name: "Start" }).click();
    await ticket("In progress").getByRole("button", { name: "Ready" }).click();
    await expect(ticket("Ready")).toHaveCount(1);
    await ticket("Ready").getByRole("button", { name: "Served" }).click();
    await expect(ticket("Ready")).toHaveCount(0);
    o = await api(page, "GET", `/api/orders/${orderId}`);
    expect(o.body!.data.kots.map((k) => k.status)).toEqual(["SERVED"]);

    // Payment in cash at the POS.
    await goto(page, "/pos");
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await page.getByRole("dialog", { name: "Choose table" }).getByRole("button", { name: /^Table D1,/ }).click();
    await expect(page.getByRole("region", { name: "Current order" }).getByText("Already ordered")).toBeVisible();
    await page.getByRole("button", { name: "Pay", exact: true }).click();
    const pay = page.getByRole("dialog", { name: "Take payment" });
    const due = Number(o.body!.data.total);
    await pay.getByLabel("Cash received").fill(String(due));
    await pay.getByRole("button", { name: /^Charge / }).click();
    await expect(pay.getByText("Paid in full")).toBeVisible();
    await pay.getByRole("button", { name: "Done" }).click();
    o = await api(page, "GET", `/api/orders/${orderId}`);
    expect(o.body!.data.status).toBe("PAID");

    // Back office navigation (production server, no dev compile).
    for (const p of ["/dashboard", "/tables", "/menu", "/inventory", "/procurement/indents", "/customers", "/reservations", "/staff", "/finance", "/reports", "/settings/outlets"]) {
      const res = await goto(page, p);
      expect(res?.status(), p).toBe(200);
      await expect(page.locator("main")).toBeVisible();
      await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
    }
  } finally {
    await app.close();
  }
});

test("renderer isolation: no Node, no external network, navigation locked, validated IPC", async () => {
  const app = await launch();
  try {
    const page = await windowWhere(app, isApp);
    await page.waitForLoadState();
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http://localhost:"))!;
      // Runtime API (not in every electron.d.ts release).
      const p = (w.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webSecurity: p.webSecurity };
    });
    expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
    // "localhost" resolves only to the IPv4 loopback the server is bound to (never [::1]).
    const resolved = await app.evaluate(async ({ session }) => (await session.defaultSession.resolveHost("localhost")).endpoints.map((e) => e.address));
    expect(resolved).toEqual(["127.0.0.1"]);
    expect(await page.evaluate(() => [typeof (globalThis as { require?: unknown }).require, typeof (globalThis as { process?: unknown }).process, typeof (globalThis as { module?: unknown }).module])).toEqual(["undefined", "undefined", "undefined"]);
    expect(await page.evaluate(() => Object.keys((window as unknown as { aharosDesktop: object }).aharosDesktop).sort())).toEqual(["info", "onReauthRequest", "printers", "testPrint"]);

    // External requests are blocked by the shell.
    const external = await page.evaluate(() => fetch("https://example.com/").then(() => "loaded", (e) => `blocked: ${(e as Error).name}`));
    expect(external).toMatch(/^blocked/);
    // New windows are denied; off-origin navigation does not happen.
    const before = app.windows().length;
    expect(await page.evaluate(() => window.open("https://example.com/") === null)).toBe(true);
    await page.evaluate(() => {
      window.location.href = "https://example.com/";
    });
    await page.waitForTimeout(1_000);
    expect(isApp(page.url())).toBe(true);
    expect(app.windows().length).toBe(before);

    // IPC: info + mock printer works and says it is simulated; unknown printers are refused.
    const info = await page.evaluate(() => (window as unknown as { aharosDesktop: { info(): Promise<{ version: string; desktop: boolean }> } }).aharosDesktop.info());
    expect(info.desktop).toBe(true);
    const printed = await page.evaluate(() => (window as unknown as { aharosDesktop: { testPrint(): Promise<unknown> } }).aharosDesktop.testPrint());
    expect(printed).toMatchObject({ ok: true, driver: "mock", simulated: true });
    const refused = await page.evaluate(() => (window as unknown as { aharosDesktop: { testPrint(n: string): Promise<unknown> } }).aharosDesktop.testPrint("No Such Printer 123").then(() => "printed", (e) => String(e)));
    expect(refused).toMatch(/Unknown printer/);
  } finally {
    await app.close();
  }
});

test("RBAC is enforced through the desktop shell; logout ends the session", async () => {
  const app = await launch();
  try {
    const page = await windowWhere(app, isApp);
    await page.waitForLoadState();
    if (/\/login/.test(page.url())) await login(page, OWNER.email, OWNER.password);

    // Owner creates a cashier; the cashier sets a password with the one-time link.
    // Creating staff is a sensitive action (H3): refused until the owner re-enters their password.
    const body = { name: CASHIER.name, email: CASHIER.email, role: "CASHIER", outletId };
    const unconfirmed = await api<unknown>(page, "POST", "/api/staff", body);
    expect(unconfirmed.status).toBe(403);
    expect((unconfirmed.body as unknown as { error: { code: string } }).error.code).toBe("ReauthRequiredError");
    expect((await api(page, "POST", "/api/auth/reauth", { password: OWNER.password, scope: "staff.manage" })).status).toBe(200);
    const staff = await api<{ setup: { token: string } }>(page, "POST", "/api/staff", { name: CASHIER.name, email: CASHIER.email, role: "CASHIER", outletId });
    expect(staff.status, JSON.stringify(staff.body)).toBe(200);
    const done = await api(page, "POST", "/api/auth/password/complete", { token: staff.body!.data.setup.token, password: CASHIER.password });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    await goto(page, "/dashboard");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await api(page, "GET", "/api/auth/me")).status).toBe(401);
    expect((await api(page, "GET", `/api/orders?outletId=${outletId}`)).status).toBe(401);

    await login(page, CASHIER.email, CASHIER.password);
    expect((await api(page, "GET", `/api/orders/${orderId}`)).status).toBe(200);
    // CASHIER holds menu/order/payment/customer/finance.view only (src/server/auth/rbac.ts).
    expect((await api(page, "GET", `/api/audit?outletId=${outletId}`)).status).toBe(403);
    expect((await api(page, "GET", `/api/inventory/stock?outletId=${outletId}`)).status).toBe(403);
    expect((await api(page, "POST", "/api/staff", { name: "X", email: "x@example.com", role: "OWNER" })).status).toBe(403);
    expect((await api(page, "POST", "/api/menu/items", { name: "Hack", price: 1 })).status).toBe(403);
  } finally {
    await app.close();
  }
});

test("restart: data persists, automatic backup is verified, startup is measured", async () => {
  const t0 = Date.now();
  const app = await launch();
  try {
    const page = await windowWhere(app, isApp);
    await page.waitForLoadState();
    test.info().annotations.push({ type: "timing", description: `warm start to app window ${Date.now() - t0} ms` });
    expect(app.windows().some((w) => w.url().endsWith("setup.html"))).toBe(false);
    if (/\/login/.test(page.url())) await login(page, CASHIER.email, CASHIER.password);
    const o = await api<{ status: string; items: { name: string }[] }>(page, "GET", `/api/orders/${orderId}`);
    expect(o.body!.data.status).toBe("PAID");
    expect(o.body!.data.items.map((i) => i.name)).toEqual(["Desktop Thali"]);

    const backups = path.join(DATA_DIR, "backups");
    await expect.poll(() => fs.readdirSync(backups).filter((f) => /-auto\.json$/.test(f)).length, { timeout: 60_000 }).toBeGreaterThan(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(backups, fs.readdirSync(backups).find((f) => /-auto\.json$/.test(f))!), "utf8"));
    expect(manifest.integrity).toBe("ok");
    expect(manifest.migrations.length).toBeGreaterThanOrEqual(8);
    expect(fs.existsSync(path.join(backups, manifest.file))).toBe(true);

    const startup = fs.readFileSync(path.join(DATA_DIR, "logs", "startup.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    test.info().annotations.push({ type: "startup", description: JSON.stringify(startup) });
    expect(startup.length).toBeGreaterThanOrEqual(4);
  } finally {
    await app.close();
  }
});

test("restore from backup: owner only, verified, reversible through the pre-restore backup", async () => {
  const app = await launch();
  const mainLog = () => fs.readFileSync(path.join(DATA_DIR, "logs", "main.log"), "utf8");
  // Native dialogs are stubbed (file picker → chosen backup, confirm → "Restore"); everything else is real.
  const stubDialogs = (file: string) =>
    app.evaluate(({ dialog }, f) => {
      const g = globalThis as unknown as { __dialogs: string[] };
      g.__dialogs = [];
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never;
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const o = args.find((a) => a && typeof a === "object" && "message" in (a as object)) as { message: string };
        g.__dialogs.push(o.message);
        return { response: 1, checkboxChecked: false };
      }) as never;
      dialog.showErrorBox = ((title: string, content: string) => g.__dialogs.push(`ERROR ${title}: ${content}`)) as never;
    }, file);
  const dialogs = () => app.evaluate(() => (globalThis as unknown as { __dialogs: string[] }).__dialogs);
  const clickRestore = () =>
    app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()!.items[0].submenu!.items.find((i) => i.label === "Restore from Backup…")!;
      (item as unknown as { click(): void }).click();
    });
  const restoredCount = () => mainLog().split("\n").filter((l) => l.includes("Restore completed")).length;

  try {
    const page = await windowWhere(app, isApp);
    await page.waitForLoadState();
    const backups = path.join(DATA_DIR, "backups");
    const auto = path.join(backups, fs.readdirSync(backups).find((f) => /-auto\.db$/.test(f))!);

    // 1. A cashier cannot restore.
    if (!/\/login/.test(page.url())) {
      await goto(page, "/dashboard");
      await page.getByRole("button", { name: "Sign out" }).click();
    }
    await login(page, CASHIER.email, CASHIER.password);
    await stubDialogs(auto);
    await clickRestore();
    await expect.poll(dialogs).toEqual(["Only the restaurant Owner can restore a backup."]);
    expect((await api(page, "GET", `/api/orders/${orderId}`)).status).toBe(200);

    // 2. The owner must re-enter their password (H3): cancelling the dialog restores nothing.
    await goto(page, "/dashboard");
    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page, OWNER.email, OWNER.password);
    await stubDialogs(auto);
    await clickRestore();
    const reauth = page.getByRole("dialog", { name: "Confirm your password" });
    await expect(reauth).toContainText("Confirm your password to restore a backup.");
    await reauth.getByRole("button", { name: "Cancel" }).click();
    await expect(reauth).toBeHidden();
    await expect.poll(() => mainLog().includes("Restore not authorized: cancelled")).toBe(true);
    expect(restoredCount()).toBe(0);
    expect(await dialogs()).toEqual([]); // no file picker, no confirm: nothing happened
    expect((await api(page, "GET", `/api/orders/${orderId}`)).status).toBe(200);

    // A wrong password is refused in the dialog; the right one authorizes the restore.
    await clickRestore();
    await reauth.getByLabel("Current password").fill("Wrong#Password1");
    await reauth.getByRole("button", { name: "Confirm" }).click();
    await expect(reauth.getByRole("alert")).toContainText("That password is incorrect");
    expect(restoredCount()).toBe(0);
    await reauth.getByLabel("Current password").fill(OWNER.password);
    await reauth.getByRole("button", { name: "Confirm" }).click();
    // The owner restores the automatic backup taken before the POS order existed.
    await expect.poll(restoredCount, { timeout: 60_000 }).toBe(1);
    expect((await dialogs()).filter((d) => d.startsWith("ERROR"))).toEqual([]);
    const pre = fs.readdirSync(backups).find((f) => /-pre-restore\.db$/.test(f));
    expect(pre, "pre-restore backup").toBeTruthy();
    // Sessions created after the backup are gone with it: sign in again.
    await expect(page).toHaveURL(/\/login/);
    await login(page, OWNER.email, OWNER.password);
    expect((await api(page, "GET", `/api/orders/${orderId}`)).status).toBe(404);

    // 3. Undo: restore the pre-restore backup → the order is back (a new session confirms again).
    await stubDialogs(path.join(backups, pre!));
    await clickRestore();
    await reauth.getByLabel("Current password").fill(OWNER.password);
    await reauth.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(restoredCount, { timeout: 60_000 }).toBe(2);
    await expect(page).toHaveURL(/\/login|\/dashboard/);
    if (/\/login/.test(page.url())) await login(page, OWNER.email, OWNER.password);
    const o = await api<{ status: string }>(page, "GET", `/api/orders/${orderId}`);
    expect(o.body!.data.status).toBe("PAID");
  } finally {
    await app.close();
  }
});

test("security headers / CSP in the Electron renderer: scripts, styles, fonts and API all load, zero violations", async () => {
  const app = await launch();
  try {
    const page = await windowWhere(app, isApp);
    await page.waitForLoadState();
    const cspErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy|Refused to (load|execute|connect|apply|frame)/i.test(m.text())) cspErrors.push(m.text());
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    if (/\/login/.test(page.url())) await login(page, OWNER.email, OWNER.password);

    const res = await goto(page, "/dashboard");
    const h = res!.headers();
    expect(h["content-security-policy"]).toContain("default-src 'self'");
    expect(h["content-security-policy"]).not.toContain("unsafe-eval"); // production build
    expect(h["x-frame-options"]).toBe("DENY");
    for (const p of ["/pos", "/kitchen", "/menu", "/reports", "/exports", "/dashboard"]) {
      await goto(page, p);
      await page.waitForLoadState("load");
    }
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        hydrated: Boolean(document.querySelector("main#main")) && typeof (window as unknown as { next?: unknown }).next === "object",
        stylesheets: document.styleSheets.length,
        styled: getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)",
        fontLoaded: [...document.fonts].some((f) => f.status === "loaded"),
        api: (await fetch("/api/auth/me")).status,
      };
    });
    expect(loaded).toEqual({ hydrated: true, stylesheets: expect.any(Number), styled: true, fontLoaded: true, api: 200 });
    expect(loaded.stylesheets).toBeGreaterThan(0);
    expect(cspErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    // Control: CSP is enforced in Electron too (connect-src), independently of the shell's request filter.
    await page.evaluate(() => fetch("https://example.com/").catch(() => undefined));
    await expect.poll(() => cspErrors.length).toBeGreaterThan(0);
    expect(cspErrors[0]).toMatch(/connect-src/);
  } finally {
    await app.close();
  }
});
