import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { hmacMatches, stringAt } from "@/integrations/hmac";
import { assertMockAllowed, mockProvidersAllowed, ProviderUnavailableError, unknownProvider } from "@/integrations/policy";
import { basicAuth, IntegrationError, requestJson, type FetchLike } from "@/integrations/http";
import { z } from "zod";
import type { CheckoutRequest, CheckoutSession, IntegrationMode, PaymentProvider, PaymentSettlementRow, PaymentWebhookEvent, ProviderPaymentStatus, RefundRequest, VerifyResult } from "./types";

const KNOWN_EVENTS = ["payment.captured", "payment.failed", "refund.processed"] as const;
const webhookSchema = z
  .object({
    eventId: z.string().min(1),
    /** The merchant account the event belongs to (tenant binding: IntegrationConnection.externalRef). */
    accountId: z.string().min(1),
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
 * MOCK payment provider (development / tests only — refused in production
 * unless ALLOW_MOCK_PROVIDERS=true). It never contacts a gateway: counter
 * payments verify when the amount is positive; the simulated checkout can be
 * told to decline. It is labelled MOCK everywhere it is shown.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly mode: IntegrationMode = "MOCK";
  /** Tests/dev inject the settlement report the "gateway" would return. */
  constructor(private readonly settlements: PaymentSettlementRow[] = []) {}
  async getSettlements(range: { from: Date; to: Date }): Promise<PaymentSettlementRow[]> {
    return this.settlements.filter((s) => s.settledAt >= range.from && s.settledAt <= range.to);
  }
  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    return { providerRef: `mockorder_${input.paymentId}`, checkout: { provider: "mock", mode: "MOCK", amount: input.amount, currency: input.currency } };
  }
  resumeCheckout(input: { providerRef: string; amount: number; currency: string }): Record<string, string | number> {
    return { provider: "mock", mode: "MOCK", orderId: input.providerRef, amount: paise(input.amount), currency: input.currency };
  }
  async getPaymentStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    return { status: "UNKNOWN", amount: 0, providerRef };
  }
  async verify(input: { orderId: string; amount: number; providerRef?: string; payload?: unknown }): Promise<VerifyResult> {
    if (input.amount <= 0) return { verified: false, reason: "Non-positive amount" };
    // The simulated checkout can decline (exercises the failure/retry path in
    // development; this adapter is refused in production, see policy.ts).
    if ((input.payload as { mockOutcome?: unknown } | undefined)?.mockOutcome === "decline") return { verified: false, reason: "Declined by the test gateway" };
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
  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean {
    return hmacMatches(rawBody, signature, secret ?? process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-webhook-secret");
  }
  accountRef(payload: unknown): string | undefined {
    return stringAt(payload, "accountId");
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Razorpay (REST, no SDK). SANDBOX with rzp_test_ keys, LIVE with rzp_live_ keys.
// ---------------------------------------------------------------------------

const RAZORPAY_API = "https://api.razorpay.com/v1";
const paise = (rupees: number) => Math.round(rupees * 100);
const rupees = (p: number) => Math.round(p) / 100;

export type RazorpayConfig = { keyId?: string; keySecret?: string; webhookSecret?: string; fetch?: FetchLike; timeoutMs?: number; backoffMs?: number; apiBase?: string };

/**
 * RAZORPAY_API_BASE points the adapter at a Razorpay-compatible emulator for
 * automated end-to-end tests. Honoured ONLY where mock providers are allowed
 * (never on a production deployment without ALLOW_MOCK_PROVIDERS=true, which
 * startup validation refuses together with this variable), and the adapter then
 * reports mode MOCK: it is not talking to Razorpay.
 */
function configuredApiBase(): string | undefined {
  const v = process.env.RAZORPAY_API_BASE?.trim();
  return v && mockProvidersAllowed() ? v.replace(/\/+$/, "") : undefined;
}

const rzpPayment = z.object({ id: z.string(), amount: z.number(), status: z.string(), order_id: z.string().nullish(), notes: z.union([z.record(z.unknown()), z.array(z.unknown())]).nullish(), created_at: z.number().optional() });
const rzpOrder = z.object({ id: z.string(), amount: z.number(), amount_paid: z.number().default(0), status: z.string() });
const rzpList = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), count: z.number().optional() });
const rzpWebhook = z.object({
  account_id: z.string().optional(),
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: rzpPayment }).optional(),
    refund: z.object({ entity: z.object({ id: z.string(), payment_id: z.string(), amount: z.number() }) }).optional(),
  }),
});

function hexEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Razorpay adapter over its REST API. Server-side only: the amount of every
 * checkout is the Payment row's (computed by the payment service), the checkout
 * signature is checked with the key secret, and capture is confirmed by asking
 * Razorpay — the browser's word is never enough. Credentials come from the
 * environment (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET)
 * and never appear in errors or responses. Contract-tested against recorded
 * Razorpay response shapes; it has not been run against a live account here.
 */
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = "razorpay";
  private readonly keyId?: string;
  private readonly keySecret?: string;
  private readonly webhookSecret?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly api: string;
  private readonly emulated: boolean;

  constructor(cfg: RazorpayConfig = {}) {
    const base = cfg.apiBase ?? configuredApiBase();
    this.api = base ?? RAZORPAY_API;
    this.emulated = Boolean(base) && base !== RAZORPAY_API;
    this.timeoutMs = cfg.timeoutMs ?? 8000;
    this.backoffMs = cfg.backoffMs ?? 250;
    this.keyId = cfg.keyId ?? process.env.RAZORPAY_KEY_ID;
    this.keySecret = cfg.keySecret ?? process.env.RAZORPAY_KEY_SECRET;
    this.webhookSecret = cfg.webhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? process.env.PAYMENT_WEBHOOK_SECRET;
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
  }

  get mode(): IntegrationMode {
    if (this.emulated) return "MOCK";
    return this.keyId?.startsWith("rzp_live_") ? "LIVE" : "SANDBOX";
  }
  get configured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  private auth() {
    if (!this.keyId || !this.keySecret) throw new ProviderUnavailableError("Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
    return { Authorization: basicAuth(this.keyId, this.keySecret), "Content-Type": "application/json" };
  }
  private get<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
    return requestJson<unknown>(this.fetchImpl, `${this.api}${path}`, { headers: this.auth(), attempts: 3, timeoutMs: this.timeoutMs, backoffMs: this.backoffMs }).then((r) => {
      const p = schema.safeParse(r);
      if (!p.success) throw new IntegrationError("MALFORMED", "Razorpay returned an unexpected response", false);
      return p.data;
    });
  }

  /** A Razorpay order for the server-computed amount. Not retried (Razorpay orders have no idempotency key; a retry would only leave an unused order). */
  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    const body = JSON.stringify({ amount: paise(input.amount), currency: input.currency, receipt: input.paymentId.slice(0, 40), notes: { aharos_payment: input.paymentId, aharos_order: input.orderId } });
    const raw = await requestJson<unknown>(this.fetchImpl, `${this.api}/orders`, { method: "POST", headers: this.auth(), body, attempts: 1, timeoutMs: this.timeoutMs });
    const order = rzpOrder.safeParse(raw);
    if (!order.success || order.data.amount !== paise(input.amount)) throw new IntegrationError("MALFORMED", "Razorpay returned an unexpected order", false);
    return { providerRef: order.data.id, checkout: { provider: "razorpay", mode: this.mode, keyId: this.keyId!, orderId: order.data.id, amount: order.data.amount, currency: input.currency } };
  }

  resumeCheckout(input: { providerRef: string; amount: number; currency: string }): Record<string, string | number> {
    if (!this.keyId) throw new ProviderUnavailableError("Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)");
    return { provider: "razorpay", mode: this.mode, keyId: this.keyId, orderId: input.providerRef, amount: paise(input.amount), currency: input.currency };
  }

  /**
   * Confirm capture. With the checkout response (razorpay_payment_id /
   * razorpay_order_id / razorpay_signature) the signature is checked with the
   * key secret and the payment is fetched; without it (webhook path) the order
   * itself must be paid in full. Either way the amount and our order id must match.
   */
  async verify(input: { orderId: string; amount: number; providerRef?: string; payload?: unknown }): Promise<VerifyResult> {
    const p = (input.payload ?? {}) as Record<string, unknown>;
    if (typeof p.razorpay_signature === "string") {
      const paymentId = String(p.razorpay_payment_id ?? "");
      const orderRef = String(p.razorpay_order_id ?? "");
      if (!paymentId || !orderRef) return { verified: false, reason: "Incomplete checkout response" };
      if (input.providerRef && input.providerRef !== orderRef) return { verified: false, reason: "Checkout belongs to a different payment" };
      const expected = createHmac("sha256", this.keySecret ?? "").update(`${orderRef}|${paymentId}`).digest("hex");
      if (!this.keySecret || !hexEquals(expected, p.razorpay_signature)) return { verified: false, reason: "Invalid checkout signature" };
      const pay = await this.get(`/payments/${encodeURIComponent(paymentId)}`, rzpPayment);
      const notes = (pay.notes && !Array.isArray(pay.notes) ? pay.notes : {}) as Record<string, unknown>;
      if (pay.order_id !== orderRef) return { verified: false, reason: "Payment does not belong to this checkout" };
      if (notes.aharos_order !== undefined && notes.aharos_order !== input.orderId) return { verified: false, reason: "Payment belongs to another order" };
      if (pay.amount !== paise(input.amount)) return { verified: false, reason: "Amount mismatch" };
      // created / authorized: not captured YET (auto-capture runs shortly after; the webhook confirms it).
      if (pay.status === "created" || pay.status === "authorized") return { verified: false, pending: true, reason: `Payment is ${pay.status}` };
      if (pay.status !== "captured") return { verified: false, reason: `Payment is ${pay.status}` };
      return { verified: true, providerRef: orderRef };
    }
    if (!input.providerRef) return { verified: false, reason: "No gateway reference" };
    const order = await this.get(`/orders/${encodeURIComponent(input.providerRef)}`, rzpOrder);
    // created / attempted: the guest has not paid (or is retrying inside the same checkout) — undecided, not failed.
    if (order.status === "created" || order.status === "attempted") return { verified: false, pending: true, reason: `Order is ${order.status}` };
    if (order.status !== "paid") return { verified: false, reason: `Order is ${order.status}` };
    if (order.amount_paid !== paise(input.amount)) return { verified: false, reason: "Amount mismatch" };
    return { verified: true, providerRef: order.id };
  }

  async getPaymentStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const order = await this.get(`/orders/${encodeURIComponent(providerRef)}`, rzpOrder);
    return { providerRef, amount: rupees(order.amount_paid), status: order.status === "paid" ? "CAPTURED" : order.status === "attempted" ? "PENDING" : "PENDING" };
  }

  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean {
    return hmacMatches(rawBody, signature, secret ?? this.webhookSecret);
  }
  /** Razorpay webhooks carry the merchant account id at the top level. */
  accountRef(payload: unknown): string | undefined {
    return stringAt(payload, "account_id");
  }

  /**
   * payment.captured / payment.failed → the payment's ORDER id (= Payment.providerRef);
   * refund.processed → the refund id + amount. Event ids are derived from the
   * entity id so a redelivery dedupes.
   */
  parseWebhookEvent(payload: unknown): PaymentWebhookEvent {
    const w = rzpWebhook.parse(payload);
    const pay = w.payload.payment?.entity;
    if (w.event === "refund.processed") {
      const rf = w.payload.refund?.entity;
      if (!rf || !pay?.order_id) throw new Error("refund.processed without refund / payment order");
      return { eventId: `refund.processed:${rf.id}`, type: "refund.processed", providerRef: pay.order_id, amount: rupees(rf.amount), refundRef: rf.id };
    }
    if (!pay) return { eventId: `${w.event}:unknown`, type: "unknown", providerRef: "unknown", amount: 0 };
    if (!pay.order_id) throw new Error("Payment without an order id");
    const type = w.event === "payment.captured" || w.event === "payment.failed" ? w.event : "unknown";
    return { eventId: `${w.event}:${pay.id}`, type, providerRef: pay.order_id, amount: rupees(pay.amount) };
  }

  /** Refund the captured payment of a Razorpay order. Not retried automatically (a lost response must be reconciled, not repeated). */
  async refund(input: RefundRequest): Promise<{ refundRef: string }> {
    if (input.amount <= 0) throw new IntegrationError("REJECTED", "Refund amount must be positive", false);
    const list = await this.get(`/orders/${encodeURIComponent(input.providerRef)}/payments`, rzpList(rzpPayment));
    const captured = list.items.find((p) => p.status === "captured" || p.status === "refunded");
    if (!captured) throw new IntegrationError("REJECTED", "No captured payment on this Razorpay order", false);
    const raw = await requestJson<unknown>(this.fetchImpl, `${this.api}/payments/${encodeURIComponent(captured.id)}/refund`, {
      method: "POST", headers: this.auth(), attempts: 1, timeoutMs: this.timeoutMs,
      body: JSON.stringify({ amount: paise(input.amount), notes: input.idempotencyKey ? { aharos_refund_key: input.idempotencyKey } : {} }),
    });
    const rf = z.object({ id: z.string(), amount: z.number() }).safeParse(raw);
    if (!rf.success || rf.data.amount !== paise(input.amount)) throw new IntegrationError("MALFORMED", "Razorpay returned an unexpected refund", false);
    return { refundRef: rf.data.id };
  }

  /** Payments Razorpay recorded in the range (captured / refunded / failed), for GATEWAY reconciliation. */
  async getSettlements(range: { from: Date; to: Date }): Promise<PaymentSettlementRow[]> {
    const out: PaymentSettlementRow[] = [];
    const from = Math.floor(range.from.getTime() / 1000);
    const to = Math.floor(range.to.getTime() / 1000);
    for (let skip = 0, page = 0; page < 20; page++, skip += 100) {
      const list = await this.get(`/payments?from=${from}&to=${to}&count=100&skip=${skip}`, rzpList(rzpPayment));
      for (const p of list.items) {
        if (!p.order_id) continue;
        const status = p.status === "captured" ? "CAPTURED" : p.status === "refunded" ? "REFUNDED" : p.status === "failed" ? "FAILED" : null;
        if (status) out.push({ providerRef: p.order_id, amount: rupees(p.amount), status, settledAt: new Date((p.created_at ?? from) * 1000) });
      }
      if (list.items.length < 100) break;
    }
    return out;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      await this.get("/payments?count=1", rzpList(rzpPayment));
      return true;
    } catch {
      return false;
    }
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

export type { CheckoutRequest, CheckoutSession, IntegrationMode, PaymentProvider, PaymentSettlementRow, PaymentWebhookEvent, ProviderPaymentStatus, RefundRequest, VerifyResult } from "./types";
