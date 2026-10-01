import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { assertMockAllowed, unknownProvider } from "@/integrations/policy";
import { z } from "zod";
import type { PaymentProvider, PaymentSettlementRow, PaymentWebhookEvent, RefundRequest, VerifyResult } from "./types";

const KNOWN_EVENTS = ["payment.captured", "payment.failed", "refund.processed"] as const;
const webhookSchema = z
  .object({
    eventId: z.string().min(1),
    event: z.string().min(1),
    providerRef: z.string().min(1),
    amount: z.number().nonnegative(),
    refundRef: z.string().min(1).optional(),
  })
  .refine((e) => e.event !== "refund.processed" || Boolean(e.refundRef), "refund.processed requires refundRef");

export function signPaymentPayload(rawBody: string, secret = process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-webhook-secret") {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Local development payment provider. Cash/counter payments verify as long as
 * the amount is positive. Online payments require a providerRef to simulate a
 * gateway confirmation. Never used to blindly trust the client.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  /** Tests/dev inject the settlement report the "gateway" would return. */
  constructor(private readonly settlements: PaymentSettlementRow[] = []) {}
  async getSettlements(range: { from: Date; to: Date }): Promise<PaymentSettlementRow[]> {
    return this.settlements.filter((s) => s.settledAt >= range.from && s.settledAt <= range.to);
  }
  async verify(input: { orderId: string; amount: number; providerRef?: string }): Promise<VerifyResult> {
    if (input.amount <= 0) return { verified: false, reason: "Non-positive amount" };
    return { verified: true, providerRef: input.providerRef ?? `mock_${input.orderId}_${Date.now()}` };
  }
  parseWebhookEvent(payload: unknown): PaymentWebhookEvent {
    const p = webhookSchema.parse(payload);
    const type = (KNOWN_EVENTS as readonly string[]).includes(p.event) ? (p.event as PaymentWebhookEvent["type"]) : "unknown";
    return { eventId: p.eventId, type, providerRef: p.providerRef, amount: p.amount, refundRef: p.refundRef };
  }
  /** Deterministic for a given idempotency key (so a retried refund maps to the same gateway refund). */
  async refund(input: RefundRequest): Promise<{ refundRef: string }> {
    if (input.amount <= 0) throw new Error("Refund amount must be positive");
    const seed = input.idempotencyKey ? `${input.providerRef}|${input.amount}|${input.idempotencyKey}` : randomUUID();
    return { refundRef: `mockrf_${createHash("sha256").update(seed).digest("hex").slice(0, 20)}` };
  }
  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = signPaymentPayload(rawBody);
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Skeleton for a real gateway (Razorpay/Stripe). Kept as an adapter so the
 * domain layer never imports gateway SDKs directly.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = "razorpay";
  async verify(): Promise<VerifyResult> {
    // TODO: call Razorpay Orders/Payments API with server keys to confirm capture.
    throw new Error("RazorpayPaymentProvider requires PAYMENT credentials; use POS/payment mock in development.");
  }
  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret || !signature) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
  async healthCheck(): Promise<boolean> {
    return false;
  }
  async getSettlements(): Promise<PaymentSettlementRow[]> {
    throw new Error("RazorpayPaymentProvider settlements require PAYMENT credentials; not configured.");
  }
  parseWebhookEvent(): PaymentWebhookEvent {
    throw new Error("RazorpayPaymentProvider webhook parsing is not implemented; configure a real adapter.");
  }
  async refund(): Promise<{ refundRef: string }> {
    throw new Error("RazorpayPaymentProvider refunds require PAYMENT credentials; not configured.");
  }
}

/** Providers that hold customer money and must execute refunds themselves. */
export const GATEWAY_PROVIDERS = new Set(["mock", "razorpay"]);

export function getPaymentProvider(name?: string): PaymentProvider {
  const provider = (name ?? process.env.PAYMENT_PROVIDER ?? "mock").toLowerCase();
  switch (provider) {
    case "razorpay":
      return new RazorpayPaymentProvider();
    case "mock":
      assertMockAllowed("payment");
      return new MockPaymentProvider();
    default:
      return unknownProvider("payment", provider);
  }
}

export type { PaymentProvider, PaymentSettlementRow, PaymentWebhookEvent, RefundRequest, VerifyResult } from "./types";
