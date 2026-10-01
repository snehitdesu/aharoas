import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { changePassword } from "@/server/auth/account";
import { SESSION_COOKIE } from "@/constants/auth";
import { resolveFromToken } from "@/server/auth/current-user";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { UnauthorizedError } from "@/server/db/scope";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const current = await resolveFromToken(token);
    if (!current || !token) throw new UnauthorizedError();
    await enforceRateLimit(RATE_POLICIES.passwordChangePerUser, current.user.id);
    const result = await changePassword(prisma, { userId: current.user.id, sessionToken: token }, body as never, { ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined });
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
