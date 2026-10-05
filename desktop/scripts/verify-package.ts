/**
 * Verifies the PACKAGED desktop app — Windows: dist-desktop/win-unpacked/Aharos.exe,
 * macOS: dist-desktop/mac{,-arm64}/RESTORA.app — which Playwright cannot drive
 * once its fuses are flipped (it needs --inspect):
 *
 *  1. fuses   — the security fuses in electron-builder.yml are set in the exe;
 *  2. upgrade — a restaurant database from the previous release (ad547ae, 9
 *               migrations, real rows) is upgraded by the real binary on start:
 *               verified pre-migration backup, data intact, Owner signs in over
 *               the real API, automatic backup verified;
 *  3. attacks — ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect and
 *               --remote-debugging-port cannot run code / attach a debugger;
 *  4. asar    — a tampered app.asar refuses to load (embedded integrity).
 *
 *   npm run desktop:pack && npm run desktop:verify     (on Windows or macOS, for that OS's package)
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { getCurrentFuseWire, FuseV1Options } from "@electron/fuses";
import { applyMigrations, inspectMigrations, loadMigrations } from "../runtime/migrator";
import { sqliteUrl } from "../runtime/backup";

// @electron/fuses (via electron-builder) does not export its FuseState enum: a fuse byte is ASCII '0' / '1'.
enum FuseState {
  DISABLE = 48,
  ENABLE = 49,
}

const root = process.cwd();
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
/** The unpacked package directory (copied whole for the tamper test) and the binary to launch inside it. */
const unpacked = isMac ? path.join(root, "dist-desktop", process.arch === "arm64" ? "mac-arm64" : "mac", "RESTORA.app") : path.join(root, "dist-desktop", "win-unpacked");
const binaryIn = (pkg: string) => (isMac ? path.join(pkg, "Contents", "MacOS", "RESTORA") : path.join(pkg, "Aharos.exe"));
const asarIn = (pkg: string) => (isMac ? path.join(pkg, "Contents", "Resources", "app.asar") : path.join(pkg, "resources", "app.asar"));
const EXE = binaryIn(unpacked);
const MIGRATIONS = loadMigrations(path.join(root, "prisma", "migrations"));
const PREVIOUS_RELEASE = MIGRATIONS.filter((m) => m.name <= "20261004090000_export_lifecycle");
const OWNER = { email: "owner@upgrade.example", password: "Upgrade-Test-Passw0rd!" };
const work = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-verify-"));
const results: { check: string; ok: boolean; detail?: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Env for launching the app: never inherit a developer's Electron/Node switches. */
function appEnv(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AHAROS_DATA_DIR: dataDir, ...extra };
  for (const k of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "DATABASE_URL"]) if (!(k in extra)) delete env[k];
  return env;
}
/** Main-process stderr per launch (Electron reports pages it could not load there). */
const stderrOf = new WeakMap<ChildProcess, string[]>();
function launch(dataDir: string, args: string[] = [], extra: Record<string, string> = {}): ChildProcess {
  // POSIX: own process group, so killTree() also ends the Electron helpers and utility processes.
  const p = spawn(EXE, args, { env: appEnv(dataDir, extra), stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: !isWin });
  const lines: string[] = [];
  stderrOf.set(p, lines);
  p.stderr?.on("data", (d) => lines.push(String(d)));
  return p;
}
/** No page (splash, setup wizard, app window) failed to load. */
function pagesLoaded(p: ChildProcess, dataDir: string): { ok: boolean; detail: string } {
  const bad = [...(stderrOf.get(p) ?? []), readLog(dataDir)].join("\n").match(/(Failed to load URL|Page failed to load)[^\n]*/);
  return { ok: !bad, detail: bad ? bad[0].slice(0, 200) : "splash + windows loaded" };
}
function killTree(p: ChildProcess) {
  if (p.pid && p.exitCode === null) {
    try {
      if (isWin) execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-p.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
function exitWithin(p: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (p.exitCode !== null) return resolve(p.exitCode);
    const t = setTimeout(() => resolve(null), ms);
    p.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const readLog = (dataDir: string) => {
  const f = path.join(dataDir, "logs", "main.log");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
};
const open = (file: string) => new PrismaClient({ datasources: { db: { url: `${sqliteUrl(file)}?connection_limit=1` } }, log: ["error"] });

// ---------------- 1. fuses ----------------
async function verifyFuses() {
  const wire = await getCurrentFuseWire(isMac ? unpacked : EXE); // macOS: the .app (fuses live in the Electron Framework)
  const want: [string, FuseV1Options, FuseState][] = [
    ["RunAsNode", FuseV1Options.RunAsNode, FuseState.DISABLE],
    ["EnableNodeOptionsEnvironmentVariable", FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    ["EnableNodeCliInspectArguments", FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    ["EnableCookieEncryption", FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    ["OnlyLoadAppFromAsar", FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    ["EnableEmbeddedAsarIntegrityValidation", FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  ];
  for (const [name, opt, state] of want) check(`fuse ${name}`, (wire as unknown as Record<number, number>)[opt] === state, `expected ${state === FuseState.ENABLE ? "enabled" : "disabled"}`);
}

// ---------------- 2. upgrade a previous-release restaurant ----------------
async function previousReleaseDataDir(): Promise<string> {
  const dataDir = path.join(work, "upgrade");
  const dbFile = path.join(dataDir, "data", "aharos.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = open(dbFile);
  try {
    await applyMigrations(db, PREVIOUS_RELEASE);
    await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
    const now = "2026-10-01 10:00:00";
    const hash = bcrypt.hashSync(OWNER.password, 10);
    for (const s of [
      `INSERT INTO "Organization" (id, name, updatedAt) VALUES ('org1', 'Upgrade Bistro', '${now}')`,
      `INSERT INTO "Outlet" (id, organizationId, code, name, updatedAt) VALUES ('out1', 'org1', 'UPG01', 'Main', '${now}')`,
      `INSERT INTO "User" (id, organizationId, email, name, passwordHash, updatedAt) VALUES ('usr1', 'org1', '${OWNER.email}', 'Owner', '${hash}', '${now}')`,
      `INSERT INTO "Membership" (id, organizationId, userId, role, updatedAt) VALUES ('mem1', 'org1', 'usr1', 'OWNER', '${now}')`,
      `INSERT INTO "Order" (id, organizationId, outletId, status, subtotal, tax, total, updatedAt) VALUES ('ord1', 'org1', 'out1', 'PAID', 1000, 50, 1050, '${now}')`,
      `INSERT INTO "Payment" (id, organizationId, outletId, orderId, method, status, amount, provider, providerRef) VALUES ('pay1', 'org1', 'out1', 'ord1', 'CASH', 'SUCCESS', 1050, 'cash', 'r1')`,
    ])
      await db.$executeRawUnsafe(s);
  } finally {
    await db.$disconnect();
  }
  return dataDir;
}

async function verifyUpgrade() {
  const dataDir = await previousReleaseDataDir();
  const app = launch(dataDir);
  try {
    const port = await waitFor("config.json", () => {
      const f = path.join(dataDir, "config.json");
      return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { port: number; secret: { enc: string } }) : undefined;
    }, 60_000);
    check(`install secret is protected by the OS key store (${isMac ? "Keychain" : "DPAPI"})`, port.secret.enc === "dpapi", `enc=${port.secret.enc}`);
    const origin = `http://localhost:${port.port}`;
    await waitFor("server health", async () => (await fetch(`http://127.0.0.1:${port.port}/api/health`).catch(() => null))?.ok || undefined, 120_000);
    check("packaged app starts and serves on loopback", true, origin);

    const log = readLog(dataDir);
    check("start-up applied this version's migrations", /Applied migrations: /.test(log), (log.match(/Applied migrations: [^\n]*/) ?? ["none"])[0].slice(0, 160));
    const backups = path.join(dataDir, "backups");
    const pre = fs.readdirSync(backups).find((f) => /-pre-migration\.json$/.test(f));
    const manifest = pre ? (JSON.parse(fs.readFileSync(path.join(backups, pre), "utf8")) as { migrations: string[]; integrity: string }) : null;
    check("verified pre-migration backup holds the previous release", !!manifest && manifest.integrity === "ok" && manifest.migrations.length === PREVIOUS_RELEASE.length);

    const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(OWNER) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    check("previous-release Owner signs in after the upgrade", login.status === 200 && cookie.includes("="), `HTTP ${login.status}`);
    const me = await fetch(`${origin}/api/auth/me`, { headers: { cookie } });
    const body = (await me.json().catch(() => null)) as { data?: { user?: { email?: string }; access?: { roles?: string[] } } } | null;
    check("session works against the upgraded data", me.status === 200 && body?.data?.user?.email === OWNER.email && !!body?.data?.access?.roles?.includes("OWNER"));

    const auto = await waitFor("automatic backup", () => fs.readdirSync(backups).find((f) => /-auto\.json$/.test(f)), 90_000).catch(() => undefined);
    check("automatic verified backup after start-up", !!auto);
    check("no renderer request was blocked in normal operation", !/Blocked (renderer request|navigation)/.test(readLog(dataDir)));
    const pages = pagesLoaded(app, dataDir);
    check("splash and app window pages load from the fused app.asar", pages.ok, pages.detail);
  } finally {
    killTree(app);
    await exitWithin(app, 10_000);
  }
  // The data on disk after the upgrade (app stopped).
  const db = open(path.join(dataDir, "data", "aharos.db"));
  try {
    const status = await inspectMigrations(db, MIGRATIONS);
    check("database is fully migrated with no problems", status.pending.length === 0 && status.problems.length === 0, `pending=${status.pending.length}`);
    const rows = await db.$queryRawUnsafe<{ n: string }[]>(`SELECT (SELECT name FROM "Organization") || '|' || (SELECT CAST(total AS TEXT) FROM "Order") || '|' || (SELECT CAST(amount AS TEXT) FROM "Payment") AS n`);
    check("restaurant rows survived the upgrade unchanged", rows[0]?.n === "Upgrade Bistro|1050|1050", rows[0]?.n);
  } finally {
    await db.$disconnect();
  }
}

// ---------------- 2b. first run: setup wizard ----------------
async function verifyFirstRun() {
  const dataDir = path.join(work, "first-run");
  const app = launch(dataDir);
  try {
    await waitFor("database ready", () => /Database ready \(journal=wal, initialized=false\)/.test(readLog(dataDir)) || undefined, 90_000);
    await sleep(8_000); // the setup wizard (file:// page in app.asar) opens now
    const pages = pagesLoaded(app, dataDir);
    check("first run: empty database migrated, setup wizard page loads", pages.ok && app.exitCode === null, pages.detail);
  } finally {
    killTree(app);
    await exitWithin(app, 10_000);
  }
}

// ---------------- 3. launch attacks ----------------
async function verifyAttacks() {
  const marker = path.join(work, "pwned.txt");
  const payload = path.join(work, "payload.js");
  fs.writeFileSync(payload, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);

  const runAsNode = launch(path.join(work, "a1"), ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { ELECTRON_RUN_AS_NODE: "1" });
  await sleep(8_000);
  killTree(runAsNode);
  check("ELECTRON_RUN_AS_NODE cannot run code as the app", !fs.existsSync(marker));

  const nodeOptions = launch(path.join(work, "a2"), [], { NODE_OPTIONS: `--require ${JSON.stringify(payload)}` });
  await sleep(8_000);
  killTree(nodeOptions);
  check("NODE_OPTIONS --require is ignored", !fs.existsSync(marker));

  for (const [label, arg, port] of [["--inspect", "--inspect=39229", 39229], ["--remote-debugging-port", "--remote-debugging-port=39222", 39222]] as const) {
    const p = launch(path.join(work, `a-${port}`), [arg]);
    let opened = false;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && p.exitCode === null) {
      if (await listening(port)) opened = true;
      await sleep(100);
    }
    const code = await exitWithin(p, 10_000);
    killTree(p);
    check(`${label}: packaged app refuses to start and no debugger is reachable`, code === 1 && !opened && !(await listening(port)), `exit=${code}, portOpened=${opened}`);
  }
}

// ---------------- 4. asar integrity ----------------
async function verifyAsarIntegrity() {
  const copy = path.join(work, isMac ? "tampered.app" : "tampered");
  fs.cpSync(unpacked, copy, { recursive: true, verbatimSymlinks: true }); // macOS frameworks are symlink-heavy
  const asar = asarIn(copy);
  const buf = fs.readFileSync(asar);
  const at = buf.indexOf(Buffer.from("Aharos refuses to start with debugging switches"));
  if (at < 0) return check("tampered app.asar is rejected", false, "marker string not found in app.asar");
  buf[at] = "X".charCodeAt(0); // same length: only the content hash changes
  fs.writeFileSync(asar, buf);
  const dataDir = path.join(work, "tamper-data");
  const p = spawn(binaryIn(copy), [], { env: appEnv(dataDir), stdio: "ignore", windowsHide: true, detached: !isWin });
  const code = await exitWithin(p, 20_000);
  killTree(p);
  check("tampered app.asar is rejected (embedded integrity)", code !== null && code !== 0 && !fs.existsSync(path.join(dataDir, "config.json")), `exit=${code}`);
}

async function main() {
  if (!isWin && !isMac) throw new Error("desktop:verify runs on Windows or macOS (the packaged targets)");
  if (!fs.existsSync(EXE)) throw new Error(`${path.relative(root, EXE)} not found; run npm run desktop:pack first`);
  try {
    await verifyFuses();
    await verifyUpgrade();
    await verifyFirstRun();
    await verifyAttacks();
    await verifyAsarIntegrity();
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} packaged-app checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(`desktop:verify failed: ${(e as Error).message}`);
  process.exit(1);
});
