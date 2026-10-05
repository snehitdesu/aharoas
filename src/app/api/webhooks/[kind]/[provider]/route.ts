import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { receiveWebhook, type WebhookKind } from "@/server/services/webhooks";
import { handleMessagingStatus } from "@/server/services/messaging";
import { prisma } from "@/server/db/client";
import { fail } from "@/server/api/respond";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { log, withRequestContext } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import { recordWebhookFailure } from "@/server/observability/alerts";
import { newRequestId } from "@/server/observability/timing";

export const runtime = "nodejs";

const kinds: Record<string, WebhookKind> = { pos: "POS", payment: "PAYMENT", aggregator: "AGGREGATOR" };
const paramsSchema = z.object({ kind: z.enum(["pos", "payment", "aggregator", "messaging"]), provider: z.string().regex(/^[a-z0-9_-]{1,40}$/i) });
const SIGNATURE_HEADERS = ["x-signature", "x-webhook-signature", "x-razorpay-signature", "x-petpooja-signature", "x-twilio-signature"];
const MAX_BODY = 1_000_000;

/**
 * Public webhook endpoint (no session: authenticity comes from the provider's
 * signature over the RAW body). 2xx = acknowledged (processed / duplicate /
 * ignored); 401 bad signature; 400 malformed; 503 processing failed (retry).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ kind: string; provider: string }> }) {
  const requestId = newRequestId(req.headers.get("x-request-id"));
  const res = await withRequestContext({ requestId, method: "POST", path: req.nextUrl.pathname }, () => handle(req, ctx));
  res.headers.set("x-request-id", requestId);
  return res;
}

/** Count + log one webhook outcome (fixed vocabularies only; never the payload or signature). */
function observe(kind: string, provider: string, status: string, httpStatus: number, reason?: string) {
  inc("restora_webhooks_total", { kind, status });
  if (httpStatus >= 500) recordWebhookFailure(kind);
  if (httpStatus >= 400) log.warn("webhook not processed", { event: "webhook", kind, provider, status, httpStatus, reason });
  else log.info("webhook", { event: "webhook", kind, provider, status });
}

async function handle(req: NextRequest, { params }: { params: Promise<{ kind: string; provider: string }> }) {
  try {
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) return NextResponse.json({ ok: false, error: { code: "NotFound", message: "Unknown webhook endpoint" } }, { status: 404 });
    await enforceRateLimit(RATE_POLICIES.webhook, `${parsed.data.kind}:${parsed.data.provider}:${clientIp(req)}`);
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY) return NextResponse.json({ ok: false, error: { code: "PayloadTooLarge", message: "Payload too large" } }, { status: 413 });
    const signature = SIGNATURE_HEADERS.map((h) => req.headers.get(h)).find(Boolean) ?? undefined;
    if (parsed.data.kind === "messaging") {
      // Delivery-status callbacks (form-encoded). The signature covers the PUBLIC url the provider called.
      const publicUrl = process.env.PUBLIC_BASE_URL ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/messaging/${parsed.data.provider}` : req.url;
      const params = Object.fromEntries(new URLSearchParams(rawBody).entries());
      const r = await handleMessagingStatus(prisma, parsed.data.provider.toLowerCase(), publicUrl, params, signature);
      observe("messaging", parsed.data.provider, r.status, r.httpStatus);
      return NextResponse.json({ ok: r.httpStatus < 300, status: r.status }, { status: r.httpStatus });
    }
    const result = await receiveWebhook({ kind: kinds[parsed.data.kind]!, provider: parsed.data.provider, rawBody, signature });
    observe(parsed.data.kind, parsed.data.provider, result.status, result.httpStatus, result.reason);
    // Never echo internal error details to the caller.
    const body = { ok: result.ok, status: result.status, eventId: result.eventId, ...(result.ok ? { orderId: result.orderId, paymentId: result.paymentId } : {}) };
    return NextResponse.json(body, { status: result.httpStatus });
  } catch (e) {
    return fail(e);
  }
}
