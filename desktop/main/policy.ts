/**
 * Pure security policy for the desktop shell (no Electron imports, unit-tested):
 * which URLs the app window may load or request, how IPC input is validated, and
 * which environment variables reach the child processes.
 */

/** True only for http://localhost:<port>/… — the local Aharos server. */
export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === appOrigin && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/** Requests the app window may make: the local origin, plus inline data:/blob: resources it creates itself. */
export function isAllowedRendererRequest(url: string, appOrigin: string): boolean {
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("devtools:")) return true;
  return isAppUrl(url, appOrigin);
}

/**
 * The window loads http://localhost:<port> (the server itself binds 127.0.0.1 only).
 * Next.js builds absolute redirect URLs (middleware → /login) with "localhost", so
 * the window must use the same host or those redirects would leave the app origin.
 * Chromium always resolves "localhost" to loopback, never via DNS.
 */
export function appOrigin(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Command-line switches that attach a debugger to the app (Chromium DevTools
 * protocol or Node inspector). A packaged build refuses to start with any of them.
 */
export function hasDebugSwitch(argv: readonly string[]): boolean {
  return argv.some((a) => /^--(remote-debugging-(port|pipe|address)|inspect(-brk|-port|-publish-uid)?|js-flags)(=|$)/i.test(a));
}

// ---------------- IPC input validation ----------------

export type FieldErrors = Record<string, string[]>;
export type Validated<T> = { ok: true; value: T } | { ok: false; fieldErrors: FieldErrors };

export type SetupInput = {
  organizationName: string;
  outletName: string;
  outletCode: string;
  timezone: string;
  currency: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
};

const SETUP_LIMITS: Record<keyof SetupInput, number> = {
  organizationName: 120,
  outletName: 120,
  outletCode: 20,
  timezone: 64,
  currency: 3,
  ownerName: 120,
  ownerEmail: 200,
  ownerPassword: 1024,
};

/**
 * Shape check at the IPC boundary: exactly these string keys, bounded lengths.
 * Business rules (outlet code format, timezone, password policy, empty database)
 * are enforced again by bootstrapOwner — this only keeps junk away from it.
 */
export function validateSetupInput(raw: unknown): Validated<SetupInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, fieldErrors: { input: ["Expected an object"] } };
  const obj = raw as Record<string, unknown>;
  const fieldErrors: FieldErrors = {};
  const keys = Object.keys(SETUP_LIMITS) as (keyof SetupInput)[];
  for (const k of Object.keys(obj)) if (!keys.includes(k as keyof SetupInput)) (fieldErrors.input ??= []).push(`Unexpected field: ${k.slice(0, 40)}`);
  const value = {} as SetupInput;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v !== "string") {
      fieldErrors[k] = ["Required"];
      continue;
    }
    const s = k === "ownerPassword" ? v : v.trim();
    if (!s) fieldErrors[k] = ["Required"];
    else if (s.length > SETUP_LIMITS[k]) fieldErrors[k] = [`At most ${SETUP_LIMITS[k]} characters`];
    else value[k] = k === "outletCode" || k === "currency" ? s.toUpperCase() : s;
  }
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, value };
}

/** A printer name chosen from the OS list (validated again against that list by the caller). */
export function validatePrinterName(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 256 || /[\u0000-\u001f]/.test(raw)) throw new Error("Invalid printer name");
  return raw;
}

// ---------------- child process environment ----------------

/** OS variables the Node child processes legitimately need (Windows, then macOS/POSIX). Nothing else is inherited. */
const INHERITED_ENV = [
  "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "PATH", "Path", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "COMPUTERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
  "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
];

/**
 * Build a child environment from an allow-list, so a developer's or the user's
 * DATABASE_URL / NODE_OPTIONS / provider secrets can never leak into the runtime.
 */
export function childEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of INHERITED_ENV) {
    const v = parent[k];
    if (typeof v === "string") env[k] = v;
  }
  return { ...env, ...extra };
}

// ---------------- step-up re-authentication (backup restore) ----------------

export type ReauthOutcome = "granted" | "cancelled" | "session_ended";

/**
 * The renderer's answer to a main-process re-auth request. Only a well-formed
 * reply to the CURRENT request id counts; anything else is "cancelled". Even a
 * "granted" reply is only a hint to retry — the server decides.
 */
export function parseReauthReply(raw: unknown, expectedId: string): ReauthOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, outcome } = raw as { id?: unknown; outcome?: unknown };
  if (id !== expectedId) return null;
  return outcome === "granted" || outcome === "session_ended" ? outcome : "cancelled";
}

export type RestoreAuthorization = "authorized" | "reauth_required" | "session_ended" | "forbidden" | "error";

/** Map the server's answer to POST /api/system/restore-authorization. */
export function restoreAuthorizationFrom(status: number, body: unknown): RestoreAuthorization {
  const b = body as { ok?: boolean; data?: { authorized?: unknown }; error?: { code?: unknown } } | null;
  if (status === 200 && b?.ok === true && b.data?.authorized === true) return "authorized";
  if (status === 401) return "session_ended";
  if (status === 403 && b?.error?.code === "ReauthRequiredError") return "reauth_required";
  if (status === 403) return "forbidden";
  return "error";
}
