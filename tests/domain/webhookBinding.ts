/**
 * Test helper (not a test file): bind a provider account to a tenant the way an
 * operator does through POST /api/master/integrations (H4 tenant binding).
 */
import { prisma } from "@/server/db/client";
import { encryptSecret } from "@/server/integrations/secrets";

export async function bindWebhook(o: { kind: "POS" | "PAYMENT" | "AGGREGATOR"; provider: string; organizationId: string; outletId?: string | null; externalRef: string; secret?: string; status?: "CONNECTED" | "DISCONNECTED" }) {
  const data = { organizationId: o.organizationId, outletId: o.outletId ?? null, status: o.status ?? "CONNECTED", webhookSecretEnc: o.secret ? encryptSecret(o.secret) : null };
  return prisma.integrationConnection.upsert({
    where: { kind_provider_externalRef: { kind: o.kind, provider: o.provider, externalRef: o.externalRef } },
    create: { kind: o.kind, provider: o.provider, externalRef: o.externalRef, ...data },
    update: data,
  });
}
