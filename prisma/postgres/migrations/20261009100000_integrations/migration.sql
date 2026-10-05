-- AlterTable
ALTER TABLE "IntegrationConnection" ADD COLUMN     "credentialsEnc" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastSuccessAt" TIMESTAMP(3),
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'SANDBOX';

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL,
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
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Printer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printedAt" TIMESTAMP(3),

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationDelivery" (
    "id" TEXT NOT NULL,
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
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "providerRef" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationDelivery_pkey" PRIMARY KEY ("id")
);

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

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_printerId_fkey" FOREIGN KEY ("printerId") REFERENCES "Printer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

