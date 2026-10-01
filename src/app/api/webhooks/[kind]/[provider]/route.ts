import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { receiveWebhook, type WebhookKind } from "@/server/services/webhooks";
import { fail } from "@/server/api/respond";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

const kinds: Record<string, WebhookKind> = { pos: "POS", payment: "PAYMENT", aggregator: "AGGREGATOR" };
const paramsSchema = z.object({ kind: z.enum(["pos", "payment", "aggregator"]), provider: z.string().regex(/^[a-z0-9_-]{1,40}$/i) });
const SIGNATURE_HEADERS = ["x-signature", "x-webhook-signature", "x-razorpay-signature", "x-petpooja-signature"];
const MAX_BODY = 1_000_000;

/**
 * Public webhook endpoint (no session: authenticity comes from the provider's
 * signature over the RAW body). 2xx = acknowledged (processed / duplicate /
 * ignored); 401 bad signature; 400 malformed; 503 processing failed (retry).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ kind: string; provider: string }> }) {
  try {
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) return NextResponse.json({ ok: false, error: { code: "NotFound", message: "Unknown webhook endpoint" } }, { status: 404 });
    await enforceRateLimit(RATE_POLICIES.webhook, `${parsed.data.kind}:${parsed.data.provider}:${clientIp(req)}`);
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY) return NextResponse.json({ ok: false, error: { code: "PayloadTooLarge", message: "Payload too large" } }, { status: 413 });
    const signature = SIGNATURE_HEADERS.map((h) => req.headers.get(h)).find(Boolean) ?? undefined;
    const result = await receiveWebhook({ kind: kinds[parsed.data.kind], provider: parsed.data.provider, rawBody, signature });
    // Never echo internal error details to the caller.
    const body = { ok: result.ok, status: result.status, eventId: result.eventId, ...(result.ok ? { orderId: result.orderId, paymentId: result.paymentId } : {}) };
    return NextResponse.json(body, { status: result.httpStatus });
  } catch (e) {
    return fail(e);
  }
}
