/**
 * Every back-office page under src/app/(app) is gated by the nav rule that
 * owns its path (see lib/auth/gate.tsx). This walks the real page files and
 * checks that (1) each one calls `gated(<its own path>)`, and (2) that path
 * resolves to a built (non-planned) nav entry — so no screen silently ends up
 * with "no permission required", and nav never links to a missing page.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NAV_ITEMS, navFor } from "@/lib/nav";

const root = path.join(process.cwd(), "src", "app", "(app)");

function pages(dir: string, segs: string[] = []): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...pages(path.join(dir, e.name), [...segs, e.name]));
    else if (e.name === "page.tsx") out.push({ route: "/" + segs.join("/"), file: path.join(dir, e.name) });
  }
  return out;
}

const all = pages(root);
const example = (route: string) => route.replace(/\[(\w+)\]/g, "x123");

describe("route gating", () => {
  it("finds the back-office pages", () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it.each(all.filter((p) => p.route !== "/dashboard"))("$route is gated on its own path by a built nav rule", ({ route, file }) => {
    const src = fs.readFileSync(file, "utf8");
    const staticPart = route.replace(/\/\[\w+\]$/, "");
    expect(src.includes(`gated("${staticPart}`) || src.includes("gated(`" + staticPart), `${file} must call gated() with its own path`).toBe(true);
    const owner = navFor(example(route));
    expect(owner, `no nav rule owns ${route}`).toBeDefined();
    expect(owner!.planned).toBeUndefined();
  });

  it("every visible nav entry has a page", () => {
    // POS and KDS are full-screen surfaces outside the (app) shell group.
    const standalone = ["pos", "kitchen"].filter((d) => fs.existsSync(path.join(process.cwd(), "src", "app", d, "page.tsx"))).map((d) => `/${d}`);
    const routes = new Set([...all.map((p) => p.route), ...standalone]);
    for (const item of NAV_ITEMS.filter((n) => !n.planned)) expect(routes.has(item.href), item.href).toBe(true);
  });
});
