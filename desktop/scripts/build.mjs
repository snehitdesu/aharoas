/**
 * Builds the desktop app payload into build/desktop (then `electron-builder`
 * packages it):
 *
 *   build/desktop/app/        → app.asar: main.js, preload-*.js, static/
 *   build/desktop/server/     → resources/server: Next.js standalone production
 *                               server + .next-desktop/static + migrations + dbtool.js
 *   build/desktop/resources/  → installer resources (icon)
 *
 * Fails the build if the payload contains an .env file, a database file, or any
 * value from the developer's .env that is not already public in the source.
 *
 *   node desktop/scripts/build.mjs [--skip-next]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = process.cwd();
const out = path.join(root, "build", "desktop");
const appDir = path.join(out, "app");
const serverDir = path.join(out, "server");
const resDir = path.join(out, "resources");
const skipNext = process.argv.includes("--skip-next");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const step = (m) => console.log(`[desktop] ${m}`);
const run = (args, env = {}) => execFileSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });

// 1. production Next.js build (standalone)
if (!skipNext) {
  step("prisma generate + next build (standalone)");
  run([require.resolve("prisma/build/index.js"), "generate"]);
  run([require.resolve("next/dist/bin/next"), "build"], { AHAROS_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production" });
}
// Must match distDir in next.config.mjs (AHAROS_STANDALONE builds).
const NEXT_DIR = ".next-desktop";
const nextDir = path.join(root, NEXT_DIR);
const standalone = path.join(nextDir, "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) throw new Error(`No standalone build found (${NEXT_DIR}/standalone/server.js); run without --skip-next`);

// 2. assemble the server payload
step("assembling server payload");
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(standalone, serverDir, { recursive: true });
fs.cpSync(path.join(nextDir, "static"), path.join(serverDir, NEXT_DIR, "static"), { recursive: true });
if (fs.existsSync(path.join(root, "public"))) fs.cpSync(path.join(root, "public"), path.join(serverDir, "public"), { recursive: true });
fs.cpSync(path.join(root, "prisma", "migrations"), path.join(serverDir, "migrations"), { recursive: true });

// Next copies the developer .env into standalone output: never ship it (or databases).
const removed = [];
(function strip(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) strip(p);
    else if (/^\.env/.test(e.name) || /\.db(-journal|-wal|-shm)?$/.test(e.name) || e.name.endsWith(".tsbuildinfo")) {
      fs.rmSync(p);
      removed.push(path.relative(out, p));
    }
  }
})(serverDir);
// TypeScript is traced in only because next.config is read at build time; the server never loads it.
fs.rmSync(path.join(serverDir, "node_modules", "typescript"), { recursive: true, force: true });
if (removed.length) step(`removed from payload: ${removed.join(", ")}`);

// 3. bundles
step("bundling main, preloads and dbtool");
const common = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: false, minify: false, legalComments: "none", tsconfig: path.join(root, "tsconfig.json"), logLevel: "warning" };
await build({ ...common, entryPoints: ["desktop/main/main.ts"], outfile: path.join(appDir, "main.js"), external: ["electron"] });
await build({ ...common, entryPoints: ["desktop/preload/app.ts"], outfile: path.join(appDir, "preload-app.js"), external: ["electron"], platform: "browser" });
await build({ ...common, entryPoints: ["desktop/preload/setup.ts"], outfile: path.join(appDir, "preload-setup.js"), external: ["electron"], platform: "browser" });
await build({ ...common, entryPoints: ["desktop/runtime/dbtool.ts"], outfile: path.join(serverDir, "dbtool.js"), external: ["@prisma/client"] });

// 4. static pages, icon, app package.json
fs.cpSync(path.join(root, "desktop", "static"), path.join(appDir, "static"), { recursive: true });
// The splash and setup pages use the web app's own typefaces: copy the latin
// Inter / Fraunces files next/font self-hosted for the build (no CDN, CSP font-src 'self').
{
  const cssDir = path.join(nextDir, "static", "css");
  const css = fs.readdirSync(cssDir).filter((f) => f.endsWith(".css")).map((f) => fs.readFileSync(path.join(cssDir, f), "utf8")).join("\n");
  const fontsDir = path.join(appDir, "static", "fonts");
  fs.mkdirSync(fontsDir, { recursive: true });
  for (const family of ["Inter", "Fraunces"]) {
    const face = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => m[1]).find((f) => f.includes(`font-family:${family};`) && /unicode-range:u\+00\?\?/i.test(f));
    const url = face?.match(/url\(\/_next\/static\/media\/([^)]+\.woff2)\)/)?.[1];
    if (!url) throw new Error(`latin ${family} font not found in the Next build CSS`);
    fs.copyFileSync(path.join(nextDir, "static", "media", url), path.join(fontsDir, `${family.toLowerCase()}-latin.woff2`));
  }
}
fs.mkdirSync(resDir, { recursive: true });
run([path.join(root, "desktop", "scripts", "make-icon.mjs"), resDir]);
fs.copyFileSync(path.join(resDir, "icon.png"), path.join(appDir, "static", "icon.png"));
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify({ name: "aharos", productName: "RESTORA", version: pkg.version, description: "RESTORA — The Operating System for Restaurants", author: "RESTORA", main: "main.js", private: true }, null, 2)
);

// 5. secret scan
step("scanning payload for secrets");
const problems = [];
const envFile = path.join(root, ".env");
const srcText = (function readAll(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) readAll(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(fs.readFileSync(p, "utf8"));
  }
  return acc;
})(path.join(root, "src")).join("\n");
const secrets = fs.existsSync(envFile)
  ? fs
      .readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/))
      .filter(Boolean)
      .map(([, k, v]) => ({ k, v }))
      // A value already public in the source (well-known dev defaults) is not a secret.
      .filter(({ v }) => v.length >= 12 && !srcText.includes(v))
  : [];
// Every file name is checked; contents are scanned where our code and build output
// live (.next, bundles, the generated Prisma client) — published third-party
// packages cannot contain values from this machine's .env.
const thirdParty = (p) => /[\\/]node_modules[\\/](?!\.prisma[\\/])/.test(p);
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) scan(p);
    else {
      if (/^\.env/.test(e.name) || /\.db$/.test(e.name)) problems.push(`forbidden file ${path.relative(out, p)}`);
      if (!secrets.length || thirdParty(p) || fs.statSync(p).size > 20 * 1024 * 1024 || /\.(node|png|wasm|woff2?)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, "latin1");
      for (const s of secrets) if (text.includes(s.v)) problems.push(`value of ${s.k} found in ${path.relative(out, p)}`);
    }
  }
})(out);
if (problems.length) {
  console.error(`[desktop] SECRET SCAN FAILED:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
step(`secret scan clean (${secrets.length} .env value(s) checked)`);

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
step(`done: app ${(size(appDir) / 1e6).toFixed(1)} MB, server ${(size(serverDir) / 1e6).toFixed(1)} MB → ${path.relative(root, out)}`);
