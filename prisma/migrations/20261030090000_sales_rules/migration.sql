-- AlterTable
ALTER TABLE "control_settings" ADD COLUMN     "blockSalesWhileDepositsUnremitted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parBlockEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parBlockMinContracts" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "parBlockThresholdPercent" INTEGER NOT NULL DEFAULT 20;
