/**
 * Renders public/site/og.png (1200×630), the Open Graph / social preview image,
 * from the running website so it uses the real fonts, colours and a real
 * product screenshot.
 *
 *   node scripts/site/og-image.mjs [baseUrl]
 */
import { chromium } from "@playwright/test";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${BASE}/`, { waitUntil: "load" });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  document.querySelectorAll("nextjs-portal").forEach((e) => e.remove()); // dev-mode indicator
  const site = document.querySelector(".site");
  site.innerHTML = `
    <div style="width:1200px;height:630px;background:#1f150d;display:grid;grid-template-columns:560px 1fr;overflow:hidden;position:relative">
      <div style="padding:64px 0 64px 72px;display:flex;flex-direction:column;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:14px;color:#f7f1e6;font-family:var(--s-font-display);font-weight:700;letter-spacing:.14em;font-size:26px">
          ${document.querySelector('footer a[aria-label="RESTORA home"] svg').outerHTML.replace('class="s-logo-mark"', 'width="44" height="44"')}
          RESTORA
        </div>
        <div>
          <div style="font-family:var(--s-font-display);font-weight:600;color:#f7f1e6;font-size:76px;line-height:.98;letter-spacing:-.035em">The operating system for restaurants<span style="color:#d47552">.</span></div>
          <div style="margin-top:26px;color:#c9b9a4;font-size:22px;line-height:1.4">POS, QR ordering, kitchen, inventory, procurement, finance and analytics in one system.</div>
        </div>
      </div>
      <div style="position:relative">
        <img src="/site/screens/kitchen.webp" style="position:absolute;left:24px;top:70px;width:900px;border-radius:14px;box-shadow:0 30px 60px -20px rgba(0,0,0,.6)" />
      </div>
    </div>`;
});
await page.waitForTimeout(800);
await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 }, path: path.join(process.cwd(), "public", "site", "og.png") });
await browser.close();
console.log("wrote public/site/og.png");
