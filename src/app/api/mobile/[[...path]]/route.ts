import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { assertOutletInOrg } from "@/server/db/outletGuard";
import { ValidationError } from "@/server/db/scope";
import { tableBoard, managerSummary } from "@/server/services/mobile";

export const runtime = "nodejs";

const outletQ = z.object({ outletId: z.string().min(1, "outletId is required") });

function outletOf(query: Record<string, string>) {
  const q = outletQ.safeParse(query);
  if (!q.success) throw new ValidationError("Invalid filters", q.error.flatten());
  return q.data.outletId;
}

// Read models for the captain and manager mobile screens (each service re-checks permissions).
export const { GET } = createRouter([
  {
    method: "GET",
    path: "tables",
    handler: async ({ ctx, query }) => {
      const outletId = outletOf(query);
      await assertOutletInOrg(prisma, ctx, outletId); // another tenant's outlet is 404
      return tableBoard(prisma, ctx, outletId);
    },
  },
  {
    method: "GET",
    path: "manager",
    handler: async ({ ctx, query }) => {
      const outletId = outletOf(query);
      await assertOutletInOrg(prisma, ctx, outletId);
      return managerSummary(prisma, ctx, outletId);
    },
  },
]);
