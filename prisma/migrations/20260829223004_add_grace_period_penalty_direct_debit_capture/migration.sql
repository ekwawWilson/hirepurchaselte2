-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "gracePeriodDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "penaltyRateBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pendingDirectDebitMsisdn" TEXT,
ADD COLUMN     "pendingDirectDebitNetwork" TEXT;
