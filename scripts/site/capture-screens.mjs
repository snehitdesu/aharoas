/**
 * Captures the real RESTORA screens used on the public website.
 *
 * Runs against a production server on a DISPOSABLE demo database prepared with
 * `prisma/seed.ts` + `scripts/site/demo-state.ts` (see docs/website.md). Every
 * image is the actual application UI with sample data; nothing is mocked up.
 *
 *   node scripts/site/capture-screens.mjs [baseUrl] [onlyName,...]
 *
 * Writes WebP files to public/site/screens/ and their pixel sizes to
 * src/site/screens-meta.json (PNG intermediates are not kept).
 */
import { chromium } from "@playwright/test";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const ONLY = (process.argv[3] ?? "").split(",").filter(Boolean);
const OUT = path.join(process.cwd(), "public", "site", "screens");
const PASSWORD = "Demo@12345"; // prisma/seed.ts demo password (disposable database only)
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

/** @type {{ name: string, role?: string, device: typeof DESKTOP | typeof PHONE, path: string | ((ctx: any) => Promise<string>), act?: (page: import("@playwright/test").Page) => Promise<void>, width?: number }[]} */
const SHOTS = [
  { name: "dashboard", role: "owner", device: DESKTOP, path: "/dashboard" },
  { name: "pos", role: "cashier", device: DESKTOP, path: "/pos", act: async (page) => {
    await page.getByRole("button", { name: /Chicken Biryani/ }).first().waitFor();
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await page.getByRole("dialog", { name: "Choose table" }).getByRole("button", { name: /^Table F2,/ }).click();
    await page.waitForTimeout(400);
    for (const n of ["Butter Chicken", "Butter Naan", "Butter Naan", "Paneer Tikka", "Jeera Rice", "Fresh Lime Soda", "Fresh Lime Soda"]) {
      await page.getByRole("button", { name: new RegExp(`^${n},`) }).first().click();
      await page.waitForTimeout(150);
    }
  } },
  { name: "pos-tables", role: "cashier", device: DESKTOP, path: "/pos", act: async (page) => {
    await page.getByRole("button", { name: /Chicken Biryani/ }).first().waitFor();
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await page.getByRole("dialog", { name: "Choose table" }).waitFor();
  } },
  // Just the floor plan (the table dialog), without the dimmed POS behind it.
  { name: "pos-floor", role: "cashier", device: DESKTOP, path: "/pos", element: (page) => page.getByRole("dialog", { name: "Choose table" }), act: async (page) => {
    await page.getByRole("button", { name: /Chicken Biryani/ }).first().waitFor();
    await page.getByRole("button", { name: /Choose table|^Table / }).first().click();
    await page.getByRole("dialog", { name: "Choose table" }).waitFor();
    await page.waitForTimeout(500);
  } },
  { name: "kitchen", role: "kitchen", device: DESKTOP, path: "/kitchen" },
  { name: "tables", role: "manager", device: DESKTOP, path: "/tables" },
  { name: "inventory", role: "owner", device: DESKTOP, path: "/inventory" },
  { name: "ledger", role: "owner", device: DESKTOP, path: "/inventory/ledger" },
  { name: "wastage", role: "owner", device: DESKTOP, path: "/inventory/wastage" },
  { name: "recipes", role: "owner", device: DESKTOP, path: "/recipes" },
  { name: "procurement-po", role: "owner", device: DESKTOP, path: "/procurement/purchase-orders" },
  { name: "procurement-grn", role: "owner", device: DESKTOP, path: "/procurement/grns" },
  { name: "procurement-bills", role: "owner", device: DESKTOP, path: "/procurement/bills" },
  { name: "procurement-payments", role: "owner", device: DESKTOP, path: "/procurement/payments" },
  { name: "finance", role: "owner", device: DESKTOP, path: "/finance" },
  { name: "finance-drawer", role: "owner", device: DESKTOP, path: "/finance/drawer" },
  { name: "finance-expenses", role: "owner", device: DESKTOP, path: "/finance/expenses" },
  { name: "analytics", role: "owner", device: DESKTOP, path: "/analytics" },
  { name: "analytics-sales", role: "owner", device: DESKTOP, path: "/analytics", act: async (page) => { await page.getByRole("tab", { name: "Sales" }).click(); } },
  { name: "analytics-menu", role: "owner", device: DESKTOP, path: "/analytics", act: async (page) => { await page.getByRole("tab", { name: "Menu" }).click(); } },
  { name: "reports", role: "owner", device: DESKTOP, path: "/reports" },
  { name: "staff", role: "owner", device: DESKTOP, path: "/staff" },
  { name: "integrations", role: "owner", device: DESKTOP, path: "/settings/integrations" },
  { name: "printers", role: "owner", device: DESKTOP, path: "/settings/printers" },
  { name: "captain", role: "captain", device: PHONE, path: "/captain" },
  { name: "manager", role: "manager", device: PHONE, path: "/manager" },
  { name: "guest-menu", device: PHONE, path: "/t/site-demo-table-qr" },
  { name: "guest-cart", device: PHONE, path: "/t/site-demo-table-qr", act: async (page) => {
    for (const i of [3, 7, 6]) {
      await page.getByRole("button", { name: /^Add/ }).nth(i).click();
      await page.waitForTimeout(250);
    }
  } },
];

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Wait for the app's loading states to resolve.
  for (let i = 0; i < 40; i++) {
    const busy = await page.getByText(/^Loading/).count();
    const dots = await page.locator("[aria-busy='true']").count();
    if (!busy && !dots) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(600);
}

const META = path.join(process.cwd(), "src", "site", "screens-meta.json");
const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, "utf8")) : {};
const browser = await chromium.launch();
const states = {};
async function contextFor(role, device) {
  const ctx = await browser.newContext({ ...device, baseURL: BASE, reducedMotion: "reduce", locale: "en-IN", timezoneId: "Asia/Kolkata" });
  if (role) {
    if (!states[role]) {
      const page = await ctx.newPage();
      await page.goto("/login");
      await page.getByLabel("Email").fill(`${role}@demo.local`);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 });
      states[role] = await ctx.storageState();
      await page.close();
    } else {
      await ctx.addCookies(states[role].cookies);
    }
  }
  return ctx;
}

for (const s of SHOTS) {
  if (ONLY.length && !ONLY.includes(s.name)) continue;
  const ctx = await contextFor(s.role, s.device);
  const page = await ctx.newPage();
  try {
    await page.goto(typeof s.path === "string" ? s.path : await s.path(ctx), { timeout: 60_000 });
    await settle(page);
    if (s.act) { await s.act(page); await settle(page); }
    const png = s.element ? await s.element(page).screenshot() : await page.screenshot();
    const info = await sharp(png).webp({ quality: 84, effort: 5 }).toFile(path.join(OUT, `${s.name}.webp`));
    meta[s.name] = { w: info.width, h: info.height };
    console.log(`ok   ${s.name}`);
  } catch (e) {
    console.log(`FAIL ${s.name}: ${String(e).split("\n")[0]}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(META, JSON.stringify(Object.fromEntries(Object.entries(meta).sort()), null, 2) + "\n");
