-- AlterTable
ALTER TABLE "Session" ADD COLUMN "lastActivityAt" DATETIME;
ALTER TABLE "Session" ADD COLUMN "reauthExpiresAt" DATETIME;
ALTER TABLE "Session" ADD COLUMN "reauthScope" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "recoveryKeyCreatedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "recoveryKeyHash" TEXT;
