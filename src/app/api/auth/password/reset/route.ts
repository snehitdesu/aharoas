import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { requestPasswordReset, RESET_ACCEPTED_MESSAGE } from "@/server/auth/account";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const ip = clientIp(req);
    await enforceRateLimit(RATE_POLICIES.passwordResetPerIp, ip);
    const email = typeof body.email === "string" ? body.email.toLowerCase().trim().slice(0, 200) : "";
    if (email) await enforceRateLimit(RATE_POLICIES.passwordResetPerEmail, email);
    await requestPasswordReset(prisma, body as never, { ip, userAgent: req.headers.get("user-agent") ?? undefined });
    return ok({ message: RESET_ACCEPTED_MESSAGE }, 202);
  } catch (e) {
    return fail(e);
  }
}
