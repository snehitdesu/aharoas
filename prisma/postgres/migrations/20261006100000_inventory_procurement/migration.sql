-- Phase 3 inventory & procurement (PostgreSQL). Additive only: nullable
-- columns, a NOT NULL DEFAULT 1 factor (existing variants unchanged) and unique
-- indexes on the new columns (NULLs do not conflict).
-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "InventoryIssue" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "InventoryTransfer" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "MenuItemVariant" ADD COLUMN     "consumptionFactor" DECIMAL(20,10) NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ModifierOption" ADD COLUMN     "materialId" TEXT,
ADD COLUMN     "materialQty" DECIMAL(16,4),
ADD COLUMN     "unitId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "OrderItemModifier" ADD COLUMN     "optionId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseBill" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT,
ADD COLUMN     "vendorInvoiceNo" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "indentId" TEXT,
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "Wastage" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_idempotencyKey_key" ON "GoodsReceipt"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryIssue_organizationId_idempotencyKey_key" ON "InventoryIssue"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_idempotencyKey_key" ON "InventoryTransfer"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_organizationId_idempotencyKey_key" ON "PurchaseBill"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_organizationId_vendorId_vendorInvoiceNo_key" ON "PurchaseBill"("organizationId", "vendorId", "vendorInvoiceNo");

-- CreateIndex
CREATE INDEX "PurchaseOrder_indentId_idx" ON "PurchaseOrder"("indentId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_idempotencyKey_key" ON "PurchaseOrder"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Wastage_organizationId_idempotencyKey_key" ON "Wastage"("organizationId", "idempotencyKey");

