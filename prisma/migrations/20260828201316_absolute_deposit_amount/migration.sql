/*
  Warnings:

  - You are about to drop the column `depositPercentage` on the `contracts` table. All the data in the column will be lost.
  - You are about to drop the column `depositPercentage` on the `price_chart_entries` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "contracts" DROP COLUMN "depositPercentage";

-- AlterTable
ALTER TABLE "price_chart_entries" DROP COLUMN "depositPercentage",
ADD COLUMN     "depositAmountMinor" INTEGER NOT NULL DEFAULT 0;
