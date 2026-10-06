/**
 * RESTORA desktop with the real Coders' Cafe menu, end to end, on fresh isolated
 * data directories:
 *
 *  STARTER-001 existing install, empty menu (the state an install set up before
 *              the starter existed is in): the owner imports the Coders' Cafe
 *              menu from Menu → Items; nothing that existed is changed.
 *  STARTER-002 first run with "Start with the Coders' Cafe menu": 8 categories,
 *              64 items, sizes, pizza add-ons, tables T01–T10 with QR codes;
 *              owner creates manager / chef / cashier through the real staff
 *              flow; Table 07's QR → real menu → cart → order (guest phone) →
 *              manager accepts → KOT → chef cooks → cashier takes cash → bill,
 *              finance, analytics, audit: exactly one of each; RBAC per role.
 *
 * The owner works in the Electron window; the other devices are Chromium
 * browsers pointed at the desktop app's own loopback server (the same machine,
 * which is the only place a desktop QR resolves: the server binds 127.0.0.1).
 */
import { test, expect, chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.AHAROS_DESKTOP_EXE ? path.resolve(process.env.AHAROS_DESKTOP_EXE) : undefined;
const OWNER = { name: "Cafe Owner", email: "owner@coderscafe.example", password: "Coders#Cafe2026" };
const STAFF = {
  manager: { name: "Cafe Manager", email: "manager@coderscafe.example", password: "Floor#Lead2026x", role: "MANAGER" },
  chef: { name: "Cafe Chef", email: "chef@coderscafe.example", password: "Tandoor#Fire26", role: "KITCHEN" },
  cashier: { name: "Cafe Cashier", email: "cashier@coderscafe.example", password: "Till#Drawer26x", role: "CASHIER" },
} as const;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dirs: string[] = [];

async function launch(dataDir: string): Promise<ElectronApplication> {
  const env = { ...process.env, AHAROS_DATA_DIR: dataDir } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return EXE ? electron.launch({ executablePath: EXE, env }) : electron.launch({ args: [path.join("build", "desktop", "app")], env });
}
async function windowWhere(app: ElectronApplication, pred: (url: string) => boolean, timeout = 120_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) if (!w.isClosed() && pred(w.url())) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No window matched within ${timeout} ms`);
}
const isApp = (u: string) => u.startsWith("http://localhost:");
type Res<T = unknown> = { status: number; body: { ok: boolean; data: T; error?: { code: string; message: string } } | null };
function api<T = unknown>(page: Page, method: string, url: string, body?: unknown): Promise<Res<T>> {
  return page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u as string, { method: m as string, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, url, body] as const
  ) as Promise<Res<T>>;
}
async function ok<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  const r = await api<T>(page, method, url, body);
  expect(r.status, `${method} ${url}: ${JSON.stringify(r.body?.error)}`).toBe(200);
  return r.body!.data;
}
const goto = (page: Page, p: string) => page.goto(new URL(p, page.url()).href);

async function login(page: Page, email: string, password: string) {
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** First-run wizard, as an operator fills it. */
async function setUp(app: ElectronApplication, starter: boolean): Promise<Page> {
  const setup = await windowWhere(app, (u) => u.endsWith("/static/setup.html"));
  await setup.getByRole("button", { name: /Set up a new restaurant/ }).click();
  await setup.getByLabel("Organization name").fill("Coders' Cafe");
  await setup.getByLabel("Outlet name").fill("Coders' Cafe");
  await setup.getByLabel("Outlet code").fill("cc01");
  const box = setup.getByRole("checkbox", { name: /Start with the Coders' Cafe menu/ });
  await expect(box).not.toBeChecked(); // an operator's own restaurant starts empty unless they opt in
  if (starter) await box.check();
  await setup.getByRole("button", { name: "Continue" }).click();
  await setup.getByLabel("Full name").fill(OWNER.name);
  await setup.getByLabel("Email").fill(OWNER.email);
  await setup.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await setup.getByLabel("Repeat password").fill(OWNER.password);
  await setup.getByRole("button", { name: "Create restaurant" }).click();
  await expect(setup.getByRole("heading", { name: "RESTORA is ready" })).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByRole("alert")).toBeHidden(); // no "menu was not imported" warning
  await setup.getByRole("button", { name: "Open RESTORA" }).click();
  const page = await windowWhere(app, isApp);
  await login(page, OWNER.email, OWNER.password);
  return page;
}

type MenuRow = { id: string; name: string; variants: unknown[]; modifierGroups: Array<{ group: { name: string } }> };
async function expectCodersCafeMenu(page: Page) {
  const items = await ok<MenuRow[]>(page, "GET", "/api/menu");
  expect(items).toHaveLength(64);
  expect((await ok<unknown[]>(page, "GET", "/api/menu/categories")).length).toBe(8);
  expect(items.filter((i) => i.variants.length).length).toBeGreaterThan(0);
  expect(items.some((i) => i.modifierGroups.length > 0)).toBe(true);
  for (const n of ["Loaded Veg Nachos", "Veg Arrabita Penne"]) expect(items.map((i) => i.name)).toContain(n);
  await goto(page, "/menu");
  await expect(page.getByRole("table", { name: "Menu items" }).getByText("Loaded Veg Nachos")).toBeVisible();
  await expect(page.getByRole("button", { name: /Import the Coders' Cafe menu/ })).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });
test.afterAll(() => {
  if (!process.env.AHAROS_KEEP_E2E_DATA) for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("STARTER-001 existing install with an empty menu: the owner imports the Coders' Cafe menu; existing data is kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aharos starter existing-"));
  dirs.push(dir);
  const app = await launch(dir);
  try {
    const page = await setUp(app, false);
    const outletId = (await ok<{ access: { outletIds: string[] } }>(page, "GET", "/api/auth/me")).access.outletIds[0];
    await ok(page, "POST", "/api/master/tables", { outletId, code: "E5", capacity: 2 }); // like the reported install

    await goto(page, "/menu");
    await expect(page.getByText("No menu items yet")).toBeVisible();
    await page.getByRole("button", { name: "Import the Coders' Cafe menu" }).click();
    await page.getByRole("dialog", { name: /Import the Coders' Cafe menu/ }).getByRole("button", { name: "Import menu" }).click();
    await expect(page.getByRole("table", { name: "Menu items" }).getByText("Loaded Veg Nachos")).toBeVisible();
    await expectCodersCafeMenu(page);

    const tables = await ok<Array<{ code: string; guestUrl: string | null }>>(page, "GET", `/api/master/tables?outletId=${outletId}`);
    expect(tables.map((t) => t.code).sort()).toEqual(["E5", "T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"]);
    // A second import is refused: it never duplicates a menu.
    const again = await api(page, "POST", "/api/menu/starter", { outletId });
    expect(again.status).toBe(409);
    expect((await ok<unknown[]>(page, "GET", "/api/menu")).length).toBe(64);
  } finally {
    await app.close();
  }
});

test("STARTER-002 first run with the Coders' Cafe menu: Table 07 QR → order → KOT → kitchen → cash → bill, finance, analytics; every role", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aharos starter fresh-"));
  dirs.push(dir);
  const app = await launch(dir);
  let browser: Browser | undefined;
  try {
    const owner = await setUp(app, true);
    await expectCodersCafeMenu(owner);
    const origin = new URL(owner.url()).origin;
    const outletId = (await ok<{ access: { outletIds: string[] } }>(owner, "GET", "/api/auth/me")).access.outletIds[0];

    // Tables T01–T10, each with its own QR; T07's link opens on this computer.
    const tables = await ok<Array<{ code: string; qrToken: string | null }>>(owner, "GET", `/api/master/tables?outletId=${outletId}`);
    expect(tables.map((t) => t.code).sort()).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10"]);
    expect(new Set(tables.map((t) => t.qrToken)).size).toBe(10); // each table its own QR
    const t07 = tables.find((t) => t.code === "T07")!;
    expect(t07.qrToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // No PUBLIC_BASE_URL on the desktop: the link is this computer's address, and the screen says phones cannot open it.
    await goto(owner, "/tables");
    await owner.getByRole("button", { name: "QR for T07" }).click();
    const qr = owner.getByRole("dialog", { name: /QR — table T07/ });
    await expect(qr.getByRole("img", { name: "QR code for table T07" })).toBeVisible();
    const t07Link = (await qr.getByLabel("Guest ordering link").textContent())!.trim();
    expect(t07Link).toBe(`${origin}/t/${t07.qrToken}`);
    await expect(qr.getByText(/guests' phones cannot open it/)).toBeVisible();
    await qr.getByRole("button", { name: "Close" }).first().click();

    // Staff through the real flow: step-up confirmation, one-time setup link, own password.
    expect((await api(owner, "POST", "/api/auth/reauth", { password: OWNER.password, scope: "staff.manage" })).status).toBe(200);
    for (const s of Object.values(STAFF)) {
      const created = await ok<{ setup: { token: string } }>(owner, "POST", "/api/staff", { name: s.name, email: s.email, role: s.role, outletId });
      await ok(owner, "POST", "/api/auth/password/complete", { token: created.setup.token, password: s.password });
    }

    browser = await chromium.launch();
    const device = async (who: keyof typeof STAFF) => {
      const ctx = await browser!.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.goto("/login");
      await login(p, STAFF[who].email, STAFF[who].password);
      return p;
    };
    const manager = await device("manager");
    const chef = await device("chef");
    const cashier = await device("cashier");

    // RBAC per role (server-side, not just hidden buttons).
    expect((await api(chef, "GET", `/api/finance/payments?outletId=${outletId}`)).status).toBe(403);
    expect((await api(cashier, "POST", "/api/menu/starter", { outletId })).status).toBe(403);
    expect((await api(cashier, "POST", "/api/menu/items", { name: "Hack", price: 1 })).status).toBe(403);
    expect((await api(cashier, "GET", `/api/audit?outletId=${outletId}`)).status).toBe(403);
    expect((await api(manager, "GET", `/api/orders?outletId=${outletId}`)).status).toBe(200);
    expect((await api(manager, "POST", "/api/staff", { name: "X", email: "x@example.com", role: "OWNER" })).status).toBe(403);
    for (const [p, path] of [[chef, "/kitchen"], [cashier, "/pos"], [manager, "/pos"]] as const) {
      expect((await p.goto(path))?.status(), path).toBe(200);
      await expect(p.getByText(/Something went wrong/i)).toHaveCount(0);
    }

    const before = await ok<{ orders: number; revenue: number }>(owner, "GET", `/api/analytics/sales-summary?outletId=${outletId}`);

    // Customer's phone: scan Table 07 → real menu → cart → order (pay at the counter).
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const guest = await phone.newPage();
    await guest.goto(t07Link);
    await expect(guest.getByLabel("Table T07")).toBeVisible();
    await guest.getByRole("button", { name: "Add Loaded Veg Nachos" }).click();
    await guest.getByRole("button", { name: "Add Veg Arrabita Penne" }).click();
    await guest.getByRole("button", { name: /View cart/ }).click();
    const cart = guest.getByRole("dialog", { name: "Your order" });
    await expect(cart.getByLabel("Estimated total")).toContainText(inr(351.75)); // 150 + 185 = 335 + 5% GST
    await cart.getByRole("button", { name: "Place order" }).click();
    await guest.waitForURL(/\/o\/[^/#]+#k=/);
    const orderId = decodeURIComponent(new URL(guest.url()).pathname.split("/").pop()!);
    const ref = orderId.slice(-6).toUpperCase();
    await expect(guest.getByTestId("order-stage")).toHaveText("Waiting for the restaurant to accept");

    // Manager accepts the QR order at the POS → one KOT.
    await manager.goto("/pos");
    const openOrders = manager.getByRole("button", { name: /^Open orders, \d+ new QR order/ });
    await expect(openOrders).toBeVisible({ timeout: 20_000 });
    await openOrders.click();
    await manager.getByRole("dialog", { name: "Open orders" }).getByRole("button", { name: new RegExp(`#${ref}.*Table T07`) }).click();
    await manager.getByRole("button", { name: "Send to kitchen" }).click();
    await expect(guest.getByTestId("order-stage")).toHaveText("Sent to the kitchen", { timeout: 20_000 });

    // Chef: KDS accept → start → ready → served.
    await chef.goto("/kitchen");
    const ticket = chef.getByRole("article", { name: /Table T07 · QR$/ });
    await expect(ticket).toContainText("Loaded Veg Nachos");
    await expect(ticket).toContainText("Veg Arrabita Penne");
    for (const b of ["Accept", "Start", "Ready", "Served"]) await ticket.getByRole("button", { name: b }).click();
    await expect(ticket).toHaveCount(0);

    // The chef cannot take money for it (server-side permission), even for a real order.
    expect((await api(chef, "POST", "/api/payments", { orderId, method: "CASH", amount: 351.75 })).status).toBe(403);

    // Cashier takes the cash at the POS.
    await cashier.goto("/pos");
    await cashier.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await cashier.getByRole("dialog", { name: "Choose table" }).getByRole("button", { name: /^Table T07,/ }).click();
    await cashier.getByRole("button", { name: "Pay", exact: true }).click();
    const pay = cashier.getByRole("dialog", { name: "Take payment" });
    await pay.getByLabel("Cash received").fill("400");
    await expect(pay.getByText(`Change to return: ${inr(48.25)}`)).toBeVisible();
    await pay.getByRole("button", { name: `Charge ${inr(351.75)}` }).click();
    await expect(pay.getByText("Paid in full")).toBeVisible();
    await pay.getByRole("button", { name: "Done" }).click();
    await expect(guest.getByTestId("bill-payment-status")).toHaveText("Paid", { timeout: 20_000 });

    // Exactly one order / payment / KOT / invoice / finance row; analytics moved by the total; audited.
    const o = await ok<{ status: string; total: string; invoiceNo: string | null; payments: Array<{ method: string; status: string; amount: string }>; kots: unknown[] }>(owner, "GET", `/api/orders/${orderId}`);
    expect(o.status).toBe("PAID");
    expect(Number(o.total)).toBe(351.75);
    expect(o.payments.filter((p) => p.status === "SUCCESS").map((p) => [p.method, Number(p.amount)])).toEqual([["CASH", 351.75]]);
    expect(o.kots).toHaveLength(1);
    expect(o.invoiceNo).toBeTruthy();
    const fin = await ok<{ items: Array<{ status: string; amount: number; method: string }> }>(owner, "GET", `/api/finance/payments?outletId=${outletId}&orderId=${orderId}`);
    expect(fin.items.filter((p) => p.status === "SUCCESS").map((p) => [p.method, p.amount])).toEqual([["CASH", 351.75]]);
    const after = await ok<{ orders: number; revenue: number }>(owner, "GET", `/api/analytics/sales-summary?outletId=${outletId}`);
    expect(after.orders - before.orders).toBe(1);
    expect(Math.round((after.revenue - before.revenue) * 100) / 100).toBe(351.75);
    expect((await ok<{ items: unknown[] }>(owner, "GET", `/api/audit?entityType=Order&entityId=${orderId}`)).items.length).toBeGreaterThanOrEqual(1);
    // A second charge on the settled order is refused by the server.
    expect((await api(cashier, "POST", "/api/payments", { orderId, method: "CASH", amount: 351.75 })).status).toBe(422);

    // Owner back office on the real data.
    for (const p of ["/dashboard", "/pos", "/kitchen", "/menu", "/tables", "/finance", "/analytics", "/reports"]) {
      expect((await goto(owner, p))?.status(), p).toBe(200);
      await expect(owner.getByText(/Something went wrong/i)).toHaveCount(0);
    }
  } finally {
    await browser?.close();
    await app.close();
  }
});
