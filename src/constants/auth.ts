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
