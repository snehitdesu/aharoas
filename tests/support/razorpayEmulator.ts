/**
 * Razorpay API emulator — TEST SUPPORT ONLY.
 *
 * A local HTTP server speaking the subset of Razorpay's REST API RESTORA's
 * adapter uses (orders, payments, refunds; Basic auth with key id / secret),
 * plus test controls that play the customer's side of Checkout: an attempt
 * that is captured, declined or only authorized, and the signed webhooks
 * Razorpay would send. Signatures use the same algorithms as Razorpay:
 *   checkout:  HMAC-SHA256(key_secret, "<order_id>|<payment_id>")  (hex)
 *   webhook:   HMAC-SHA256(webhook_secret, raw body)                (hex, X-Razorpay-Signature)
 *
 * The app reaches it through RAZORPAY_API_BASE, which the adapter honours only
 * where mock providers are allowed and then reports as mode MOCK. It exists so
 * the complete Razorpay path (adapter → payment service → webhook route →
 * order / KOT / invoice / finance) runs in automated tests without credentials.
 * It is NOT evidence that Razorpay itself accepts these requests: that needs a
 * run with real rzp_test_ keys (e2e/razorpay-sandbox.spec.ts).
 */
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type EmulatorConfig = { keyId: string; keySecret: string; webhookSecret: string; accountId: string; port?: number; webhookUrl?: string };

type Order = { id: string; entity: "order"; amount: number; amount_paid: number; amount_due: number; currency: string; receipt: string | null; status: "created" | "attempted" | "paid"; notes: Record<string, unknown>; attempts: number; created_at: number };
type Payment = { id: string; entity: "payment"; amount: number; currency: string; status: "created" | "authorized" | "captured" | "failed" | "refunded"; order_id: string; notes: Record<string, unknown>; amount_refunded: number; error_description: string | null; created_at: number };
type Refund = { id: string; entity: "refund"; amount: number; payment_id: string; created_at: number };

export type AttemptOutcome = "captured" | "failed" | "authorized";
export type CheckoutResponse = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };

const id = (prefix: string) => `${prefix}_${randomBytes(7).toString("base64url").replace(/[-_]/g, "x")}`;
const now = () => Math.floor(Date.now() / 1000);

export class RazorpayEmulator {
  readonly orders = new Map<string, Order>();
  readonly payments = new Map<string, Payment>();
  readonly refunds = new Map<string, Refund>();
  /** Every authenticated API call, for assertions ("no gateway order was created twice"). */
  readonly calls: Array<{ method: string; path: string }> = [];
  private server: http.Server | null = null;
  url = "";

  constructor(readonly cfg: EmulatorConfig) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(this.cfg.port ?? 0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  // ---------------- the customer's side of Checkout ----------------

  /** One payment attempt on a gateway order, as Checkout would make it. */
  attempt(orderId: string, outcome: AttemptOutcome, opts: { amount?: number } = {}): { payment: Payment; response: CheckoutResponse | null } {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`emulator: unknown order ${orderId}`);
    const amount = opts.amount ?? order.amount;
    const payment: Payment = { id: id("pay"), entity: "payment", amount, currency: order.currency, status: outcome, order_id: order.id, notes: {}, amount_refunded: 0, error_description: outcome === "failed" ? "Your payment has been declined by the bank (test)." : null, created_at: now() };
    this.payments.set(payment.id, payment);
    order.attempts++;
    if (outcome === "captured") this.markPaid(order, amount);
    else if (order.status === "created") order.status = "attempted";
    // Checkout calls the success handler (with a signature) only for a successful payment.
    return { payment, response: outcome === "failed" ? null : this.signedResponse(order.id, payment.id) };
  }

  /** Capture an authorized payment (Razorpay auto-capture, a little later). */
  capture(paymentId: string): Payment {
    const p = this.payments.get(paymentId);
    if (!p || p.status !== "authorized") throw new Error(`emulator: payment ${paymentId} is not authorized`);
    p.status = "captured";
    this.markPaid(this.orders.get(p.order_id)!, p.amount);
    return p;
  }

  signedResponse(orderId: string, paymentId: string, secret = this.cfg.keySecret): CheckoutResponse {
    return { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex") };
  }

  private markPaid(order: Order, amount: number) {
    order.amount_paid += amount;
    order.amount_due = Math.max(0, order.amount - order.amount_paid);
    order.status = order.amount_paid >= order.amount ? "paid" : "attempted";
  }

  // ---------------- webhooks ----------------

  /** The signed webhook Razorpay would send for a payment event. */
  webhook(event: "payment.captured" | "payment.failed" | "payment.authorized" | "refund.processed", paymentId: string, opts: { refundId?: string; secret?: string; accountId?: string; amount?: number } = {}): { rawBody: string; signature: string } {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error(`emulator: unknown payment ${paymentId}`);
    const payment = { ...p, ...(opts.amount !== undefined ? { amount: opts.amount } : {}) };
    const payload: Record<string, unknown> = { payment: { entity: payment } };
    if (event === "refund.processed") {
      const rf = this.refunds.get(opts.refundId ?? "");
      if (!rf) throw new Error("emulator: refund.processed needs a refund");
      payload.refund = { entity: rf };
    }
    const rawBody = JSON.stringify({ entity: "event", account_id: opts.accountId ?? this.cfg.accountId, event, contains: Object.keys(payload), payload, created_at: now() });
    return { rawBody, signature: createHmac("sha256", opts.secret ?? this.cfg.webhookSecret).update(rawBody).digest("hex") };
  }

  /** POST a webhook to the app, as Razorpay does. Returns the HTTP status and body. */
  async deliver(event: Parameters<RazorpayEmulator["webhook"]>[0], paymentId: string, opts: Parameters<RazorpayEmulator["webhook"]>[2] = {}): Promise<{ status: number; body: unknown }> {
    if (!this.cfg.webhookUrl) throw new Error("emulator: no webhookUrl configured");
    const { rawBody, signature } = this.webhook(event, paymentId, opts);
    const res = await fetch(this.cfg.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature }, body: rawBody });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  // ---------------- REST API ----------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const error = (status: number, description: string) => send(status, { error: { code: "BAD_REQUEST_ERROR", description } });
    try {
      const url = new URL(req.url ?? "/", "http://emulator");
      const auth = req.headers.authorization ?? "";
      const expected = `Basic ${Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64")}`;
      if (auth !== expected) return error(401, "The api key provided is invalid");
      const path = url.pathname.replace(/^\/v1/, "");
      this.calls.push({ method: req.method ?? "GET", path });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      let m: RegExpMatchArray | null;

      if (req.method === "POST" && path === "/orders") {
        if (!Number.isInteger(body.amount) || body.amount < 100) return error(400, "The amount must be atleast INR 1.00");
        const order: Order = { id: id("order"), entity: "order", amount: body.amount, amount_paid: 0, amount_due: body.amount, currency: body.currency ?? "INR", receipt: body.receipt ?? null, status: "created", notes: body.notes ?? {}, attempts: 0, created_at: now() };
        this.orders.set(order.id, order);
        return send(200, order);
      }
      if (req.method === "GET" && (m = path.match(/^\/orders\/([^/]+)$/))) {
        const o = this.orders.get(decodeURIComponent(m[1]));
        return o ? send(200, o) : error(400, "The id provided does not exist");
      }
      if (req.method === "GET" && (m = path.match(/^\/orders\/([^/]+)\/payments$/))) {
        const items = [...this.payments.values()].filter((p) => p.order_id === decodeURIComponent(m![1]));
        return send(200, { entity: "collection", count: items.length, items });
      }
      if (req.method === "GET" && (m = path.match(/^\/payments\/([^/]+)$/))) {
        const p = this.payments.get(decodeURIComponent(m[1]));
        return p ? send(200, p) : error(400, "The id provided does not exist");
      }
      if (req.method === "GET" && path === "/payments") {
        const from = Number(url.searchParams.get("from") ?? 0);
        const to = Number(url.searchParams.get("to") ?? Number.MAX_SAFE_INTEGER);
        const count = Number(url.searchParams.get("count") ?? 10);
        const skip = Number(url.searchParams.get("skip") ?? 0);
        const items = [...this.payments.values()].filter((p) => p.created_at >= from && p.created_at <= to).slice(skip, skip + count);
        return send(200, { entity: "collection", count: items.length, items });
      }
      if (req.method === "POST" && (m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
        const p = this.payments.get(decodeURIComponent(m[1]));
        if (!p || (p.status !== "captured" && p.status !== "refunded")) return error(400, "The payment has not been captured");
        const amount = body.amount ?? p.amount - p.amount_refunded;
        if (amount > p.amount - p.amount_refunded) return error(400, "The refund amount provided is greater than amount captured");
        const rf: Refund = { id: id("rfnd"), entity: "refund", amount, payment_id: p.id, created_at: now() };
        this.refunds.set(rf.id, rf);
        p.amount_refunded += amount;
        if (p.amount_refunded >= p.amount) p.status = "refunded";
        return send(200, rf);
      }
      return error(404, "The requested URL was not found on the server.");
    } catch (e) {
      return error(500, String((e as Error).message));
    }
  }
}
