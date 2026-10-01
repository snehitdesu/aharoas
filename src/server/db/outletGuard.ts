/**
 * Write-path tenant guard (DB-backed).
 *
 * `assertOutletAccess` (scope.ts) is a no-op for org-wide / super-admin callers,
 * so a write that takes a client-supplied `outletId` must ALSO confirm the
 * outlet actually exists and belongs to the caller's organization — otherwise an
 * org-wide user of Org A could create a row (organizationId = A) that points at
 * Org B's outlet. This mirrors the inline checks menu.ts / staff.ts / masterData
 * already do, centralised so every write uses the same guarantee.
 *
 * Use at every write entry point that accepts an outletId from the client.
 * Reads already go through `outletScope`, which injects the org + outlet filter.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { type AccessContext, assertOutletAccess, NotFoundError } from "@/server/db/scope";

type Client = PrismaClient | Prisma.TransactionClient;

export async function assertOutletInOrg(db: Client, ctx: AccessContext, outletId: string): Promise<void> {
  assertOutletAccess(ctx, outletId); // caller may act at this outlet (non-org-wide restricted to their memberships)
  const outlet = await db.outlet.findUnique({ where: { id: outletId }, select: { organizationId: true } });
  // NotFound (not Forbidden) so a foreign-org outlet id is not confirmed to exist.
  if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
}
