import { hmacMatches, stringAt } from "@/integrations/hmac";
import type { NormalizedOrder, POSProvider } from "./types";

/**
 * Petpooja adapter skeleton. Petpooja-specific field mapping lives ONLY here;
 * the domain never sees Petpooja's payload shape. Requires credentials for live
 * calls; in development use POS_PROVIDER=mock.
 */
export class PetpoojaPOSProvider implements POSProvider {
  readonly name = "petpooja";

  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean {
    return hmacMatches(rawBody, signature, secret ?? process.env.PETPOOJA_WEBHOOK_SECRET);
  }

  /** Petpooja's restaurant id identifies the sending account (mapped to an outlet by IntegrationConnection). */
  accountRef(payload: unknown): string | undefined {
    return stringAt(payload, "restID") ?? stringAt(payload, "Order", "restID") ?? stringAt(payload, "order", "restID");
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
      // restID is Petpooja's id, NOT ours: the outlet comes from the tenant binding (accountRef -> IntegrationConnection).
      outletId: typeof p.outletId === "string" ? p.outletId : "",
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
