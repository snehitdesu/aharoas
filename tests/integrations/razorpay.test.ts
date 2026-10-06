/**
 * Razorpay adapter contract (no network): recorded Razorpay response shapes
 * served by a fake fetch. Checkout creation with the server's amount, checkout
 * signature + capture verification, order-status verification, webhook
 * signature + parsing, refunds, settlements, retries / timeout / malformed
 * responses, SANDBOX vs LIVE, and that no credential ever appears in an error.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { RazorpayPaymentProvider } from "@/integrations/payment";
import { IntegrationError, safeMessage } from "@/integrations/http";
import { ProviderUnavailableError } from "@/integrations/policy";

const KEY_ID = "rzp_test_ABCDEF123456";
const SECRET = "s3cr3t_key_secret_value_9876";
const WH = "webhook_secret_value_123456";
type Call = { url: string; method: string; body?: string; auth?: string };

function fake(routes: Record<string, (c: Call) => { status?: number; json?: unknown; text?: string } | "hang">) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", body: init.body as string | undefined, auth: (init.headers as Record<string, string> | undefined)?.Authorization };
    calls.push(c);
    const path = url.replace("https://api.razorpay.com/v1", "");
    const key = `${c.method} ${path.split("?")[0]}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { description: "not found" } }), { status: 404 });
    const r = h(c);
    if (r === "hang") return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
  };
  return { f, calls };
}
const provider = (routes: Parameters<typeof fake>[0], extra: Partial<ConstructorParameters<typeof RazorpayPaymentProvider>[0]> = {}) => {
  const { f, calls } = fake(routes);
  return { p: new RazorpayPaymentProvider({ keyId: KEY_ID, keySecret: SECRET, webhookSecret: WH, fetch: f, timeoutMs: 200, backoffMs: 5, ...extra }), calls };
};
const sig = (orderId: string, paymentId: string, secret = SECRET) => createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

describe("razorpay adapter", () => {
  it("mode follows the key; unconfigured is unavailable, never a silent mock", async () => {
    expect(new RazorpayPaymentProvider({ keyId: "rzp_live_X", keySecret: "y" }).mode).toBe("LIVE");
    expect(new RazorpayPaymentProvider({ keyId: KEY_ID, keySecret: "y" }).mode).toBe("SANDBOX");
    const none = new RazorpayPaymentProvider({ keyId: "", keySecret: "" });
    expect(await none.healthCheck()).toBe(false);
    await expect(none.createCheckout({ paymentId: "p1", orderId: "o1", amount: 10, currency: "INR" })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("creates a checkout for the server's amount in paise, authenticated with the key", async () => {
    const { p, calls } = provider({ "POST /orders": (c) => ({ json: { id: "order_9A", amount: JSON.parse(c.body!).amount, amount_paid: 0, status: "created" } }) });
    const s = await p.createCheckout({ paymentId: "pay_local_1", orderId: "ord_local_1", amount: 1081.5, currency: "INR" });
    expect(s).toMatchObject({ providerRef: "order_9A", checkout: { keyId: KEY_ID, orderId: "order_9A", amount: 108150, mode: "SANDBOX" } });
    expect(JSON.parse(calls[0].body!)).toMatchObject({ amount: 108150, currency: "INR", notes: { aharos_payment: "pay_local_1", aharos_order: "ord_local_1" } });
    expect(calls[0].auth).toBe(`Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString("base64")}`);
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("verifies the checkout signature, the payment's order, our order id, the amount and capture", async () => {
    const payment = (over: Record<string, unknown> = {}) => ({ id: "pay_X", amount: 50000, status: "captured", order_id: "order_A", notes: { aharos_order: "ord_1" }, ...over });
    let pay = payment();
    const { p } = provider({ "GET /payments/pay_X": () => ({ json: pay }) });
    const input = (payload: Record<string, unknown>) => ({ orderId: "ord_1", amount: 500, providerRef: "order_A", payload });
    const good = { razorpay_payment_id: "pay_X", razorpay_order_id: "order_A", razorpay_signature: sig("order_A", "pay_X") };
    expect(await p.verify(input(good))).toEqual({ verified: true, providerRef: "order_A" });
    expect((await p.verify(input({ ...good, razorpay_signature: sig("order_A", "pay_X", "wrong") }))).reason).toBe("Invalid checkout signature");
    expect((await p.verify({ ...input(good), providerRef: "order_OTHER" })).reason).toBe("Checkout belongs to a different payment");
    pay = payment({ amount: 100 });
    expect((await p.verify(input(good))).reason).toBe("Amount mismatch");
    pay = payment({ notes: { aharos_order: "someone_else" } });
    expect((await p.verify(input(good))).reason).toBe("Payment belongs to another order");
    pay = payment({ status: "authorized" });
    expect((await p.verify(input(good))).reason).toBe("Payment is authorized");
    pay = payment({ order_id: "order_B" });
    expect((await p.verify(input(good))).reason).toBe("Payment does not belong to this checkout");
  });

  it("without a checkout response (webhook path) the order must be paid in full", async () => {
    let order = { id: "order_A", amount: 50000, amount_paid: 50000, status: "paid" };
    const { p } = provider({ "GET /orders/order_A": () => ({ json: order }) });
    expect(await p.verify({ orderId: "o", amount: 500, providerRef: "order_A" })).toEqual({ verified: true, providerRef: "order_A" });
    // created / attempted: the guest has not paid yet (or is retrying in the same checkout) — undecided, never "failed".
    order = { ...order, status: "attempted", amount_paid: 0 };
    expect(await p.verify({ orderId: "o", amount: 500, providerRef: "order_A" })).toMatchObject({ verified: false, pending: true, reason: "Order is attempted" });
    order = { ...order, status: "created", amount_paid: 0 };
    expect(await p.verify({ orderId: "o", amount: 500, providerRef: "order_A" })).toMatchObject({ verified: false, pending: true });
    order = { ...order, status: "paid", amount_paid: 40000 };
    expect(await p.verify({ orderId: "o", amount: 500, providerRef: "order_A" })).toMatchObject({ verified: false, reason: "Amount mismatch" });
  });

  it("an authorized (not yet captured) payment is pending; a failed one is not", async () => {
    let status = "authorized";
    const { p } = provider({ "GET /payments/pay_X": () => ({ json: { id: "pay_X", amount: 50000, status, order_id: "order_A", notes: {} } }) });
    const good = { razorpay_payment_id: "pay_X", razorpay_order_id: "order_A", razorpay_signature: sig("order_A", "pay_X") };
    expect(await p.verify({ orderId: "o", amount: 500, providerRef: "order_A", payload: good })).toMatchObject({ verified: false, pending: true });
    status = "failed";
    const failed = await p.verify({ orderId: "o", amount: 500, providerRef: "order_A", payload: good });
    expect(failed).toMatchObject({ verified: false, reason: "Payment is failed" });
    expect(failed.pending).toBeUndefined();
  });

  it("an emulator base is honoured only where mocks are allowed, and is then reported as MOCK, never SANDBOX / LIVE", () => {
    const prev = { base: process.env.RAZORPAY_API_BASE, env: process.env.NODE_ENV, allow: process.env.ALLOW_MOCK_PROVIDERS };
    const env = process.env as Record<string, string | undefined>;
    try {
      env.RAZORPAY_API_BASE = "http://127.0.0.1:9/v1";
      expect(new RazorpayPaymentProvider({ keyId: "rzp_live_X", keySecret: "y" }).mode).toBe("MOCK");
      env.NODE_ENV = "production";
      delete env.ALLOW_MOCK_PROVIDERS;
      expect(new RazorpayPaymentProvider({ keyId: "rzp_live_X", keySecret: "y" }).mode).toBe("LIVE"); // the override is ignored
    } finally {
      env.RAZORPAY_API_BASE = prev.base;
      if (prev.base === undefined) delete env.RAZORPAY_API_BASE;
      env.NODE_ENV = prev.env;
      if (prev.allow === undefined) delete env.ALLOW_MOCK_PROVIDERS;
      else env.ALLOW_MOCK_PROVIDERS = prev.allow;
    }
  });

  it("resuming a checkout hands the browser public data only", () => {
    const p = new RazorpayPaymentProvider({ keyId: KEY_ID, keySecret: SECRET });
    const c = p.resumeCheckout({ providerRef: "order_Z", amount: 462, currency: "INR" });
    expect(c).toEqual({ provider: "razorpay", mode: "SANDBOX", keyId: KEY_ID, orderId: "order_Z", amount: 46200, currency: "INR" });
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  it("retries 5xx / 429 a bounded number of times; 4xx is final; malformed and timeouts are classified", async () => {
    let n = 0;
    const flaky = provider({ "GET /orders/order_A": () => (++n < 3 ? { status: 503, json: {} } : { json: { id: "order_A", amount: 100, amount_paid: 100, status: "paid" } }) });
    expect((await flaky.p.verify({ orderId: "o", amount: 1, providerRef: "order_A" })).verified).toBe(true);
    expect(flaky.calls).toHaveLength(3);
    const down = provider({ "GET /orders/order_A": () => ({ status: 503, json: {} }) });
    await expect(down.p.verify({ orderId: "o", amount: 1, providerRef: "order_A" })).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(down.calls).toHaveLength(3); // bounded
    const refused = provider({ "GET /orders/order_A": () => ({ status: 400, json: { error: { description: `bad key ${SECRET}` } } }) });
    const e = await refused.p.verify({ orderId: "o", amount: 1, providerRef: "order_A" }).catch((x) => x);
    expect(e).toBeInstanceOf(IntegrationError);
    expect(e).toMatchObject({ code: "REJECTED", retryable: false });
    expect(refused.calls).toHaveLength(1);
    const garbage = provider({ "GET /orders/order_A": () => ({ text: "<html>gateway error</html>" }) });
    await expect(garbage.p.verify({ orderId: "o", amount: 1, providerRef: "order_A" })).rejects.toMatchObject({ code: "MALFORMED" });
    const wrongShape = provider({ "GET /orders/order_A": () => ({ json: { hello: "world" } }) });
    await expect(wrongShape.p.verify({ orderId: "o", amount: 1, providerRef: "order_A" })).rejects.toMatchObject({ code: "MALFORMED" });
    const slow = provider({ "GET /orders/order_A": () => "hang" });
    await expect(slow.p.verify({ orderId: "o", amount: 1, providerRef: "order_A" })).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(slow.calls).toHaveLength(3);
  });

  it("webhook: signature over the raw body; captured / failed / refund events map to our references", () => {
    const { p } = provider({});
    const body = JSON.stringify({ entity: "event", account_id: "acc_1", event: "payment.captured", payload: { payment: { entity: { id: "pay_X", amount: 50000, status: "captured", order_id: "order_A" } } } });
    const good = createHmac("sha256", WH).update(body).digest("hex");
    expect(p.verifyWebhook(body, good)).toBe(true);
    expect(p.verifyWebhook(body, createHmac("sha256", "other").update(body).digest("hex"))).toBe(false);
    expect(p.verifyWebhook(body, undefined)).toBe(false);
    expect(p.verifyWebhook(body + " ", good)).toBe(false);
    expect(p.accountRef(JSON.parse(body))).toBe("acc_1");
    expect(p.parseWebhookEvent(JSON.parse(body))).toEqual({ eventId: "payment.captured:pay_X", type: "payment.captured", providerRef: "order_A", amount: 500 });
    const refund = { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_X", amount: 2000 } }, payment: { entity: { id: "pay_X", amount: 50000, status: "captured", order_id: "order_A" } } } };
    expect(p.parseWebhookEvent(refund)).toEqual({ eventId: "refund.processed:rfnd_1", type: "refund.processed", providerRef: "order_A", amount: 20, refundRef: "rfnd_1" });
    expect(p.parseWebhookEvent({ event: "order.notification", payload: {} }).type).toBe("unknown");
    expect(() => p.parseWebhookEvent({ event: "payment.captured" })).toThrow();
  });

  it("refunds the captured payment of the order; settlements page through payments", async () => {
    const { p, calls } = provider({
      "GET /orders/order_A/payments": () => ({ json: { items: [{ id: "pay_F", amount: 50000, status: "failed", order_id: "order_A" }, { id: "pay_X", amount: 50000, status: "captured", order_id: "order_A" }] } }),
      "POST /payments/pay_X/refund": (c) => ({ json: { id: "rfnd_9", amount: JSON.parse(c.body!).amount } }),
      "GET /payments": () => ({ json: { items: [{ id: "pay_X", amount: 50000, status: "captured", order_id: "order_A", created_at: 1791000000 }, { id: "pay_Y", amount: 100, status: "refunded", order_id: "order_B", created_at: 1791000001 }, { id: "pay_Z", amount: 100, status: "created", order_id: "order_C" }] } }),
    });
    expect(await p.refund({ providerRef: "order_A", amount: 120.5, idempotencyKey: "rf-key-1" })).toEqual({ refundRef: "rfnd_9" });
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ amount: 12050, notes: { aharos_refund_key: "rf-key-1" } });
    await expect(p.refund({ providerRef: "order_A", amount: 0 })).rejects.toMatchObject({ code: "REJECTED" });
    const rows = await p.getSettlements({ from: new Date("2026-09-01"), to: new Date("2026-10-31") });
    expect(rows.map((r) => [r.providerRef, r.status, r.amount])).toEqual([["order_A", "CAPTURED", 500], ["order_B", "REFUNDED", 1]]);
  });

  it("no credential ever reaches an error message", () => {
    expect(safeMessage(`failed: key_secret=${SECRET} Authorization: Basic cnpwX3Rlc3Q6c2VjcmV0 rzp_test_ABCDEF123456`)).not.toMatch(new RegExp(`${SECRET}|cnpwX3Rlc3Q6c2VjcmV0|ABCDEF123456`));
    expect(safeMessage("token=abc123 password: hunter2")).toBe("token=[redacted] password: [redacted]");
  });
});
