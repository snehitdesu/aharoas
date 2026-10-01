-- AlterTable
ALTER TABLE "ExportJob" ADD COLUMN "error" TEXT;
ALTER TABLE "ExportJob" ADD COLUMN "params" TEXT;
ALTER TABLE "ExportJob" ADD COLUMN "rowCount" INTEGER;

