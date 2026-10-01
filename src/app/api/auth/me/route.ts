import { requireContext } from "@/server/auth/current-user";
import { ok, fail } from "@/server/api/respond";

export const runtime = "nodejs";

// Protected: returns the current user + a summary of their access context.
export async function GET() {
  try {
    const { ctx, user } = await requireContext();
    return ok({
      user,
      access: { roles: ctx.roles, outletIds: ctx.outletIds, isOrgWide: ctx.isOrgWide, isSuperAdmin: ctx.isSuperAdmin },
    });
  } catch (e) {
    return fail(e);
  }
}
