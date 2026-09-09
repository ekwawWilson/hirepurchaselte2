-- AlterTable
-- SAVE_TO_OWN becomes open-ended savings: no linked product, no price chart
-- entry, no term, no savings target. Existing rows are untouched — this only
-- relaxes NOT NULL so future SAVE_TO_OWN contracts can omit these columns.
ALTER TABLE "contracts" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "totalPriceMinor" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "termMonths" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "instalmentAmountMinor" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "totalPayableMinor" DROP NOT NULL;
ALTER TABLE "contracts" ALTER COLUMN "balanceMinor" DROP NOT NULL;
