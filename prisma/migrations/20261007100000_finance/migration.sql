-- Phase 4 finance. Additive only: expense categories, expense idempotency +
-- void fields, petty-cash idempotency, drawer pay-in/pay-out + frozen expected
-- cash/variance, vendor-payment reversal fields, invoice series / HSN-SAC /
-- buyer GSTIN, gapless invoice sequences, issued invoices / credit notes with
-- their tax breakdown, and a unique invoice number per outlet (all existing
-- Order.invoiceNo values are NULL, which do not conflict).

-- AlterTable
ALTER TABLE "CashDrawerSession" ADD COLUMN "closedById" TEXT;
ALTER TABLE "CashDrawerSession" ADD COLUMN "expectedCash" DECIMAL;
ALTER TABLE "CashDrawerSession" ADD COLUMN "variance" DECIMAL;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Expense" ADD COLUMN "requestHash" TEXT;
ALTER TABLE "Expense" ADD COLUMN "voidReason" TEXT;
ALTER TABLE "Expense" ADD COLUMN "voidedAt" DATETIME;
ALTER TABLE "Expense" ADD COLUMN "voidedById" TEXT;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN "hsnSac" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "buyerGstin" TEXT;
ALTER TABLE "Order" ADD COLUMN "buyerName" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "hsnSac" TEXT;

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN "invoiceSeries" TEXT;

-- AlterTable
ALTER TABLE "PettyCashTxn" ADD COLUMN "expenseId" TEXT;
ALTER TABLE "PettyCashTxn" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PettyCashTxn" ADD COLUMN "requestHash" TEXT;

-- AlterTable
ALTER TABLE "VendorPayment" ADD COLUMN "reversalReason" TEXT;
ALTER TABLE "VendorPayment" ADD COLUMN "reversedAt" DATETIME;
ALTER TABLE "VendorPayment" ADD COLUMN "reversedById" TEXT;

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CashDrawerMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashDrawerMovement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashDrawerSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TaxInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "originalInvoiceId" TEXT,
    "refundId" TEXT,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sellerName" TEXT NOT NULL,
    "sellerAddress" TEXT,
    "sellerGstin" TEXT,
    "sellerStateCode" TEXT,
    "buyerName" TEXT,
    "buyerGstin" TEXT,
    "placeOfSupply" TEXT,
    "supplyType" TEXT NOT NULL,
    "taxableValue" DECIMAL NOT NULL,
    "cgst" DECIMAL NOT NULL DEFAULT 0,
    "sgst" DECIMAL NOT NULL DEFAULT 0,
    "igst" DECIMAL NOT NULL DEFAULT 0,
    "totalTax" DECIMAL NOT NULL,
    "total" DECIMAL NOT NULL,
    "reason" TEXT,
    "createdById" TEXT
);

-- CreateTable
CREATE TABLE "TaxInvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "ratePct" DECIMAL NOT NULL,
    "hsnSac" TEXT,
    "taxableValue" DECIMAL NOT NULL,
    "cgst" DECIMAL NOT NULL DEFAULT 0,
    "sgst" DECIMAL NOT NULL DEFAULT 0,
    "igst" DECIMAL NOT NULL DEFAULT 0,
    CONSTRAINT "TaxInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_organizationId_name_key" ON "ExpenseCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "CashDrawerMovement_sessionId_idx" ON "CashDrawerMovement"("sessionId");

-- CreateIndex
CREATE INDEX "CashDrawerMovement_organizationId_outletId_createdAt_idx" ON "CashDrawerMovement"("organizationId", "outletId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashDrawerMovement_organizationId_idempotencyKey_key" ON "CashDrawerMovement"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_outletId_fiscalYear_kind_key" ON "InvoiceSequence"("outletId", "fiscalYear", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_sourceKey_key" ON "TaxInvoice"("sourceKey");

-- CreateIndex
CREATE INDEX "TaxInvoice_organizationId_outletId_issuedAt_idx" ON "TaxInvoice"("organizationId", "outletId", "issuedAt");

-- CreateIndex
CREATE INDEX "TaxInvoice_orderId_idx" ON "TaxInvoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_outletId_number_key" ON "TaxInvoice"("outletId", "number");

-- CreateIndex
CREATE INDEX "TaxInvoiceLine_invoiceId_idx" ON "TaxInvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_organizationId_idempotencyKey_key" ON "Expense"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Order_outletId_invoiceNo_key" ON "Order"("outletId", "invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashTxn_organizationId_idempotencyKey_key" ON "PettyCashTxn"("organizationId", "idempotencyKey");

