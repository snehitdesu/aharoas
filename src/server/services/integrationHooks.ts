/**
 * Business events → integrations (always via runAfterCommit, never inside a
 * business transaction). Every hook is a no-op unless the organization set
 * the integration up (printer / messaging connection / aggregator order), and
 * swallows its own errors (they are recorded on PrintJob / IntegrationDelivery).
 */
import type { AccessContext } from "@/server/db/scope";
import { autoPrintKots, kickDrawerAfter } from "@/server/services/printing";
import { queueOrderMessage } from "@/server/services/messaging";
import { pushAggregatorStatus } from "@/server/services/aggregatorSync";

/** New kitchen tickets: auto-print them; tell the guest the order is confirmed (if enabled). */
export async function afterKotsCreated(ctx: AccessContext, orderId: string) {
  await autoPrintKots(ctx, orderId);
  await queueOrderMessage(ctx, { template: "ORDER_CONFIRMED", orderId, auto: true });
}

/** The order is fully paid: receipt message (if enabled); cash → open the drawer; prepaid tickets → print. */
export async function afterPaymentSettled(ctx: AccessContext, p: { orderId: string; outletId: string; method: string }) {
  await autoPrintKots(ctx, p.orderId);
  await queueOrderMessage(ctx, { template: "PAYMENT_RECEIVED", orderId: p.orderId, auto: true });
  if (p.method === "CASH") await kickDrawerAfter(ctx, p.outletId, "Cash sale");
}

/** Every live ticket of the order is READY: tell the guest (if enabled) and the ordering platform. */
export async function afterOrderReady(ctx: AccessContext, orderId: string) {
  await queueOrderMessage(ctx, { template: "ORDER_READY", orderId, auto: true });
  await pushAggregatorStatus(ctx, orderId, "READY");
}

/** Cash moved in / out of the drawer outside a sale (float, pay-in, pay-out). */
export async function afterCashMovement(ctx: AccessContext, outletId: string, reason: string) {
  await kickDrawerAfter(ctx, outletId, reason);
}
