import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { findCustomer, createCustomer, updateCustomer, customerOrderHistory, customerStats, segmentCustomers, createFeedback, listFeedback } from "@/server/services/crm";

export const runtime = "nodejs";

const page = z.object({ take: z.coerce.number().int().positive().max(200).optional(), cursor: z.string().optional() });

export const { GET, POST, PATCH } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => findCustomer(prisma, ctx, page.extend({ phone: z.string().optional(), search: z.string().max(100).optional() }).parse(query)) },
  { method: "POST", path: "", handler: ({ ctx, body }) => createCustomer(ctx, body as never) },
  { method: "GET", path: "segments", handler: ({ ctx, query }) => segmentCustomers(prisma, ctx, page.parse(query)) },
  { method: "GET", path: "feedback", handler: ({ ctx, query }) => listFeedback(prisma, ctx, page.extend({ outletId: z.string().optional() }).parse(query)) },
  { method: "POST", path: "feedback", handler: ({ ctx, body }) => createFeedback(ctx, body as never) },
  { method: "GET", path: ":id", handler: async ({ ctx, params }) => (await findCustomer(prisma, ctx, { id: params.id }))[0] ?? null },
  { method: "PATCH", path: ":id", handler: ({ ctx, params, body }) => updateCustomer(ctx, params.id, body as never) },
  { method: "GET", path: ":id/orders", handler: ({ ctx, params, query }) => customerOrderHistory(prisma, ctx, params.id, page.parse(query)) },
  { method: "GET", path: ":id/stats", handler: ({ ctx, params }) => customerStats(prisma, ctx, params.id) },
]);
