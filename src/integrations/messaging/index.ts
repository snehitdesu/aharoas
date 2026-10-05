/**
 * Customer messaging (SMS / WhatsApp) adapters.
 *
 *  - "mock": never contacts anyone. It accepts the message and returns a
 *    MOCK-labelled reference; deliveries made with it are shown as MOCK and
 *    never as delivered to a phone. (Development / demos.)
 *  - "twilio": Twilio Programmable Messaging over REST (SMS, and WhatsApp via
 *    the "whatsapp:" address prefix). Credentials are the tenant's own,
 *    decrypted only for the call; status callbacks are verified with Twilio's
 *    X-Twilio-Signature. Contract-tested against recorded Twilio response
 *    shapes — not run against a live Twilio account here. Its mode (SANDBOX /
 *    LIVE) is what the operator declared for the connection.
 *
 * Neither adapter is called by the domain directly: services/messaging.ts
 * decides IF a message is sent (opt-in per template), records it in the
 * outbox (IntegrationDelivery) and calls the adapter.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { basicAuth, IntegrationError, requestJson, type FetchLike } from "@/integrations/http";
import type { IntegrationMode } from "@/integrations/payment/types";

export type MessageChannel = "SMS" | "WHATSAPP";
export type OutboundMessage = { channel: MessageChannel; to: string; body: string };
export type SendOutcome = { providerRef: string; status: "SENT" | "QUEUED" };
export type StatusUpdate = { providerRef: string; status: "SENT" | "DELIVERED" | "FAILED"; error?: string };

export interface MessagingProvider {
  readonly name: string;
  readonly mode: IntegrationMode;
  send(msg: OutboundMessage, opts?: { statusCallbackUrl?: string }): Promise<SendOutcome>;
  /** Verify a status callback; `url` is the exact public URL the provider called. */
  verifyStatusCallback(url: string, params: Record<string, string>, signature: string | undefined): boolean;
  parseStatusCallback(params: Record<string, string>): StatusUpdate | null;
  healthCheck(): Promise<boolean>;
}

/** E.164 for Indian 10-digit numbers; anything else must already be +E.164. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

/** +91******3210 — what is stored / shown about a destination. */
export const maskPhone = (e164: string) => (e164.length > 6 ? `${e164.slice(0, 3)}${"*".repeat(e164.length - 7)}${e164.slice(-4)}` : "***");

export class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  readonly mode: IntegrationMode = "MOCK";
  readonly sent: OutboundMessage[] = [];
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    this.sent.push(msg);
    return { providerRef: `mockmsg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, status: "SENT" };
  }
  verifyStatusCallback(): boolean {
    return false; // a mock never calls back
  }
  parseStatusCallback(): StatusUpdate | null {
    return null;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export type TwilioCredentials = { accountSid: string; authToken: string; smsFrom?: string; whatsappFrom?: string };
export const twilioCredentialsSchema = z.object({
  accountSid: z.string().regex(/^AC[a-f0-9]{32}$/i, "Twilio Account SID starts with AC"),
  authToken: z.string().min(16).max(64),
  smsFrom: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  whatsappFrom: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
}).strict();

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const twilioMessage = z.object({ sid: z.string(), status: z.string() });

export class TwilioMessagingProvider implements MessagingProvider {
  readonly name = "twilio";
  private readonly fetchImpl: FetchLike;
  constructor(private readonly creds: TwilioCredentials, readonly mode: IntegrationMode, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /** Not retried inside the call: an SMS whose response was lost may have been sent — the outbox decides. */
  async send(msg: OutboundMessage, opts: { statusCallbackUrl?: string } = {}): Promise<SendOutcome> {
    const from = msg.channel === "WHATSAPP" ? this.creds.whatsappFrom : this.creds.smsFrom;
    if (!from) throw new IntegrationError("NOT_CONFIGURED", `No ${msg.channel === "WHATSAPP" ? "WhatsApp" : "SMS"} sender number is configured`, false);
    const prefix = msg.channel === "WHATSAPP" ? "whatsapp:" : "";
    const form = new URLSearchParams({ To: `${prefix}${msg.to}`, From: `${prefix}${from}`, Body: msg.body });
    if (opts.statusCallbackUrl) form.set("StatusCallback", opts.statusCallbackUrl);
    const raw = await requestJson<unknown>(this.fetchImpl, `${TWILIO_API}/Accounts/${encodeURIComponent(this.creds.accountSid)}/Messages.json`, {
      method: "POST", attempts: 1, timeoutMs: 10000,
      headers: { Authorization: basicAuth(this.creds.accountSid, this.creds.authToken), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const m = twilioMessage.safeParse(raw);
    if (!m.success) throw new IntegrationError("MALFORMED", "Twilio returned an unexpected response", false);
    if (m.data.status === "failed" || m.data.status === "undelivered") throw new IntegrationError("REJECTED", `Twilio did not accept the message (${m.data.status})`, false);
    return { providerRef: m.data.sid, status: m.data.status === "sent" || m.data.status === "delivered" ? "SENT" : "QUEUED" };
  }

  /** Twilio: base64(HMAC-SHA1(authToken, url + Σ sorted(key + value))). */
  verifyStatusCallback(url: string, params: Record<string, string>, signature: string | undefined): boolean {
    if (!signature) return false;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
    const expected = Buffer.from(createHmac("sha1", this.creds.authToken).update(data).digest("base64"));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  parseStatusCallback(params: Record<string, string>): StatusUpdate | null {
    const sid = params.MessageSid;
    const s = (params.MessageStatus ?? "").toLowerCase();
    if (!sid || !s) return null;
    if (s === "delivered" || s === "read") return { providerRef: sid, status: "DELIVERED" };
    if (s === "failed" || s === "undelivered") return { providerRef: sid, status: "FAILED", error: params.ErrorCode ? `Twilio error ${params.ErrorCode}` : "Not delivered" };
    if (s === "sent") return { providerRef: sid, status: "SENT" };
    return null; // queued / accepted / sending: no change
  }

  async healthCheck(): Promise<boolean> {
    try {
      await requestJson<unknown>(this.fetchImpl, `${TWILIO_API}/Accounts/${encodeURIComponent(this.creds.accountSid)}.json`, { headers: { Authorization: basicAuth(this.creds.accountSid, this.creds.authToken) }, attempts: 2 });
      return true;
    } catch {
      return false;
    }
  }
}
