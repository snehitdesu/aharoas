import { z } from "zod";
import { createRouter } from "@/server/api/router";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";

export const runtime = "nodejs";

export const { POST } = createRouter([
  // Create a PENDING payment for an order; success is only ever set by server-side verification.
  // Idempotency-Key header (preferred) or body field: a retry returns the original payment.
  {
    method: "POST", path: "",
    handler: ({ ctx, body, req }) => {
      const { orderId, ...input } = z.object({ orderId: z.string() }).passthrough().parse(body);
      const key = req.headers.get("idempotency-key") ?? undefined;
      return createPayment(ctx, orderId, { ...input, ...(key ? { idempotencyKey: key } : {}) } as never);
    },
  },
  { method: "POST", path: ":id/verify", handler: ({ ctx, params, body }) => verifyPayment(ctx, params.id, z.object({ providerRef: z.string().optional() }).parse(body)) },
  { method: "POST", path: ":id/refund", handler: ({ ctx, params, body }) => refundPayment(ctx, params.id, body as never) },
]);
