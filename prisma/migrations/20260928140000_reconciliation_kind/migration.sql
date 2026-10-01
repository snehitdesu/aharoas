-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Reconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PAYMENTS',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Reconciliation" ("businessDate", "createdAt", "createdById", "id", "notes", "organizationId", "outletId", "status", "updatedAt") SELECT "businessDate", "createdAt", "createdById", "id", "notes", "organizationId", "outletId", "status", "updatedAt" FROM "Reconciliation";
DROP TABLE "Reconciliation";
ALTER TABLE "new_Reconciliation" RENAME TO "Reconciliation";
CREATE INDEX "Reconciliation_organizationId_outletId_idx" ON "Reconciliation"("organizationId", "outletId");
CREATE UNIQUE INDEX "Reconciliation_outletId_businessDate_kind_key" ON "Reconciliation"("outletId", "businessDate", "kind");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

