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
  /** Internal outlet. From a webhook this is set from the tenant binding; a body value is only a hint that must match. */
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
  normalizeOrder(payload: unknown): NormalizedOrder;
  /** For nightly reconciliation: settled orders in a date range. */
  getSettledOrders(range: { from: Date; to: Date; outletId?: string }): Promise<NormalizedOrder[]>;
  healthCheck(): Promise<boolean>;
}
