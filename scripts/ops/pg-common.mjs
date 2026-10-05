// Shared helpers for the PostgreSQL operations scripts (backup / restore /
// verify / drill). Plain Node (no app imports) so they run on a bastion or a
// cron host with only Node + the PostgreSQL client tools installed.
//
// Credentials never appear on a command line (visible in `ps`): connection URLs
// are split into libpq environment variables (PGHOST, PGPASSWORD, ...), and
// every message passes through redactUrl().
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const MAGIC = Buffer.from("RSTRBK1\n"); // encrypted backup header (format v1)
const IV_LEN = 12, TAG_LEN = 16;

export function bin(name) {
  const dir = process.env.PG_BIN_DIR;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return dir ? path.join(dir, exe) : exe;
}

/** Mask the password in any postgres URL inside a string. */
export function redactUrl(s) {
  return String(s).replace(/(postgres(?:ql)?:\/\/[^:/\s@]+):[^@\s/]+@/gi, "$1:***@");
}

/** postgresql:// URL -> libpq env (Prisma-only query params such as schema / connection_limit are dropped). */
export function pgEnv(url, database) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("not a postgresql:// URL");
  const env = {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: database ?? decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "restora-ops",
  };
  const ssl = u.searchParams.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  const schema = u.searchParams.get("schema");
  if (schema && schema !== "public") env.PGOPTIONS = `-c search_path=${schema}`;
  return env;
}

export function dbName(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Run a PostgreSQL client tool; resolves stdout, rejects with stderr (redacted). */
export function run(tool, args, { url, database, input, stdoutFile } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(url ? pgEnv(url, database) : {}) };
    const child = spawn(bin(tool), args, { env, stdio: [input ? "pipe" : "ignore", stdoutFile ? "pipe" : "pipe", "pipe"] });
    let out = "", err = "";
    if (stdoutFile) child.stdout.pipe(fs.createWriteStream(stdoutFile));
    else child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`${tool} could not start (${e.code ?? e.message}); install the PostgreSQL client tools or set PG_BIN_DIR`)));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${tool} exited ${code}: ${redactUrl(err.trim()).slice(0, 2000)}`))));
    if (input) {
      child.stdin.end(input);
    }
  });
}

/** psql -At query -> rows of fields. */
export async function psql(url, sql, database) {
  const out = await run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql], { url, database });
  return out.split(/\r?\n/).filter((l) => l.length).map((l) => l.split("\t"));
}

export function toolVersion(tool) {
  const r = spawnSync(bin(tool), ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function sha256File(file) {
  const h = createHash("sha256");
  await pipeline(fs.createReadStream(file), h);
  return h.digest("hex");
}

/** BACKUP_ENCRYPTION_KEY: base64 of exactly 32 random bytes. */
export function encryptionKey(env = process.env) {
  const v = env.BACKUP_ENCRYPTION_KEY;
  if (!v) return null;
  const key = Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)");
  return key;
}

/** AES-256-GCM: MAGIC | iv(12) | ciphertext | tag(16). Streams; any tampering fails decryption. */
export async function encryptFile(src, dst, key) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const out = fs.createWriteStream(dst, { mode: 0o600 });
  out.write(MAGIC);
  out.write(iv);
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((res, rej) => out.end(cipher.getAuthTag(), (e) => (e ? rej(e) : res())));
}

export async function decryptFile(src, dst, key) {
  const size = fs.statSync(src).size;
  if (size < MAGIC.length + IV_LEN + TAG_LEN) throw new Error("encrypted backup is truncated");
  const fd = fs.openSync(src, "r");
  const head = Buffer.alloc(MAGIC.length + IV_LEN);
  fs.readSync(fd, head, 0, head.length, 0);
  const tag = Buffer.alloc(TAG_LEN);
  fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a RESTORA encrypted backup (bad header)");
  const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: head.length, end: size - TAG_LEN - 1 }), decipher, fs.createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(dst, { force: true });
    throw new Error(`backup decryption failed: wrong BACKUP_ENCRYPTION_KEY or the file was modified/corrupted (${e.message})`);
  }
}

export const isEncrypted = (file) => {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(MAGIC.length);
  fs.readSync(fd, b, 0, b.length, 0);
  fs.closeSync(fd);
  return b.equals(MAGIC);
};

/** Newest migration directory name in prisma/postgres/migrations (what this release expects). */
export function expectedMigration(root = process.cwd()) {
  const dir = path.join(root, "prisma", "postgres", "migrations");
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort().at(-1) ?? null;
}

/** Best-effort alert (same JSON shape as the app's alerts). */
export async function sendAlert(key, message, fields = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: message, alert: key, ...fields }));
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "restora", key, severity: "critical", message, fields, ts: new Date().toISOString() }), signal: AbortSignal.timeout(5000) });
  } catch (e) {
    console.error(`alert delivery failed: ${e.message}`);
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
