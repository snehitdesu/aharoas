import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedOrder, POSProvider } from "./types";

/**
 * Petpooja adapter skeleton. Petpooja-specific field mapping lives ONLY here;
 * the domain never sees Petpooja's payload shape. Requires credentials for live
 * calls; in development use POS_PROVIDER=mock.
 */
export class PetpoojaPOSProvider implements POSProvider {
  readonly name = "petpooja";

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    const secret = process.env.PETPOOJA_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  normalizeOrder(payload: unknown): NormalizedOrder {
    // Map Petpooja's "SaveOrder"/push payload into NormalizedOrder.
    // The exact field names come from Petpooja's integration spec; this maps the
    // common ones and must be completed against a live account's payload.
    const p = payload as Record<string, any>;
    const order = p.Order ?? p.order ?? p;
    const items = (p.OrderItem ?? p.items ?? []) as Array<Record<string, any>>;
    return {
      eventId: String(order.orderID ?? order.order_id ?? order.ref_id ?? crypto.randomUUID()),
      externalRef: String(order.orderID ?? order.order_id ?? order.ref_id),
      outletId: String(p.restID ?? p.outletId ?? order.restID ?? ""),
      source: "PETPOOJA",
      channel: (order.order_type ?? "AGGREGATOR") as NormalizedOrder["channel"],
      placedAt: order.created_on ? new Date(order.created_on) : new Date(),
      customer: { name: order.customer_name, phone: order.customer_phone },
      items: items.map((it) => ({
        posItemCode: String(it.itemid ?? it.item_id ?? it.code),
        name: String(it.name ?? it.item_name ?? ""),
        qty: Number(it.quantity ?? it.qty ?? 1),
        unitPrice: Number(it.price ?? it.rate ?? 0),
        taxPct: it.tax ? Number(it.tax) : undefined,
      })),
      discount: order.discount ? Number(order.discount) : undefined,
      total: order.total ? Number(order.total) : undefined,
      settled: true,
    };
  }

  async getSettledOrders(): Promise<NormalizedOrder[]> {
    throw new Error("PetpoojaPOSProvider.getSettledOrders requires PETPOOJA_APP_KEY/SECRET; use POS_PROVIDER=mock in development.");
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(process.env.PETPOOJA_APP_KEY && process.env.PETPOOJA_APP_SECRET);
  }
}
