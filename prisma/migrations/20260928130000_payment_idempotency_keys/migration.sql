-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "VendorPayment" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Refund_organizationId_idempotencyKey_key" ON "Refund"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "VendorPayment_organizationId_idempotencyKey_key" ON "VendorPayment"("organizationId", "idempotencyKey");

