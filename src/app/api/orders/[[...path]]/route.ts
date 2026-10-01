import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { createOrder, placeOrder, addOrderItem, updateOrderItem, applyDiscount, submitOrder, fireOrderItems, cancelOrder, getOrder, listOrders } from "@/server/services/orders";

export const runtime = "nodejs";

const itemPatch = z.object({ qty: z.number().positive().optional(), discount: z.number().nonnegative().optional(), notes: z.string().max(500).optional() });

export const { GET, POST, PATCH } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listOrders(prisma, ctx, query as never) },
  {
    method: "POST", path: "",
    // Idempotency-Key header (preferred) or body field: retries return the original order.
    handler: ({ ctx, body, req }) => {
      const key = req.headers.get("idempotency-key") ?? undefined;
      const input = { ...(body as object), ...(key ? { idempotencyKey: key } : {}) };
      // With `items`: atomic POS placement (order + lines [+ kitchen]) in one idempotent transaction.
      return Array.isArray((body as { items?: unknown }).items) ? placeOrder(ctx, input as never) : createOrder(ctx, input as never);
    },
  },
  { method: "GET", path: ":id", handler: ({ ctx, params }) => getOrder(prisma, ctx, params.id) },
  { method: "POST", path: ":id/items", handler: ({ ctx, params, body }) => addOrderItem(ctx, params.id, body as never) },
  { method: "PATCH", path: "items/:itemId", handler: ({ ctx, params, body }) => updateOrderItem(ctx, params.itemId, itemPatch.parse(body)) },
  { method: "POST", path: ":id/discount", handler: ({ ctx, params, body }) => applyDiscount(ctx, params.id, z.object({ amount: z.number().nonnegative() }).parse(body).amount) },
  { method: "POST", path: ":id/submit", handler: ({ ctx, params }) => submitOrder(ctx, params.id) },
  { method: "POST", path: ":id/fire", handler: ({ ctx, params }) => fireOrderItems(ctx, params.id) },
  { method: "POST", path: ":id/cancel", handler: ({ ctx, params, body }) => cancelOrder(ctx, params.id, z.object({ reason: z.string().min(3).max(500) }).parse(body).reason) },
]);
