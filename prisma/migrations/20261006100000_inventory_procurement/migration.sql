-- Phase 3 inventory & procurement. Additive and data-preserving:
-- nullable columns, creation idempotency keys (unique per organization),
-- one bill per vendor invoice, PO -> indent link, variant consumption factor
-- (default 1 = unchanged behaviour) and stock-consuming modifier options.
-- MenuItemVariant is rebuilt (standard SQLite redefine) to add a NOT NULL
-- defaulted column; every existing row is copied.

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "GoodsReceipt" ADD COLUMN "requestHash" TEXT;

-- AlterTable
ALTER TABLE "InventoryIssue" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "InventoryIssue" ADD COLUMN "requestHash" TEXT;

-- AlterTable
ALTER TABLE "InventoryTransfer" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "InventoryTransfer" ADD COLUMN "requestHash" TEXT;

-- AlterTable
ALTER TABLE "ModifierOption" ADD COLUMN "materialId" TEXT;
ALTER TABLE "ModifierOption" ADD COLUMN "materialQty" DECIMAL;
ALTER TABLE "ModifierOption" ADD COLUMN "unitId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT;

-- AlterTable
ALTER TABLE "OrderItemModifier" ADD COLUMN "optionId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseBill" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PurchaseBill" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "PurchaseBill" ADD COLUMN "vendorInvoiceNo" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "indentId" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "requestHash" TEXT;

-- AlterTable
ALTER TABLE "Wastage" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Wastage" ADD COLUMN "requestHash" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MenuItemVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" DECIMAL NOT NULL DEFAULT 0,
    "consumptionFactor" DECIMAL NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "MenuItemVariant_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MenuItemVariant" ("active", "id", "menuItemId", "name", "organizationId", "priceDelta") SELECT "active", "id", "menuItemId", "name", "organizationId", "priceDelta" FROM "MenuItemVariant";
DROP TABLE "MenuItemVariant";
ALTER TABLE "new_MenuItemVariant" RENAME TO "MenuItemVariant";
CREATE INDEX "MenuItemVariant_organizationId_idx" ON "MenuItemVariant"("organizationId");
CREATE UNIQUE INDEX "MenuItemVariant_menuItemId_name_key" ON "MenuItemVariant"("menuItemId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

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

