/**
 * SERVER-ONLY page gate for back-office surfaces. Resolves the session (or
 * redirects to /login with a return path) and renders a "not allowed" page when
 * the user lacks the surface's permission at the selected outlet. The
 * permission comes from the nav entry owning the path (single source), unless
 * given explicitly. The APIs the screen calls still authorize every request.
 */
import { requireShell } from "@/lib/auth/shell";
import { navAllowed, navFor } from "@/lib/nav";
import { ForbiddenPage } from "@/components/ui/States";
import type { Permission } from "@/server/auth/rbac";

export async function gated(path: string, render: () => React.ReactNode, need?: { permission?: Permission; anyOf?: Permission[] }) {
  const { shell } = await requireShell(path);
  const rule = need ?? navFor(path) ?? {};
  if (!navAllowed(rule, new Set(shell.permissions))) {
    return <ForbiddenPage title="Not available" reason="Your role doesn't include access to this screen at the selected outlet." />;
  }
  if (!shell.outletId) return null; // the shell explains that no outlet is accessible
  return render();
}
