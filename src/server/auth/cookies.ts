/**
 * Session cookie helpers (Next.js server runtime). The cookie is httpOnly (not
 * readable by JS), sameSite=lax, secure in production, and holds only the opaque
 * session token — no user data.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/constants/auth";

export { SESSION_COOKIE };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * In production the session cookie is Secure, and browsers discard a Secure
 * cookie set for a page loaded over plain http:// (loopback excepted). Signing in
 * would "succeed" and then bounce straight back to the sign-in page. Detect that
 * from the browser's Origin header (always sent on the sign-in POST, and already
 * checked to be this deployment) and refuse with an actionable message instead.
 * Never relaxes the cookie. Returns the problem, or null when the cookie will stick.
 */
export function insecureOriginProblem(origin: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NODE_ENV !== "production" || !origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" || LOOPBACK.has(u.hostname)) return null;
  } catch {
    return null; // malformed Origin is rejected by the same-origin check
  }
  return "RESTORA must be opened over HTTPS to sign in: this browser discards the secure session cookie on plain http://. Use the deployment's https:// address.";
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
