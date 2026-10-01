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

export interface PaymentProvider {
  readonly name: string;
  /** Verify a payment server-side (e.g. call the gateway or check a signature). */
  verify(input: { orderId: string; amount: number; providerRef?: string; payload?: unknown }): Promise<VerifyResult>;
  /** Verify a webhook signature. */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
  /** Validate + normalize a (signature-verified) webhook payload. Throws on malformed input. */
  parseWebhookEvent(payload: unknown): PaymentWebhookEvent;
  healthCheck(): Promise<boolean>;
  /** Execute a refund at the gateway; returns the gateway refund id. Optional capability. */
  refund?(input: RefundRequest): Promise<{ refundRef: string }>;
  /** Settlement report for reconciliation. Optional: not every gateway exposes one. */
  getSettlements?(range: { from: Date; to: Date }): Promise<PaymentSettlementRow[]>;
}
