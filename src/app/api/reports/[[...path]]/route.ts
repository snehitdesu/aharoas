import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { REPORTS, getReport } from "@/server/services/reports";
import { can } from "@/server/auth/rbac";
import { RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

// GET /api/reports            -> reports the caller may run
// GET /api/reports/:id?filters -> run a report (JSON, capped + paginated)
export const { GET } = createRouter([
  {
    method: "GET",
    path: "",
    handler: async ({ ctx }) =>
      Object.values(REPORTS)
        .filter((r) => can(ctx, r.permission))
        .map((r) => ({ id: r.id, title: r.title, permission: r.permission, maxRows: r.maxRows, aggregate: r.aggregate, columns: r.columns.map((c: { key: string; header: string }) => ({ key: c.key, header: c.header })) })),
  },
  { method: "GET", path: ":id", rateLimit: RATE_POLICIES.report, handler: ({ ctx, params, query }) => getReport(prisma, ctx, params.id, query) },
]);
