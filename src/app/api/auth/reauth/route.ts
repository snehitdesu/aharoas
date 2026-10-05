import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { SESSION_COOKIE } from "@/constants/auth";
import { resolveFromToken } from "@/server/auth/current-user";
import { grantReauth } from "@/server/auth/reauth";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { UnauthorizedError } from "@/server/db/scope";

export const runtime = "nodejs";

/** Step-up: confirm the signed-in user's password; grants ONE scope to THIS session for a few minutes. */
export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const current = await resolveFromToken(req.cookies.get(SESSION_COOKIE)?.value);
    if (!current) throw new UnauthorizedError();
    await enforceRateLimit(RATE_POLICIES.reauthPerUser, current.user.id);
    const grant = await grantReauth(prisma, current.session, body as never, { ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined });
    return ok(grant);
  } catch (e) {
    return fail(e);
  }
}
