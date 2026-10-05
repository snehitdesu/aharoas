/**
 * Public website interaction checks (real browser, real build):
 * mobile menu, keyboard tabs, the interactive demo end to end, platform
 * detection on /download, reduced motion and the main visitor journey.
 *
 *   node scripts/site/interactions.mjs [baseUrl]
 */
import { chromium, expect } from "@playwright/test";

const BASE = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch();
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${String(e.message ?? e).split("\n")[0]}`);
  }
}

await check("mobile menu opens, Escape closes it and returns focus", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE + "/");
  const toggle = page.getByRole("button", { name: "Open menu" });
  await toggle.click();
  const menu = page.locator("#site-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Product" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  await page.getByRole("button", { name: "Open menu" }).click();
  await menu.getByRole("link", { name: "Solutions" }).click();
  await expect(page).toHaveURL(/\/solutions$/);
  await expect(menu).toBeHidden();
  await page.close();
});

await check("skip link is the first focusable element and targets main", async () => {
  const page = await browser.newPage();
  await page.goto(BASE + "/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await page.close();
});

await check("role switcher works with the keyboard", async () => {
  const page = await browser.newPage();
  await page.goto(BASE + "/");
  const list = page.getByRole("tablist", { name: "Choose a role" });
  await list.getByRole("tab", { name: "Owner" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(list.getByRole("tab", { name: "Manager" })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("tab", { name: "Manager" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "The live day in your pocket." })).toBeVisible();
  await page.keyboard.press("End");
  await expect(list.getByRole("tab", { name: "Kitchen" })).toHaveAttribute("aria-selected", "true");
  await page.close();
});

await check("demo: guest order → kitchen → cashier → manager", async () => {
  const page = await browser.newPage();
  await page.goto(BASE + "/#demo");
  const demo = page.locator("#demo");
  await expect(demo.getByText("No real orders, transactions or payments are processed.")).toBeVisible();
  await demo.getByRole("button", { name: "Add Chicken Biryani" }).click();
  await demo.getByRole("button", { name: "Add one more Chicken Biryani" }).click();
  await demo.getByRole("button", { name: "Add Butter Naan" }).click();
  await demo.getByRole("button", { name: "Add Masala Chai" }).click();
  // 2 × 320 + 60 + 40 = 740, + 5% = 777
  await expect(demo.getByText("₹777.00")).toBeVisible();
  await demo.getByRole("button", { name: "Place order" }).click();
  await demo.getByRole("button", { name: "See the kitchen" }).click();
  // One KOT per station: Kitchen, Bakery, Bar.
  await expect(demo.getByText(/^KOT 10[123] New$/)).toHaveCount(3);
  for (const step of ["Accept", "Start", "Ready", "Served"]) await demo.getByRole("button", { name: `${step} KOT 101` }).click();
  await expect(demo.getByText(/^KOT 101 \w+$/)).toHaveCount(0);
  await demo.getByRole("tab", { name: /Cashier/ }).click();
  await demo.getByRole("group", { name: "Take payment for order 1" }).getByRole("button", { name: "UPI" }).click();
  await expect(demo.getByText("Receipt: ₹777.00 paid by UPI.")).toBeVisible();
  await demo.getByRole("tab", { name: /Manager/ }).click();
  await expect(demo.getByText("₹740.00")).toBeVisible(); // net ex tax
  await expect(demo.getByText("Chicken Biryani (2)")).toBeVisible();
  await demo.getByRole("button", { name: "Reset demo" }).click();
  await expect(demo.getByRole("tab", { name: "Guest" })).toHaveAttribute("aria-selected", "true");
  await page.close();
});

await check("download page marks the visitor's platform without hiding others", async () => {
  for (const [ua, platform, mine] of [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", "Win32", "RESTORA for Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "MacIntel", "RESTORA for macOS"],
  ]) {
    const ctx = await browser.newContext({ userAgent: ua });
    const page = await ctx.newPage();
    await page.addInitScript((pf) => {
      Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
      Object.defineProperty(navigator, "platform", { get: () => pf });
    }, platform);
    await page.goto(BASE + "/download");
    const first = page.locator("ul li").filter({ has: page.getByRole("heading", { level: 3 }) }).first();
    await expect(first.getByRole("heading", { level: 3 })).toHaveText(mine);
    await expect(first.getByText("For this device")).toBeVisible();
    for (const h of ["RESTORA for Windows", "RESTORA for macOS", "RESTORA Web"]) await expect(page.getByRole("heading", { name: h })).toBeVisible();
    await ctx.close();
  }
});

await check("download buttons: Windows links to /download/windows, macOS is not offered", async () => {
  const page = await browser.newPage();
  await page.goto(BASE + "/download");
  const win = page.getByRole("link", { name: "Download for Windows" });
  if (await win.count()) await expect(win).toHaveAttribute("href", "/download/windows");
  else await expect(page.getByText("is built but is not yet hosted for public download")).toBeVisible();
  await expect(page.getByRole("link", { name: "Apple Silicon" })).toHaveCount(0);
  await expect(page.getByText("has not yet been verified on a Mac", { exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: "Open RESTORA", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.close();
});

await check("reduced motion: all sections visible without scrolling animations", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  const hidden = await page.$$eval(".s-reveal", (els) => els.filter((e) => getComputedStyle(e).opacity !== "1").length);
  if (hidden) throw new Error(`${hidden} reveal blocks not fully visible`);
  await ctx.close();
});

await check("no JavaScript: content still visible", async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await expect(page.getByRole("heading", { name: "Understand your restaurant." })).toBeVisible();
  const hidden = await page.$$eval(".s-reveal", (els) => els.filter((e) => getComputedStyle(e).opacity !== "1").length);
  if (hidden) throw new Error(`${hidden} reveal blocks hidden without JS`);
  await ctx.close();
});

await check("journey: landing → explore → product → download", async () => {
  const page = await browser.newPage();
  await page.goto(BASE + "/");
  await page.getByRole("link", { name: "Explore RESTORA" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Everything the restaurant runs on." })).toBeVisible();
  await page.getByRole("link", { name: /Inventory/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Know what you have. Know what you use." })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Download RESTORA" }).first().click();
  await expect(page).toHaveURL(/\/download$/);
  await page.close();
});

await check("desktop build is unaffected: operator routes still require sign-in", async () => {
  const page = await browser.newPage();
  const res = await page.goto(BASE + "/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  if (!res?.ok()) throw new Error(`status ${res?.status()}`);
  await page.close();
});

await browser.close();
console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
