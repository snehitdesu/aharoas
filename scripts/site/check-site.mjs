/**
 * Public website QA: for every page × viewport it records horizontal overflow,
 * broken images, console errors and CSP violations, and (optionally) saves a
 * full-page screenshot. It also checks every same-origin link it finds.
 *
 *   node scripts/site/check-site.mjs [baseUrl] [--shots=dir] [--pages=/,/download] [--sizes=390x844,1440x900]
 *
 * Exit code 1 when any problem is found.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const BASE = args.find((a) => !a.startsWith("--")) ?? "http://localhost:3100";
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const SHOTS = opt("shots");
const PAGES = (opt("pages") ?? "/,/product,/product/pos,/product/qr-ordering,/product/kitchen,/product/inventory,/product/procurement,/product/finance,/product/analytics,/product/staff,/product/integrations,/solutions,/download,/resources,/resources/release-notes,/security,/privacy,/terms").split(",");
const SIZES = (opt("sizes") ?? "390x844,393x852,430x932,768x1024,1024x768,1280x720,1366x768,1440x900,1536x864,1920x1080").split(",").map((s) => s.split("x").map(Number));
const REDUCED = args.includes("--reduced");
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
const links = new Set();
const browser = await chromium.launch();

for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: REDUCED ? "reduce" : "no-preference" });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    const res = await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 120_000 });
    if (!res || res.status() >= 400) problems.push(`${p} @${w}: HTTP ${res?.status()}`);
    // Scroll through so lazy images load and reveals run.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += Math.round(window.innerHeight * 0.7)) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 90));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const overflow = doc.scrollWidth - doc.clientWidth;
      const wide = [];
      if (overflow > 0) {
        for (const el of document.querySelectorAll("body *")) {
          const b = el.getBoundingClientRect();
          if (b.right > doc.clientWidth + 1 && getComputedStyle(el).position !== "fixed") wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
          if (wide.length > 4) break;
        }
      }
      const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src);
      const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
      const h1 = document.querySelectorAll("h1").length;
      const tiny = [...document.querySelectorAll("p, li, a, button, dd, dt, span")].filter((e) => e.offsetParent && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 12).length;
      return { overflow, wide, broken, hrefs, h1, tiny };
    });
    if (r.overflow > 0) problems.push(`${p} @${w}: horizontal overflow ${r.overflow}px (${r.wide.join(", ")})`);
    if (r.broken.length) problems.push(`${p} @${w}: broken images ${r.broken.join(", ")}`);
    if (r.h1 !== 1) problems.push(`${p} @${w}: ${r.h1} <h1> elements`);
    if (r.tiny) problems.push(`${p} @${w}: ${r.tiny} text elements under 12px`);
    if (errors.length) problems.push(`${p} @${w}: console errors: ${errors.slice(0, 3).join(" | ")}`);
    for (const href of r.hrefs) if (href && href.startsWith("/")) links.add(href.split("#")[0] || "/");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${p.replace(/\//g, "_") || "_"}@${w}.png`), fullPage: true });
    await page.close();
  }
  await ctx.close();
}

// Same-origin links: must not 404 (redirects are followed; /download/<target> may redirect off-site).
const req = await (await browser.newContext()).request;
for (const l of [...links].sort()) {
  const res = await req.get(BASE + l, { maxRedirects: 0 }).catch((e) => ({ status: () => `ERR ${e}` }));
  const s = res.status();
  if (typeof s !== "number" || s >= 400) problems.push(`link ${l}: ${s}`);
}

await browser.close();
console.log(`checked ${PAGES.length} pages × ${SIZES.length} sizes, ${links.size} internal links`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("no problems found");
