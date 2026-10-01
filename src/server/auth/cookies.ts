/**
 * Session cookie helpers (Next.js server runtime). The cookie is httpOnly (not
 * readable by JS), sameSite=lax, secure in production, and holds only the opaque
 * session token — no user data.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/constants/auth";

export { SESSION_COOKIE };

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
