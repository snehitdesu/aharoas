import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { loyaltyBalance, loyaltyHistory, earnPoints, redeemPoints, adjustPoints, expirePoints } from "@/server/services/loyalty";

export const runtime = "nodejs";

export const { GET, POST } = createRouter([
  { method: "GET", path: "customers/:id", handler: async ({ ctx, params, query }) => ({ balance: await loyaltyBalance(prisma, ctx, params.id), history: await loyaltyHistory(prisma, ctx, params.id, z.object({ take: z.coerce.number().int().positive().max(200).optional(), cursor: z.string().optional() }).parse(query)) }) },
  // Points are always computed server-side from a PAID order; no client-supplied amounts.
  { method: "POST", path: "earn", handler: ({ ctx, body }) => earnPoints(ctx, z.object({ orderId: z.string() }).parse(body)) },
  { method: "POST", path: "redeem", handler: ({ ctx, body }) => redeemPoints(ctx, body as never) },
  { method: "POST", path: "adjust", handler: ({ ctx, body }) => adjustPoints(ctx, body as never) },
  { method: "POST", path: "expire", handler: ({ ctx, body }) => expirePoints(ctx, body as never) },
]);
