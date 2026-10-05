/**
 * Payment provider abstraction. The domain never trusts the client's claim that
 * a payment succeeded — it asks a provider to verify server-side.
 */
export type VerifyResult = { verified: boolean; providerRef?: string; reason?: string };

/** A gateway webhook event, normalized. */
export type PaymentWebhookEvent = {
  eventId: string;
  /** "unknown" = an event type this system does not act on (acknowledged, ignored). */
  type: "payment.captured" | "payment.failed" | "refund.processed" | "unknown";
  /** Gateway payment id. */
  providerRef: string;
  amount: number;
  /** Gateway refund id (refund.processed only). */
  refundRef?: string;
};

export type RefundRequest = { providerRef: string; amount: number; idempotencyKey?: string };

/** One row of a gateway settlement report (what the provider says it captured/settled). */
export type PaymentSettlementRow = { providerRef: string; amount: number; status: "CAPTURED" | "REFUNDED" | "FAILED"; settledAt: Date };

/** What an adapter really is: MOCK never leaves the process; SANDBOX / LIVE talk to the provider's test / live environment. */
export type IntegrationMode = "MOCK" | "SANDBOX" | "LIVE";

/** A gateway-side checkout (e.g. a Razorpay order) for a server-computed amount. */
export type CheckoutRequest = { paymentId: string; orderId: string; amount: number; currency: string };
export type CheckoutSession = {
  /** The gateway's reference stored on Payment.providerRef (webhooks resolve payments by it). */
  providerRef: string;
  /** Public data the browser checkout needs (never a secret). */
  checkout: Record<string, string | number>;
};

/** Provider-side state of a payment, for status checks and reconciliation. */
export type ProviderPaymentStatus = { status: "PENDING" | "CAPTURED" | "FAILED" | "REFUNDED" | "UNKNOWN"; amount: number; providerRef: string };

export interface PaymentProvider {
  readonly name: string;
  /** MOCK / SANDBOX / LIVE, decided by the adapter from its configuration — never by the caller. */
  readonly mode: IntegrationMode;
  /** Create the gateway-side checkout for a server-computed amount. Optional: counter / test providers have none. */
  createCheckout?(input: CheckoutRequest): Promise<CheckoutSession>;
  /** Ask the gateway for the current state of a payment. Optional capability. */
  getPaymentStatus?(providerRef: string): Promise<ProviderPaymentStatus>;
  /** Verify a payment server-side (e.g. call the gateway or check a signature). */
  verify(input: { orderId: string; amount: number; providerRef?: string; payload?: unknown }): Promise<VerifyResult>;
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
  /** Validate + normalize a (signature-verified) webhook payload. Throws on malformed input. */
  parseWebhookEvent(payload: unknown): PaymentWebhookEvent;
  healthCheck(): Promise<boolean>;
  /** Execute a refund at the gateway; returns the gateway refund id. Optional capability. */
  refund?(input: RefundRequest): Promise<{ refundRef: string }>;
  /** Settlement report for reconciliation. Optional: not every gateway exposes one. */
  getSettlements?(range: { from: Date; to: Date }): Promise<PaymentSettlementRow[]>;
}
