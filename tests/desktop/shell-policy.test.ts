/** Desktop shell policy (navigation, IPC validation, child env) and local config. */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appOrigin, childEnv, hasDebugSwitch, isAllowedRendererRequest, isAppUrl, parseReauthReply, restoreAuthorizationFrom, validatePrinterName, validateSetupInput } from "../../desktop/main/policy";
import { dataPaths, loadOrCreateConfig, prismaEngineFile, readSecret, type SecretCodec } from "../../desktop/main/config";
import { sqliteUrl } from "../../desktop/runtime/backup";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aharos-shell-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("navigation / request policy", () => {
  const origin = appOrigin(37310);
  it("allows only the local Aharos origin", () => {
    expect(isAppUrl("http://localhost:37310/pos", origin)).toBe(true);
    expect(isAppUrl("http://localhost:37311/pos", origin)).toBe(false);
    expect(isAppUrl("https://localhost:37310/pos", origin)).toBe(false);
    expect(isAppUrl("http://127.0.0.2:37310/", origin)).toBe(false);
    expect(isAppUrl("http://localhost:37310@evil.example/", origin)).toBe(false);
    expect(isAppUrl("http://user:pw@localhost:37310/", origin)).toBe(false);
    expect(isAppUrl("javascript:alert(1)", origin)).toBe(false);
    expect(isAppUrl("not a url", origin)).toBe(false);
  });
  it("lets the renderer request only local resources", () => {
    expect(isAllowedRendererRequest("http://localhost:37310/_next/static/x.js", origin)).toBe(true);
    expect(isAllowedRendererRequest("data:image/png;base64,AAAA", origin)).toBe(true);
    expect(isAllowedRendererRequest("https://fonts.googleapis.com/css", origin)).toBe(false);
    expect(isAllowedRendererRequest("http://192.168.1.10:37310/", origin)).toBe(false);
  });
});

describe("hasDebugSwitch (packaged app refuses debugger switches)", () => {
  it("flags Chromium DevTools and Node inspector switches in any form", () => {
    for (const a of ["--remote-debugging-port=9222", "--remote-debugging-port", "--remote-debugging-pipe", "--remote-debugging-address=0.0.0.0", "--inspect", "--inspect=9229", "--inspect-brk=0", "--inspect-port=1", "--js-flags=--allow-natives-syntax", "--INSPECT"])
      expect(hasDebugSwitch(["C:/Program Files/Aharos/Aharos.exe", a])).toBe(true);
  });
  it("allows a normal launch and look-alike arguments", () => {
    expect(hasDebugSwitch(["Aharos.exe"])).toBe(false);
    expect(hasDebugSwitch(["Aharos.exe", "--enable-logging", "--inspector-notes", "C:/data/--inspect/x","remote-debugging-port=1"])).toBe(false);
  });
});

describe("validateSetupInput (IPC boundary)", () => {
  const good = { organizationName: " Spice Route ", outletName: "Indiranagar", outletCode: "blr01", timezone: "Asia/Kolkata", currency: "inr", ownerName: "Asha", ownerEmail: "a@example.com", ownerPassword: " keep spaces " };
  it("accepts exactly the expected string fields, trims names and upper-cases codes, keeps the password verbatim", () => {
    const v = validateSetupInput(good);
    expect(v).toEqual({ ok: true, value: { ...good, organizationName: "Spice Route", outletCode: "BLR01", currency: "INR", ownerPassword: " keep spaces " } });
  });
  it("rejects unknown keys, non-strings, missing and oversized values", () => {
    const v = validateSetupInput({ ...good, ownerName: 5, outletName: "", organizationName: "x".repeat(121), isAdmin: true });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(Object.keys(v.fieldErrors).sort()).toEqual(["input", "organizationName", "outletName", "ownerName"]);
    expect(validateSetupInput(null).ok).toBe(false);
    expect(validateSetupInput([good]).ok).toBe(false);
  });
  it("validates printer names", () => {
    expect(validatePrinterName(undefined)).toBeNull();
    expect(validatePrinterName("EPSON TM-T82")).toBe("EPSON TM-T82");
    expect(() => validatePrinterName(42)).toThrow();
    expect(() => validatePrinterName("a\u0000b")).toThrow();
    expect(() => validatePrinterName("x".repeat(300))).toThrow();
  });
});

describe("childEnv", () => {
  it("passes only allow-listed OS variables plus the explicit runtime config", () => {
    const env = childEnv({ SystemRoot: "C:\\Windows", TEMP: "C:\\t", DATABASE_URL: "postgres://leak", NODE_OPTIONS: "--inspect", AUTH_SECRET: "dev", PAYMENT_WEBHOOK_SECRET: "s" } as unknown as NodeJS.ProcessEnv, { NODE_ENV: "production" });
    expect(env).toEqual({ SystemRoot: "C:\\Windows", TEMP: "C:\\t", NODE_ENV: "production" });
  });
  it("passes the macOS/POSIX basics (HOME, TMPDIR, USER, locale) and still nothing else", () => {
    const env = childEnv({ HOME: "/Users/asha", TMPDIR: "/var/folders/x/T/", USER: "asha", LANG: "en_IN.UTF-8", PATH: "/usr/bin:/bin", DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", AUTH_SECRET: "dev" } as unknown as NodeJS.ProcessEnv, {});
    expect(env).toEqual({ HOME: "/Users/asha", TMPDIR: "/var/folders/x/T/", USER: "asha", LANG: "en_IN.UTF-8", PATH: "/usr/bin:/bin" });
  });
});

describe("prismaEngineFile", () => {
  it("names the Node-API query engine Prisma generates for each packaged target", () => {
    expect(prismaEngineFile("win32", "x64")).toBe("query_engine-windows.dll.node");
    expect(prismaEngineFile("darwin", "arm64")).toBe("libquery_engine-darwin-arm64.dylib.node");
    expect(prismaEngineFile("darwin", "x64")).toBe("libquery_engine-darwin.dylib.node");
    expect(prismaEngineFile("linux", "x64")).toBeNull();
  });
});

describe("config.json", () => {
  const codec: SecretCodec = { available: true, encrypt: (s) => Buffer.from(s).toString("base64") + "!", decrypt: (v) => Buffer.from(v.slice(0, -1), "base64").toString() };
  it("creates a per-install secret once, protected by the codec, and reloads the same config", () => {
    const file = path.join(tmp, "config.json");
    const a = loadOrCreateConfig(file, codec);
    expect(a.created).toBe(true);
    expect(a.config.secret.enc).toBe("dpapi");
    const secret = readSecret(a.config, codec);
    expect(secret.length).toBeGreaterThanOrEqual(64);
    expect(fs.readFileSync(file, "utf8")).not.toContain(secret);
    const b = loadOrCreateConfig(file, codec);
    expect(b.created).toBe(false);
    expect(readSecret(b.config, codec)).toBe(secret);
  });
  it("moves a corrupt config aside instead of silently discarding it", () => {
    const file = path.join(tmp, "corrupt.json");
    fs.writeFileSync(file, "{not json");
    const r = loadOrCreateConfig(file, codec);
    expect(r.created).toBe(true);
    expect(fs.readdirSync(tmp).some((f) => f.startsWith("corrupt.json.corrupt-"))).toBe(true);
  });
  it("lays out the data directory and builds SQLite URLs for paths with spaces", () => {
    const p = dataPaths("C:\\Users\\Asha Rao\\AppData\\Roaming\\Aharos");
    expect(p.dbFile).toMatch(/data[\\/]aharos\.db$/);
    expect(sqliteUrl(p.dbFile)).toBe("file:C:/Users/Asha Rao/AppData/Roaming/Aharos/data/aharos.db");
    expect(() => sqliteUrl("C:\\odd?dir\\a.db")).toThrow();
  });
});

describe("restore step-up re-authentication", () => {
  it("only a well-formed reply to the current request id counts; anything else is a cancel", () => {
    expect(parseReauthReply({ id: "r1", outcome: "granted" }, "r1")).toBe("granted");
    expect(parseReauthReply({ id: "r1", outcome: "session_ended" }, "r1")).toBe("session_ended");
    expect(parseReauthReply({ id: "r1", outcome: "yes please" }, "r1")).toBe("cancelled");
    expect(parseReauthReply({ id: "r1" }, "r1")).toBe("cancelled");
    expect(parseReauthReply({ id: "stale", outcome: "granted" }, "r1")).toBeNull();
    expect(parseReauthReply("granted", "r1")).toBeNull();
    expect(parseReauthReply(null, "r1")).toBeNull();
  });

  it("restore is authorized only by the server's explicit success", () => {
    expect(restoreAuthorizationFrom(200, { ok: true, data: { authorized: true } })).toBe("authorized");
    expect(restoreAuthorizationFrom(200, { ok: true, data: {} })).toBe("error");
    expect(restoreAuthorizationFrom(200, null)).toBe("error");
    expect(restoreAuthorizationFrom(403, { ok: false, error: { code: "ReauthRequiredError" } })).toBe("reauth_required");
    expect(restoreAuthorizationFrom(403, { ok: false, error: { code: "ForbiddenError" } })).toBe("forbidden");
    expect(restoreAuthorizationFrom(401, null)).toBe("session_ended");
    expect(restoreAuthorizationFrom(500, null)).toBe("error");
  });
});
