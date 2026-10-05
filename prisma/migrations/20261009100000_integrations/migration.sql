-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'RECEIPT',
    "station" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'SIMULATED',
    "host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 9100,
    "width" INTEGER NOT NULL DEFAULT 42,
    "cashDrawer" BOOLEAN NOT NULL DEFAULT false,
    "autoPrint" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastError" TEXT,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "content" TEXT NOT NULL,
    "reprintOfId" TEXT,
    "reason" TEXT,
    "requestedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" DATETIME,
    CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntegrationDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "target" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" DATETIME,
    "lastError" TEXT,
    "providerRef" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "batchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "sentAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_IntegrationConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "config" TEXT,
    "externalRef" TEXT,
    "webhookSecretEnc" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'SANDBOX',
    "credentialsEnc" TEXT,
    "lastCheckedAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastFailureAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_IntegrationConnection" ("config", "createdAt", "externalRef", "id", "kind", "lastCheckedAt", "organizationId", "outletId", "provider", "status", "updatedAt", "webhookSecretEnc") SELECT "config", "createdAt", "externalRef", "id", "kind", "lastCheckedAt", "organizationId", "outletId", "provider", "status", "updatedAt", "webhookSecretEnc" FROM "IntegrationConnection";
DROP TABLE "IntegrationConnection";
ALTER TABLE "new_IntegrationConnection" RENAME TO "IntegrationConnection";
CREATE INDEX "IntegrationConnection_organizationId_idx" ON "IntegrationConnection"("organizationId");
CREATE UNIQUE INDEX "IntegrationConnection_organizationId_outletId_kind_provider_key" ON "IntegrationConnection"("organizationId", "outletId", "kind", "provider");
CREATE UNIQUE INDEX "IntegrationConnection_kind_provider_externalRef_key" ON "IntegrationConnection"("kind", "provider", "externalRef");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Printer_organizationId_outletId_idx" ON "Printer"("organizationId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "Printer_outletId_name_key" ON "Printer"("outletId", "name");

-- CreateIndex
CREATE INDEX "PrintJob_organizationId_outletId_status_idx" ON "PrintJob"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "PrintJob_sourceType_sourceId_idx" ON "PrintJob"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_organizationId_dedupeKey_key" ON "PrintJob"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_organizationId_kind_status_idx" ON "IntegrationDelivery"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_provider_providerRef_idx" ON "IntegrationDelivery"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationDelivery_organizationId_idempotencyKey_key" ON "IntegrationDelivery"("organizationId", "idempotencyKey");

