import { createHmac } from "node:crypto";
import { hmacMatches, stringAt } from "@/integrations/hmac";
import { z } from "zod";
import { OrderChannel, OrderSource, PaymentMethod } from "@/constants/enums";
import type { NormalizedOrder, POSProvider } from "./types";

// The mock provider accepts payloads already close to our normalized shape.
const payloadSchema = z.object({
  eventId: z.string(),
  externalRef: z.string(),
  /** The provider's restaurant/store id (tenant binding: IntegrationConnection.externalRef). */
  storeId: z.string().min(1),
  /** Optional hint; must equal the bound outlet or the delivery is rejected. */
  outletId: z.string().optional(),
  source: OrderSource.zod.default("PETPOOJA"),
  channel: OrderChannel.zod.default("AGGREGATOR"),
  placedAt: z.string().optional(),
  customer: z.object({ name: z.string().optional(), phone: z.string().optional() }).optional(),
  items: z.array(
    z.object({
      posItemCode: z.string(),
      name: z.string(),
      qty: z.number().positive(),
      unitPrice: z.number().nonnegative(),
      taxPct: z.number().nonnegative().optional(),
      modifiers: z.array(z.object({ name: z.string(), priceDelta: z.number() })).optional(),
    })
  ),
  discount: z.number().nonnegative().optional(),
  total: z.number().optional(),
  payments: z
    .array(z.object({ method: PaymentMethod.zod, amount: z.number().positive(), providerRef: z.string().optional() }))
    .optional(),
  settled: z.boolean().optional(),
});

/**
 * Local development POS provider. Signature = HMAC-SHA256 of the raw body with
 * PETPOOJA_WEBHOOK_SECRET (falls back to a dev secret). `getSettledOrders` reads
 * from an in-memory store that tests can seed.
 */
export class MockPOSProvider implements POSProvider {
  readonly name = "mock";
  constructor(private readonly settledStore: NormalizedOrder[] = []) {}

  private secret() {
    return process.env.PETPOOJA_WEBHOOK_SECRET ?? "dev-webhook-secret";
  }

  static sign(rawBody: string, secret = process.env.PETPOOJA_WEBHOOK_SECRET ?? "dev-webhook-secret") {
    return createHmac("sha256", secret).update(rawBody).digest("hex");
  }

  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean {
    return hmacMatches(rawBody, signature, secret ?? this.secret());
  }

  accountRef(payload: unknown): string | undefined {
    return stringAt(payload, "storeId");
  }

  normalizeOrder(payload: unknown): NormalizedOrder {
    const p = payloadSchema.parse(payload);
    return {
      eventId: p.eventId,
      externalRef: p.externalRef,
      outletId: p.outletId ?? "",
      source: p.source,
      channel: p.channel,
      placedAt: p.placedAt ? new Date(p.placedAt) : new Date(),
      customer: p.customer,
      items: p.items,
      discount: p.discount,
      total: p.total,
      payments: p.payments,
      settled: p.settled ?? true,
    };
  }

  async getSettledOrders(range: { from: Date; to: Date; outletId?: string }): Promise<NormalizedOrder[]> {
    return this.settledStore.filter(
      (o) => o.placedAt >= range.from && o.placedAt <= range.to && (!range.outletId || o.outletId === range.outletId)
    );
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}
