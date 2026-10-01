import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { listAuditLogs } from "@/server/services/adminQueries";

export const runtime = "nodejs";

// GET /api/audit?entityType&entityId&outletId&actorId&action&from&to&cursor  (audit.view, scoped)
export const { GET } = createRouter([{ method: "GET", path: "", handler: ({ ctx, query }) => listAuditLogs(prisma, ctx, query) }]);
