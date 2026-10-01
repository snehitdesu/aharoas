/**
 * Aggregator (Zomato/Swiggy/…) provider abstraction. Normalizes external orders
 * and settlements; core logic never depends on a specific aggregator. Only a
 * development/mock adapter exists: real adapters need partner credentials and
 * are NOT integrated. The mock verifies an HMAC signature and validates the
 * payload exactly like a real adapter would.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OrderSource, PaymentMethod } from "@/constants/enums";
import type { NormalizedOrder } from "@/integrations/pos/types";

export type AggregatorSettlementRow = {
  externalId: string;
  grossAmount: number;
  discount: number;
  commission: number;
  tax: number;
  platformFee: number;
  netPayout: number;
  settledAt: Date;
};

/** A normalized aggregator order plus the fee data needed for expected payouts. */
export type NormalizedAggregatorOrder = NormalizedOrder & { grossAmount: number; platformFee: number; taxAmount: number };

export interface AggregatorProvider {
  readonly name: string;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  normalizeOrder(payload: unknown): NormalizedAggregatorOrder;
  /** Settlement report for a period. */
  getSettlements(range: { from: Date; to: Date; outletId?: string }): Promise<AggregatorSettlementRow[]>;
  /** Default commission rate (%) if the Aggregator row has none configured. */
  commissionPct(): number;
  healthCheck(): Promise<boolean>;
}

const payloadSchema = z.object({
  eventId: z.string().min(1),
  externalId: z.string().min(1),
  outletId: z.string().min(1),
  placedAt: z.string().datetime().optional(),
  customer: z.object({ name: z.string().optional(), phone: z.string().optional() }).optional(),
  items: z.array(z.object({ posItemCode: z.string(), name: z.string(), qty: z.number().positive(), unitPrice: z.number().nonnegative(), taxPct: z.number().nonnegative().optional() })).min(1),
  discount: z.number().nonnegative().default(0),
  taxAmount: z.number().nonnegative().default(0),
  platformFee: z.number().nonnegative().default(0),
  paymentMethod: PaymentMethod.zod.default("ONLINE"),
});

export function signAggregatorPayload(rawBody: string, secret = process.env.AGGREGATOR_WEBHOOK_SECRET ?? "dev-webhook-secret") {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export class MockAggregatorProvider implements AggregatorProvider {
  constructor(
    readonly name: string = "mock",
    private readonly settlements: AggregatorSettlementRow[] = [],
    private readonly commission = 22
  ) {}

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = signAggregatorPayload(rawBody);
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  normalizeOrder(payload: unknown): NormalizedAggregatorOrder {
    const p = payloadSchema.parse(payload);
    const gross = p.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const payable = Math.round((gross - p.discount + p.taxAmount) * 100) / 100;
    const upper = this.name.toUpperCase();
    return {
      eventId: p.eventId,
      externalRef: p.externalId,
      outletId: p.outletId,
      source: OrderSource.is(upper) ? upper : "ONLINE",
      channel: "AGGREGATOR",
      placedAt: p.placedAt ? new Date(p.placedAt) : new Date(),
      customer: p.customer,
      items: p.items,
      discount: p.discount,
      total: payable,
      // The aggregator collected the money from the guest.
      payments: [{ method: p.paymentMethod, amount: payable, providerRef: `${this.name}:${p.externalId}` }],
      settled: true,
      grossAmount: gross,
      platformFee: p.platformFee,
      taxAmount: p.taxAmount,
    };
  }

  async getSettlements(range: { from: Date; to: Date }): Promise<AggregatorSettlementRow[]> {
    return this.settlements.filter((s) => s.settledAt >= range.from && s.settledAt <= range.to);
  }

  commissionPct(): number {
    return this.commission;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/** Only mock adapters exist today; real Zomato/Swiggy adapters require partner credentials. */
export function getAggregatorProvider(name = "mock"): AggregatorProvider {
  return new MockAggregatorProvider(name.toLowerCase());
}
