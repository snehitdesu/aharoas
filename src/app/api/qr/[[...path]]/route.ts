import { createGuestRouter } from "@/server/api/guestRouter";
import { RATE_POLICIES } from "@/server/api/rateLimit";
import { guestMenu, placeGuestOrder, getGuestOrder, startGuestPayment, confirmGuestPayment } from "@/server/services/guestOrdering";

export const runtime = "nodejs";

// Anonymous guest QR ordering. Tenant context comes only from the table token
// (server-side lookup); an order is reachable only with its access key, sent in
// the x-order-key header (never in the URL, so it stays out of access logs).
export const { GET, POST } = createGuestRouter([
  { method: "GET", path: "t/:token", handler: ({ params }) => guestMenu(params.token) },
  {
    method: "POST", path: "t/:token/orders",
    limits: [{ policy: RATE_POLICIES.guestOrderPerTable, key: ({ params }) => params.token }],
    handler: ({ params, body, req, ip }) => placeGuestOrder(params.token, body, req.headers.get("idempotency-key"), { ip, userAgent: req.headers.get("user-agent") ?? undefined }),
  },
  { method: "GET", path: "orders/:id", handler: ({ params, req }) => getGuestOrder(params.id, req.headers.get("x-order-key")) },
  { method: "POST", path: "orders/:id/payments", handler: ({ params, req }) => startGuestPayment(params.id, req.headers.get("x-order-key"), req.headers.get("idempotency-key")) },
  { method: "POST", path: "orders/:id/payments/confirm", handler: ({ params, req, body }) => confirmGuestPayment(params.id, req.headers.get("x-order-key"), body) },
]);
