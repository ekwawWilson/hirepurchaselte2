-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "termWeeks" INTEGER;

-- CreateTable
CREATE TABLE "loan_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "dailyInterestRateBps" INTEGER NOT NULL DEFAULT 100,
    "interestGraceDays" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "loan_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "loan_settings" ADD CONSTRAINT "loan_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
