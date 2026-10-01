import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { listAnomalies, getAnomaly, detectAnomalies, acknowledgeAnomaly, resolveAnomaly, dismissAnomaly } from "@/server/services/anomaly";

export const runtime = "nodejs";

const note = z.object({ note: z.string().max(1000).optional() });

export const { GET, POST } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listAnomalies(prisma, ctx, query as never) },
  { method: "POST", path: "detect", handler: ({ ctx, body }) => detectAnomalies(ctx, z.object({ outletId: z.string().optional() }).parse(body)) },
  { method: "GET", path: ":id", handler: ({ ctx, params }) => getAnomaly(prisma, ctx, params.id) },
  { method: "POST", path: ":id/acknowledge", handler: ({ ctx, params }) => acknowledgeAnomaly(ctx, params.id) },
  { method: "POST", path: ":id/resolve", handler: ({ ctx, params, body }) => resolveAnomaly(ctx, params.id, note.parse(body).note) },
  { method: "POST", path: ":id/dismiss", handler: ({ ctx, params, body }) => dismissAnomaly(ctx, params.id, z.object({ note: z.string().min(1).max(1000) }).parse(body).note) },
]);
