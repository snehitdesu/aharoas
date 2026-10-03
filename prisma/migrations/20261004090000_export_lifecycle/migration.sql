-- AlterTable
ALTER TABLE "ExportJob" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "ExportJob" ADD COLUMN "purgedAt" DATETIME;
ALTER TABLE "ExportJob" ADD COLUMN "startedAt" DATETIME;

-- CreateIndex
CREATE INDEX "ExportJob_status_createdAt_idx" ON "ExportJob"("status", "createdAt");

