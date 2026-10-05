/** Auth constants safe to import anywhere (no Node/Next runtime deps). */
export const SESSION_COOKIE = "aharos_session";
/** Non-sensitive UI preference: the operator's selected outlet (always re-validated server-side). */
export const OUTLET_COOKIE = "aharos_outlet";
/** Request header set by middleware with the requested page path (for the post-login return path). */
export const PATH_HEADER = "x-aharos-path";

/**
 * Only same-origin relative paths are allowed as a post-login destination (no
 * open redirect). The path is resolved the way a browser would — which treats
 * "\" like "/" and drops tabs/newlines, so "/\evil.com" means "//evil.com" —
 * and rejected unless it stays on this origin. Returns the normalized path.
 */
export function safeReturnPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/")) return fallback;
  const base = "http://same-origin.invalid";
  try {
    const u = new URL(next, base);
    return u.origin === base ? `${u.pathname}${u.search}${u.hash}` : fallback;
  } catch {
    return fallback;
  }
}

/** Request header marking a background poll: it never counts as user activity for the idle timeout. */
export const BACKGROUND_HEADER = "x-aharos-background";

/**
 * Step-up re-authentication scopes. A sensitive action requires a fresh
 * password confirmation for ITS scope; a grant for one scope never authorizes
 * another. Labels are shown in the confirmation prompt.
 */
export const REAUTH_SCOPES = {
  "payment.refund": "issue a refund",
  "order.void": "cancel an order",
  "finance.void": "cancel a financial document",
  "staff.manage": "change staff accounts or roles",
  "settings.manage": "change restaurant settings",
  "security.manage": "change account security settings",
  "backup.restore": "restore a backup",
} as const;
export type ReauthScope = keyof typeof REAUTH_SCOPES;
export const isReauthScope = (v: unknown): v is ReauthScope => typeof v === "string" && Object.prototype.hasOwnProperty.call(REAUTH_SCOPES, v);
