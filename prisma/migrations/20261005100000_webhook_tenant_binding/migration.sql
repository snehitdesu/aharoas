-- H4 webhook tenant binding. Additive and non-destructive: two nullable
-- columns and a uniqueness change that only WIDENS what is allowed (every
-- existing row already satisfies the new, per-tenant constraint). The new
-- unique index is created before the old one is dropped, so payments are never
-- without a uniqueness guard.

-- AlterTable
ALTER TABLE "IntegrationConnection" ADD COLUMN "externalRef" TEXT;
ALTER TABLE "IntegrationConnection" ADD COLUMN "webhookSecretEnc" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_kind_provider_externalRef_key" ON "IntegrationConnection"("kind", "provider", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_organizationId_provider_providerRef_key" ON "Payment"("organizationId", "provider", "providerRef");

-- DropIndex
DROP INDEX "Payment_provider_providerRef_key";
