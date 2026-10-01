/**
 * SERVER-ONLY: resolves the operator shell for server components (layouts /
 * pages). Uses the same session path as the API (getCurrentContext). Never
 * import from a client component.
 */
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db/client";
import { getCurrentContext } from "@/server/auth/current-user";
import { PERMISSIONS, can, type Permission } from "@/server/auth/rbac";
import { OUTLET_COOKIE } from "@/constants/auth";
import type { AccessContext } from "@/server/db/scope";

export type ShellOutlet = { id: string; code: string; name: string; timezone: string };

export type ShellData = {
  user: { id: string; name: string; email: string };
  roles: string[];
  outlets: ShellOutlet[];
  outletId: string | null;
  /** Permissions held at the selected outlet (UI hints only; the API re-checks). */
  permissions: Permission[];
  /** Holds an org-wide role (org-level master data is editable only by these). */
  orgWide: boolean;
};

/**
 * Resolve the shell once per request: the (app) layout and the page both need
 * it, so React's request-scoped `cache` dedupes the session + outlet queries.
 */
const loadShell = cache(async (): Promise<{ shell: ShellData; ctx: AccessContext } | null> => {
  const current = await getCurrentContext();
  if (!current) return null;
  const { ctx, user } = current;
  const outlets = await prisma.outlet.findMany({
    where: { organizationId: ctx.organizationId, active: true, ...(ctx.isOrgWide || ctx.isSuperAdmin ? {} : { id: { in: ctx.outletIds } }) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, timezone: true },
  });
  const preferred = (await cookies()).get(OUTLET_COOKIE)?.value;
  const outletId = outlets.find((o) => o.id === preferred)?.id ?? outlets[0]?.id ?? null;
  const permissions = PERMISSIONS.filter((p) => can(ctx, p, outletId ?? undefined));
  return { ctx, shell: { user: { id: user.id, name: user.name, email: user.email }, roles: ctx.roles, outlets, outletId, permissions, orgWide: ctx.isOrgWide || ctx.isSuperAdmin } };
});

/** Resolve the session or send the user to /login (with a return path). */
export async function requireShell(returnTo: string): Promise<{ shell: ShellData; ctx: AccessContext }> {
  const loaded = await loadShell();
  if (!loaded) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return loaded;
}
