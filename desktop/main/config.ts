/**
 * Local installation configuration (<appData>/Aharos/config.json — %APPDATA%\Aharos
 * on Windows, ~/Library/Application Support/Aharos on macOS) and the data
 * directory layout. Pure Node (no Electron) so it is unit-tested; secret
 * encryption is injected by the caller (Electron safeStorage: DPAPI on Windows,
 * the Keychain on macOS).
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DataPaths = {
  root: string;
  config: string;
  dataDir: string;
  dbFile: string;
  backups: string;
  exports: string;
  logs: string;
  printSpool: string;
};

export function dataPaths(root: string): DataPaths {
  return {
    root,
    config: path.join(root, "config.json"),
    dataDir: path.join(root, "data"),
    dbFile: path.join(root, "data", "aharos.db"),
    backups: path.join(root, "backups"),
    exports: path.join(root, "exports"),
    logs: path.join(root, "logs"),
    printSpool: path.join(root, "print-spool"),
  };
}

export function ensureDirs(p: DataPaths): void {
  for (const d of [p.root, p.dataDir, p.backups, p.exports, p.logs, p.printSpool]) fs.mkdirSync(d, { recursive: true });
}

export type WindowBounds = { x?: number; y?: number; width: number; height: number; maximized: boolean };

export type DesktopConfig = {
  version: 1;
  installId: string;
  port: number;
  /**
   * AUTH_SECRET for this install: { enc: "dpapi" | "plain", value: base64 }.
   * "dpapi" means "encrypted with Electron safeStorage" (DPAPI on Windows, the
   * Keychain on macOS); the label is kept so existing installs keep loading.
   */
  secret: { enc: "dpapi" | "plain"; value: string };
  lastAutoBackupAt?: string;
  window?: WindowBounds;
  printer?: { driver: "mock" | "system"; deviceName?: string };
};

export type SecretCodec = {
  available: boolean;
  encrypt(plain: string): string;
  decrypt(stored: string): string;
};

export const DEFAULT_PORT = 37_310;

function isPort(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1024 && n <= 65_535;
}

/** Load config.json, creating it (with a fresh per-install secret) on first run. Corrupt files are kept aside, never silently discarded. */
export function loadOrCreateConfig(file: string, codec: SecretCodec, now = new Date()): { config: DesktopConfig; created: boolean } {
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    try {
      const c = JSON.parse(raw) as DesktopConfig;
      if (c && c.version === 1 && typeof c.installId === "string" && isPort(c.port) && c.secret && typeof c.secret.value === "string") return { config: c, created: false };
    } catch {
      /* fall through */
    }
    fs.renameSync(file, `${file}.corrupt-${now.getTime()}`);
  }
  const secret = randomBytes(48).toString("base64url");
  const config: DesktopConfig = {
    version: 1,
    installId: randomUUID(),
    port: DEFAULT_PORT,
    secret: codec.available ? { enc: "dpapi", value: codec.encrypt(secret) } : { enc: "plain", value: secret },
  };
  saveConfig(file, config);
  return { config, created: true };
}

export function readSecret(config: DesktopConfig, codec: SecretCodec): string {
  if (config.secret.enc === "dpapi") {
    if (!codec.available) throw new Error("This installation's secret is protected by the operating system key store and cannot be read by the current user");
    return codec.decrypt(config.secret.value);
  }
  return config.secret.value;
}

/** Atomic write (temp file + rename) so a crash never leaves a half-written config. */
export function saveConfig(file: string, config: DesktopConfig): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * File name of Prisma's Node-API query engine for a platform/arch, as `prisma
 * generate` writes it into node_modules/.prisma/client. The packaged server only
 * contains the engine of the machine it was built on (no cross-compilation), so
 * desktop/scripts/after-pack.cjs refuses packages whose engine does not match.
 */
export function prismaEngineFile(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32") return "query_engine-windows.dll.node";
  if (platform === "darwin") return arch === "arm64" ? "libquery_engine-darwin-arm64.dylib.node" : "libquery_engine-darwin.dylib.node";
  return null; // Linux engines depend on the OpenSSL version: let Prisma find its own.
}
