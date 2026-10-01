/**
 * Current-user / current-context helpers for server components, server actions
 * and route handlers. All authorization derives from the DB-built AccessContext
 * — never from client input. This is the ONE authorization path (RBAC in rbac.ts).
 */
import { prisma } from "@/server/db/client";
import { type AccessContext, UnauthorizedError } from "@/server/db/scope";
import { buildAccessContext } from "@/server/auth/context";
import { assertCan, type Permission } from "@/server/auth/rbac";
import { validateToken } from "@/server/auth/session";
import { readSessionCookie } from "@/server/auth/cookies";

export type CurrentUser = { id: string; name: string; email: string; organizationId: string; isSuperAdmin: boolean };

/** Resolve the caller from the session cookie, or null if unauthenticated. */
export async function getCurrentContext(): Promise<{ ctx: AccessContext; user: CurrentUser } | null> {
  const token = await readSessionCookie();
  return resolveFromToken(token);
}

/** Resolve from an explicit raw token (used by middleware-free route handlers / tests). */
export async function resolveFromToken(token: string | undefined | null): Promise<{ ctx: AccessContext; user: CurrentUser } | null> {
  const userId = await validateToken(prisma, token);
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) return null;
  const ctx = await buildAccessContext(prisma, userId);
  return {
    ctx,
    user: { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId, isSuperAdmin: user.isSuperAdmin },
  };
}

/** Require an authenticated caller; throws UnauthorizedError (401) otherwise. */
export async function requireContext(): Promise<{ ctx: AccessContext; user: CurrentUser }> {
  const current = await getCurrentContext();
  if (!current) throw new UnauthorizedError();
  return current;
}

/** Require authentication AND a permission (optionally at an outlet). */
export async function requirePermission(permission: Permission, outletId?: string): Promise<{ ctx: AccessContext; user: CurrentUser }> {
  const current = await requireContext();
  assertCan(current.ctx, permission, outletId); // throws ForbiddenError (403)
  return current;
}
