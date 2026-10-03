import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { loginWithPassword } from "@/server/auth/login";
import { setSessionCookie } from "@/server/auth/cookies";
import { ok, fail } from "@/server/api/respond";
import { assertSameOrigin } from "@/server/api/router";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { ValidationError } from "@/server/db/scope";
import { applyTimingHeaders, logSlowRequest, newRequestId } from "@/server/observability/timing";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const started = performance.now();
  const requestId = newRequestId(req.headers.get("x-request-id"));
  try {
    assertSameOrigin(req);
    const text = await req.text();
    if (text.length > 10_000) throw new ValidationError("Payload too large");
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { throw new ValidationError("Request body must be valid JSON"); }
    const ip = clientIp(req);
    // Per-IP and per-account throttling (the account limit cannot be bypassed by spoofing IPs).
    await enforceRateLimit(RATE_POLICIES.loginPerIp, ip);
    const email = typeof (body as { email?: unknown })?.email === "string" ? (body as { email: string }).email.toLowerCase().trim().slice(0, 200) : "";
    if (email) await enforceRateLimit(RATE_POLICIES.loginPerEmail, email);
    const userAgent = req.headers.get("user-agent") ?? undefined;
    const { session, user } = await loginWithPassword(prisma, body as never, { ip, userAgent });
    await setSessionCookie(session.token, session.expiresAt);
    const res = ok({ user, expiresAt: session.expiresAt });
    const durationMs = performance.now() - started;
    applyTimingHeaders(res.headers, requestId, durationMs);
    logSlowRequest({ requestId, method: "POST", path: "/api/auth/login", status: 200, durationMs, userId: user.id });
    return res;
  } catch (e) {
    const res = fail(e);
    const durationMs = performance.now() - started;
    applyTimingHeaders(res.headers, requestId, durationMs);
    logSlowRequest({ requestId, method: "POST", path: "/api/auth/login", status: res.status, durationMs });
    return res;
  }
}
