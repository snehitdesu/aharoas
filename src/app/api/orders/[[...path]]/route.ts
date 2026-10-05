import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { createOrder, placeOrder, addOrderItem, updateOrderItem, applyDiscount, submitOrder, fireOrderItems, cancelOrder, getOrder, listOrders, addOrderRound, removeOrderItem, requestBill } from "@/server/services/orders";
import { getOrderBill } from "@/server/services/bill";
import { issueInvoice, setOrderBuyer } from "@/server/services/invoicing";
import { runAfterCommit } from "@/server/services/afterCommit";
import type { AccessContext } from "@/server/db/scope";

/** New kitchen tickets → auto-print / guest message, after the commit (never fails the request). */
function kotsCreated<T>(ctx: AccessContext, orderId: string, result: T): T {
  runAfterCommit("kots-created", async () => (await import("@/server/services/integrationHooks")).afterKotsCreated(ctx, orderId));
  return result;
}

export const runtime = "nodejs";

const itemPatch = z.object({ qty: z.number().positive().optional(), discount: z.number().nonnegative().optional(), notes: z.string().max(500).optional() });

export const { GET, POST, PATCH, DELETE } = createRouter([
  { method: "GET", path: "", handler: ({ ctx, query }) => listOrders(prisma, ctx, query as never) },
  {
    method: "POST", path: "",
    // Idempotency-Key header (preferred) or body field: retries return the original order.
    handler: ({ ctx, body, req }) => {
      const key = req.headers.get("idempotency-key") ?? undefined;
      const input = { ...(body as object), ...(key ? { idempotencyKey: key } : {}) };
      // With `items`: atomic POS placement (order + lines [+ kitchen]) in one idempotent transaction.
      if (!Array.isArray((body as { items?: unknown }).items)) return createOrder(ctx, input as never);
      return placeOrder(ctx, input as never).then((o) => ((input as { submit?: unknown }).submit === true && !o.replayed ? kotsCreated(ctx, o.id, o) : o));
    },
  },
  { method: "GET", path: ":id", handler: ({ ctx, params }) => getOrder(prisma, ctx, params.id) },
  // Bill / receipt (view, print, reprint): a rendering of the server's order — identical on every request.
  { method: "GET", path: ":id/bill", handler: ({ ctx, params }) => getOrderBill(prisma, ctx, params.id) },
  // B2B buyer details (before payment) and invoice issuance for already-paid orders.
  { method: "POST", path: ":id/buyer", handler: ({ ctx, params, body }) => setOrderBuyer(ctx, params.id, body as never) },
  { method: "POST", path: ":id/invoice", handler: ({ ctx, params }) => issueInvoice(ctx, params.id) },
  { method: "POST", path: ":id/items", handler: ({ ctx, params, body }) => addOrderItem(ctx, params.id, body as never) },
  { method: "PATCH", path: "items/:itemId", handler: ({ ctx, params, body }) => updateOrderItem(ctx, params.itemId, itemPatch.parse(body)) },
  { method: "POST", path: ":id/discount", handler: ({ ctx, params, body }) => applyDiscount(ctx, params.id, z.object({ amount: z.number().nonnegative() }).parse(body).amount) },
  // A round of menu items (+ send to kitchen) in one transaction; Idempotency-Key makes a retry return the original round.
  { method: "POST", path: ":id/rounds", handler: ({ ctx, params, body, req }) => addOrderRound(ctx, params.id, body as never, req.headers.get("idempotency-key") ?? undefined).then((r) => (r.round.fired && !r.round.replayed ? kotsCreated(ctx, params.id, r) : r)) },
  // Remove a line that was never sent to the kitchen.
  { method: "DELETE", path: "items/:itemId", handler: ({ ctx, params }) => removeOrderItem(ctx, params.itemId) },
  { method: "POST", path: ":id/request-bill", handler: ({ ctx, params }) => requestBill(ctx, params.id) },
  { method: "POST", path: ":id/submit", handler: ({ ctx, params }) => submitOrder(ctx, params.id).then((r) => kotsCreated(ctx, params.id, r)) },
  { method: "POST", path: ":id/fire", handler: ({ ctx, params }) => fireOrderItems(ctx, params.id).then((r) => (r.length ? kotsCreated(ctx, params.id, r) : r)) },
  { method: "POST", path: ":id/cancel", reauth: "order.void", handler: ({ ctx, params, body }) => cancelOrder(ctx, params.id, z.object({ reason: z.string().min(3).max(500) }).parse(body).reason) },
]);
