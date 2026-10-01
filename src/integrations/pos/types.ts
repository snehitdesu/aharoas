/**
 * POS provider abstraction. Core domain logic depends ONLY on this interface
 * and the NormalizedOrder shape — never on a specific vendor (Petpooja, etc.).
 */
import type { OrderChannel, OrderSource, PaymentMethod } from "@/constants/enums";

export type NormalizedOrderItem = {
  posItemCode: string;
  name: string;
  qty: number;
  unitPrice: number;
  taxPct?: number;
  modifiers?: Array<{ name: string; priceDelta: number }>;
};

export type NormalizedPayment = {
  method: PaymentMethod;
  amount: number;
  providerRef?: string;
};

export type NormalizedOrder = {
  /** Provider's stable order id — used for order idempotency. */
  externalRef: string;
  /** Provider's webhook event id — used for webhook idempotency. */
  eventId: string;
  /** Internal outlet id this order belongs to (provider store -> our outlet). */
  outletId: string;
  source: OrderSource;
  channel: OrderChannel;
  placedAt: Date;
  customer?: { name?: string; phone?: string };
  items: NormalizedOrderItem[];
  discount?: number;
  total?: number;
  /** Pre-settled payments (aggregator/online orders arrive already paid). */
  payments?: NormalizedPayment[];
  /** true if the provider has already collected payment (mark order PAID). */
  settled?: boolean;
};

export interface POSProvider {
  readonly name: string;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  normalizeOrder(payload: unknown): NormalizedOrder;
  /** For nightly reconciliation: settled orders in a date range. */
  getSettledOrders(range: { from: Date; to: Date; outletId?: string }): Promise<NormalizedOrder[]>;
  healthCheck(): Promise<boolean>;
}
