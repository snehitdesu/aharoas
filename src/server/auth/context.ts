/**
 * Builds an AccessContext from a user's memberships. This is the object every
 * service authorizes against. It is derived server-side from the database —
 * never from anything the client sends.
 */
import type { PrismaClient } from "@prisma/client";
import type { Role } from "@/constants/enums";
import type { AccessContext } from "@/server/db/scope";
import { NotFoundError } from "@/server/db/scope";

export const ORG_WIDE_ROLES: Role[] = ["SUPER_ADMIN", "OWNER", "ADMIN", "AREA_MANAGER"];

export async function buildAccessContext(db: PrismaClient, userId: string): Promise<AccessContext> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { memberships: { where: { active: true } } },
  });
  if (!user || !user.active) throw new NotFoundError("User not found or inactive");

  const orgRoles: string[] = [];
  const outletRoles: Record<string, string[]> = {};
  const outletIdSet = new Set<string>();
  const roleSet = new Set<string>();

  for (const m of user.memberships) {
    roleSet.add(m.role);
    if (m.outletId === null) {
      orgRoles.push(m.role);
    } else {
      (outletRoles[m.outletId] ??= []).push(m.role);
      outletIdSet.add(m.outletId);
    }
  }

  const isOrgWide = user.isSuperAdmin || orgRoles.some((r) => ORG_WIDE_ROLES.includes(r as Role));

  let outletIds = [...outletIdSet];
  if (isOrgWide) {
    // Org-wide actors implicitly have access to every outlet in their org.
    const outlets = await db.outlet.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true },
    });
    outletIds = outlets.map((o) => o.id);
  }

  return {
    userId: user.id,
    organizationId: user.organizationId,
    outletIds,
    roles: [...roleSet],
    outletRoles,
    orgRoles,
    isOrgWide,
    isSuperAdmin: user.isSuperAdmin,
  };
}

/**
 * A full-access context for trusted background jobs / seeding within one org.
 * Not reachable from any request path.
 */
export function systemContext(organizationId: string, outletIds: string[] = []): AccessContext {
  return {
    userId: "system",
    organizationId,
    outletIds,
    roles: ["SUPER_ADMIN"],
    outletRoles: {},
    orgRoles: ["SUPER_ADMIN"],
    isOrgWide: true,
    isSuperAdmin: true,
  };
}
