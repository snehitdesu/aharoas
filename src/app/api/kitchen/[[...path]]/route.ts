import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { KOTStatus } from "@/constants/enums";
import { listKOTs, listStations, updateKOTStatus, routeKOTToStation } from "@/server/services/kot";

export const runtime = "nodejs";

// KDS: live tickets per outlet/station and their lifecycle.
export const { GET, POST } = createRouter([
  {
    method: "GET", path: "kots",
    handler: ({ ctx, query }) => {
      const q = z.object({ outletId: z.string().min(1), stationId: z.string().optional(), status: z.string().optional() }).parse(query);
      return listKOTs(prisma, ctx, { outletId: q.outletId, stationId: q.stationId, status: q.status ? q.status.split(",").map((s) => KOTStatus.zod.parse(s)) : undefined });
    },
  },
  { method: "GET", path: "stations", handler: ({ ctx, query }) => listStations(prisma, ctx, z.object({ outletId: z.string().min(1) }).parse(query).outletId) },
  { method: "POST", path: "kots/:id/status", handler: ({ ctx, params, body }) => updateKOTStatus(ctx, params.id, z.object({ status: KOTStatus.zod }).parse(body).status) },
  { method: "POST", path: "kots/:id/station", handler: ({ ctx, params, body }) => routeKOTToStation(ctx, params.id, z.object({ stationId: z.string() }).parse(body).stationId) },
]);
