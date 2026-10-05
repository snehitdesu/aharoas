-- CreateIndex
CREATE INDEX "AggregatorSettlement_aggregatorId_idx" ON "AggregatorSettlement"("aggregatorId");

-- CreateIndex
CREATE INDEX "InventoryLedger_correctionOfId_idx" ON "InventoryLedger"("correctionOfId");

-- CreateIndex
CREATE INDEX "Kot_stationId_idx" ON "Kot"("stationId");

-- CreateIndex
CREATE INDEX "KotItem_orderItemId_idx" ON "KotItem"("orderItemId");

-- CreateIndex
CREATE INDEX "Material_baseUnitId_idx" ON "Material"("baseUnitId");

-- CreateIndex
CREATE INDEX "Order_tableId_status_idx" ON "Order"("tableId", "status");

-- CreateIndex
CREATE INDEX "PrintJob_printerId_idx" ON "PrintJob"("printerId");

-- CreateIndex
CREATE INDEX "PurchaseBill_grnId_idx" ON "PurchaseBill"("grnId");

-- CreateIndex
CREATE INDEX "Reservation_customerId_idx" ON "Reservation"("customerId");

-- CreateIndex
CREATE INDEX "RestaurantTable_floorId_idx" ON "RestaurantTable"("floorId");

