import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { completePasswordToken } from "@/server/auth/account";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const ip = clientIp(req);
    await enforceRateLimit(RATE_POLICIES.passwordCompletePerIp, ip);
    const { email, purpose } = await completePasswordToken(prisma, body as never, { ip, userAgent: req.headers.get("user-agent") ?? undefined });
    return ok({ email, purpose });
  } catch (e) {
    return fail(e);
  }
}
