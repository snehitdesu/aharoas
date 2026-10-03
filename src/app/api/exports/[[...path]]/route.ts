import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter, listQuery } from "@/server/api/router";
import { exportReportCSV, listExportJobs } from "@/server/services/reports";
import { RATE_POLICIES } from "@/server/api/rateLimit";
import { requestExport, getExportJob, downloadExport, toExportJobDTO } from "@/server/services/exportJobs";

export const runtime = "nodejs";

const exportBody = z.object({ report: z.string().min(1), filters: z.record(z.unknown()).default({}), mode: z.enum(["inline", "background"]).default("inline") });

const csvResponse = (csv: string, filename: string, headers: Record<string, string>) =>
  new Response(csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store", ...headers } });

// GET  /api/exports                          -> export jobs (own jobs; org-wide roles see all)
// POST /api/exports { report, filters }      -> CSV download (creates ExportJob + audit)
// POST /api/exports { ..., mode: "background" } -> ExportJob (PENDING -> RUNNING -> SUCCESS/FAILED via ExportRunner)
// GET  /api/exports/:id                      -> job status
// GET  /api/exports/:id/download             -> stored CSV (re-authorized)
export const { GET, POST } = createRouter([
  { method: "GET", path: "", handler: async ({ ctx, query }) => {
    const page = await listExportJobs(prisma, ctx, listQuery.parse(query));
    return { ...page, items: page.items.map((j) => toExportJobDTO(j)) }; // never expose storage keys
  } },
  {
    method: "POST",
    path: "",
    rateLimit: RATE_POLICIES.export,
    handler: async ({ ctx, body }) => {
      const { report, filters, mode } = exportBody.parse(body);
      if (mode === "background") return toExportJobDTO(await requestExport(ctx, report, filters));
      const res = await exportReportCSV(ctx, report, filters);
      return new Response(res.csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${res.filename}"`,
          "X-Export-Job-Id": res.exportJobId,
          "X-Row-Count": String(res.rowCount),
          "X-Truncated": String(res.truncated),
          "Cache-Control": "no-store",
        },
      });
    },
  },
  { method: "GET", path: ":id", handler: async ({ ctx, params }) => toExportJobDTO(await getExportJob(prisma, ctx, params.id)) },
  {
    method: "GET", path: ":id/download", rateLimit: RATE_POLICIES.export,
    handler: async ({ ctx, params }) => {
      const file = await downloadExport(prisma, ctx, params.id);
      return csvResponse(file.csv, file.filename, { "X-Export-Job-Id": params.id, "X-Row-Count": String(file.rowCount) });
    },
  },
]);
