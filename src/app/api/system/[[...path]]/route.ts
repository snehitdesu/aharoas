import { createRouter } from "@/server/api/router";
import { ForbiddenError } from "@/server/db/scope";

export const runtime = "nodejs";

export const { POST } = createRouter([
  // Desktop "Restore from Backup" (performed by the Electron main process, which
  // calls this with the terminal's session cookie): only an org-wide OWNER (or
  // super admin) who has JUST re-entered their password may restore. The router
  // enforces the fresh `backup.restore` grant before this handler runs.
  {
    method: "POST", path: "restore-authorization", reauth: "backup.restore",
    handler: async ({ ctx, user }) => {
      if (!ctx.isSuperAdmin && !(ctx.isOrgWide && ctx.orgRoles.includes("OWNER"))) throw new ForbiddenError("Only the restaurant Owner can restore a backup");
      return { authorized: true, email: user.email };
    },
  },
]);
