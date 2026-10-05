/**
 * Aggregator (Zomato/Swiggy/…) provider abstraction. Normalizes external orders
 * and settlements; core logic never depends on a specific aggregator. Only a
 * development/mock adapter exists: real adapters need partner credentials and
 * are NOT integrated. The mock verifies an HMAC signature and validates the
 * payload exactly like a real adapter would.
 */
import { createHmac } from "node:crypto";
import { hmacMatches, stringAt } from "@/integrations/hmac";
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

/** A cancellation from the platform (customer / platform cancelled the order). */
export type AggregatorCancellation = { eventId: string; externalId: string; reason: string; outletId?: string };
/** Order states RESTORA reports back to the platform. */
export type AggregatorOutboundStatus = "ACCEPTED" | "READY" | "CANCELLED";

export interface AggregatorProvider {
  readonly name: string;
  /** MOCK for the development adapter; real partner adapters would be SANDBOX / LIVE. */
  readonly mode: "MOCK" | "SANDBOX" | "LIVE";
  /** order.placed → "ORDER", order.cancelled → "CANCEL", anything else → "UNKNOWN" (acknowledged, ignored). */
  eventKind(payload: unknown): "ORDER" | "CANCEL" | "UNKNOWN";
  /** Validate + normalize a cancellation (signature already verified). */
  parseCancellation(payload: unknown): AggregatorCancellation;
  /** Report an order state to the platform. Optional capability. */
  pushStatus?(input: { externalId: string; status: AggregatorOutboundStatus }): Promise<{ providerRef: string }>;
  /**
   * Verify the webhook signature. `secret` is the tenant's own signing secret
   * (IntegrationConnection) when one is configured; otherwise the adapter's
   * deployment-wide secret applies.
   */
  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean;
  /**
   * The provider's identifier for the sending account/store, read from the
   * (not yet verified) payload. Used ONLY to look up the tenant binding and its
   * secret; never trusted as an internal organization/outlet id.
   */
  accountRef(payload: unknown): string | undefined;
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
  /** The aggregator's store id (tenant binding: IntegrationConnection.externalRef). */
  storeId: z.string().min(1),
  /** Optional hint; must equal the bound outlet or the delivery is rejected. */
  outletId: z.string().min(1).optional(),
  placedAt: z.string().datetime().optional(),
  customer: z.object({ name: z.string().optional(), phone: z.string().optional() }).optional(),
  event: z.string().default("order.placed"),
  items: z.array(z.object({
    posItemCode: z.string(), name: z.string(), qty: z.number().positive(), unitPrice: z.number().nonnegative(), taxPct: z.number().nonnegative().optional(),
    /** Add-ons as billed by the platform (per unit); kept as order-line modifiers. */
    modifiers: z.array(z.object({ name: z.string().min(1).max(80), priceDelta: z.number().nonnegative().default(0) })).max(20).optional(),
  })).min(1),
  discount: z.number().nonnegative().default(0),
  taxAmount: z.number().nonnegative().default(0),
  platformFee: z.number().nonnegative().default(0),
  paymentMethod: PaymentMethod.zod.default("ONLINE"),
});

export function signAggregatorPayload(rawBody: string, secret = process.env.AGGREGATOR_WEBHOOK_SECRET ?? "dev-webhook-secret") {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

const cancelSchema = z.object({ eventId: z.string().min(1), event: z.literal("order.cancelled"), externalId: z.string().min(1), storeId: z.string().min(1), outletId: z.string().min(1).optional(), reason: z.string().max(200).default("Cancelled on the platform") });

/**
 * MOCK aggregator adapter (development / tests). It verifies an HMAC signature
 * and validates payloads like a partner adapter would, but no Swiggy / Zomato
 * API is contacted: status pushes are recorded in memory and labelled MOCK.
 */
export class MockAggregatorProvider implements AggregatorProvider {
  readonly mode = "MOCK" as const;
  readonly pushed: Array<{ externalId: string; status: AggregatorOutboundStatus }> = [];
  eventKind(payload: unknown): "ORDER" | "CANCEL" | "UNKNOWN" {
    const e = stringAt(payload, "event") ?? "order.placed";
    return e === "order.placed" ? "ORDER" : e === "order.cancelled" ? "CANCEL" : "UNKNOWN";
  }
  parseCancellation(payload: unknown): AggregatorCancellation {
    const p = cancelSchema.parse(payload);
    return { eventId: p.eventId, externalId: p.externalId, reason: p.reason, outletId: p.outletId };
  }
  async pushStatus(input: { externalId: string; status: AggregatorOutboundStatus }): Promise<{ providerRef: string }> {
    this.pushed.push(input);
    return { providerRef: `mockstatus_${input.externalId}_${input.status}` };
  }
  constructor(
    readonly name: string = "mock",
    private readonly settlements: AggregatorSettlementRow[] = [],
    private readonly commission = 22
  ) {}

  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean {
    return hmacMatches(rawBody, signature, secret ?? process.env.AGGREGATOR_WEBHOOK_SECRET ?? "dev-webhook-secret");
  }

  accountRef(payload: unknown): string | undefined {
    return stringAt(payload, "storeId");
  }

  normalizeOrder(payload: unknown): NormalizedAggregatorOrder {
    const p = payloadSchema.parse(payload);
    const gross = p.items.reduce((s, i) => s + i.qty * (i.unitPrice + (i.modifiers ?? []).reduce((m, x) => m + x.priceDelta, 0)), 0);
    const payable = Math.round((gross - p.discount + p.taxAmount) * 100) / 100;
    const upper = this.name.toUpperCase();
    return {
      eventId: p.eventId,
      externalRef: p.externalId,
      outletId: p.outletId ?? "",
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
