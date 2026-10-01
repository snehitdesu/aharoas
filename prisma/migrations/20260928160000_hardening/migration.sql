-- AlterTable
ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN "requestHash" TEXT;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "providerRef" TEXT;

-- CreateTable
CREATE TABLE "OutletMenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "price" DECIMAL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "soldOut" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutletMenuItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReservationSlot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "slot" DATETIME NOT NULL,
    "reservationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "OutletMenuItem_organizationId_idx" ON "OutletMenuItem"("organizationId");

-- CreateIndex
CREATE INDEX "OutletMenuItem_menuItemId_idx" ON "OutletMenuItem"("menuItemId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletMenuItem_outletId_menuItemId_key" ON "OutletMenuItem"("outletId", "menuItemId");

-- CreateIndex
CREATE INDEX "ReservationSlot_reservationId_idx" ON "ReservationSlot"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationSlot_organizationId_idx" ON "ReservationSlot"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationSlot_tableId_slot_key" ON "ReservationSlot"("tableId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_idempotencyKey_key" ON "Order"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_organizationId_providerRef_key" ON "Refund"("organizationId", "providerRef");

