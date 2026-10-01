import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { assertSameOrigin } from "@/server/api/router";
import { logout } from "@/server/auth/login";
import { readSessionCookie, clearSessionCookie } from "@/server/auth/cookies";
import { ok, fail } from "@/server/api/respond";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const token = await readSessionCookie();
    await logout(prisma, token);
    await clearSessionCookie();
    return ok({ loggedOut: true });
  } catch (e) {
    return fail(e);
  }
}
