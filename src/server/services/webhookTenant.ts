/**
 * Webhook tenant binding (H4). Every inbound webhook is bound to exactly one
 * organization/outlet through a server-side IntegrationConnection keyed by the
 * provider's own account/store id — never through organizationId/outletId in
 * the request body.
 *
 *   accountRef(payload) -> IntegrationConnection(kind, provider, externalRef)
 *     -> signature verified with THAT tenant's secret (if it has one; the
 *        deployment-wide secret is then not accepted for it)
 *     -> tenant = { organizationId, outletId } from the connection
 *
 * Event ids are namespaced per tenant account, so two restaurants' providers
 * reusing an id never collide (and one tenant's replay can't swallow another's
 * event). Nothing is mutated before the signature is verified.
 */
import type { PrismaClient } from "@prisma/client";
import { systemContext } from "@/server/auth/context";
import { raiseAnomaly } from "@/server/services/anomaly";
import { decryptSecret } from "@/server/integrations/secrets";

export type WebhookKind = "POS" | "PAYMENT" | "AGGREGATOR";
export type WebhookTenant = { connectionId: string; organizationId: string; outletId: string | null; externalRef: string };

type Verifier = { readonly name: string; verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean; accountRef(payload: unknown): string | undefined };

export type TenantAuth =
  | { ok: true; payload: unknown; tenant: WebhookTenant }
  | { ok: false; reason: "INVALID_SIGNATURE" | "MALFORMED" | "UNKNOWN_ACCOUNT"; signatureValid: boolean };

export async function authenticateWebhook(db: PrismaClient, kind: WebhookKind, provider: Verifier, rawBody: string, signature: string | undefined): Promise<TenantAuth> {
  let payload: unknown;
  let parsed = true;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    parsed = false;
  }
  let ref: string | undefined;
  try {
    ref = parsed ? provider.accountRef(payload) : undefined;
  } catch {
    ref = undefined;
  }
  const conn = ref ? await db.integrationConnection.findUnique({ where: { kind_provider_externalRef: { kind, provider: provider.name, externalRef: ref } } }) : null;
  let secret: string | undefined;
  if (conn?.webhookSecretEnc) {
    try {
      secret = decryptSecret(conn.webhookSecretEnc);
    } catch {
      return { ok: false, reason: "INVALID_SIGNATURE", signatureValid: false }; // unreadable tenant secret: never fall back
    }
  }
  if (!provider.verifyWebhook(rawBody, signature, secret)) return { ok: false, reason: "INVALID_SIGNATURE", signatureValid: false };
  // No account id at all: the payload cannot name a tenant — malformed, not retryable.
  if (!parsed || !ref) return { ok: false, reason: "MALFORMED", signatureValid: true };
  if (!conn || conn.status !== "CONNECTED") return { ok: false, reason: "UNKNOWN_ACCOUNT", signatureValid: true };
  return { ok: true, payload, tenant: { connectionId: conn.id, organizationId: conn.organizationId, outletId: conn.outletId, externalRef: ref } };
}

/** WebhookEvent.eventId for a tenant: the provider's id, namespaced by the sending account. */
export const tenantEventId = (t: WebhookTenant, eventId: string) => `${t.externalRef}:${eventId}`;

/** A body-supplied outlet is only a hint: it must equal the bound outlet. */
export const outletMismatch = (t: WebhookTenant, hint: string | null | undefined) => Boolean(hint) && hint !== t.outletId;

/**
 * Refuse a signed delivery that contradicts its tenant binding (outlet or
 * external id belonging elsewhere): nothing is mutated; the event is recorded
 * under the bound tenant and raised as an anomaly there.
 */
export async function rejectForTenant(db: PrismaClient, t: WebhookTenant, args: { providerKey: string; eventId: string; rawBody: string; eventType?: string; message: string }) {
  await db.webhookEvent
    .upsert({
      where: { provider_eventId: { provider: args.providerKey, eventId: args.eventId } },
      create: { provider: args.providerKey, eventId: args.eventId, eventType: args.eventType, organizationId: t.organizationId, signatureValid: true, status: "FAILED", payload: args.rawBody.slice(0, 100_000), error: `Rejected: ${args.message}` },
      update: {}, // never overwrite a processed event
    })
    .catch(() => undefined);
  const ctx = systemContext(t.organizationId, t.outletId ? [t.outletId] : []);
  await db.$transaction((tx) =>
    raiseAnomaly(tx, ctx, { type: "RECONCILIATION_MISMATCH", severity: "HIGH", outletId: t.outletId ?? undefined, entityType: "WebhookEvent", entityId: `${args.providerKey}:${args.eventId}`, message: `Webhook ${args.providerKey} rejected: ${args.message}` })
  ).catch(() => undefined);
}
