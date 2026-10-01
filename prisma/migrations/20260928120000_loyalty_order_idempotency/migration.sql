-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_customerId_orderId_type_key" ON "LoyaltyTransaction"("customerId", "orderId", "type");

