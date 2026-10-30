-- AlterTable
ALTER TABLE "commission_settings" ADD COLUMN     "completionBonusMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deferredCommissionMinor" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "agent_completion_commissions" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "upfrontMinor" INTEGER NOT NULL,
    "deferredMinor" INTEGER NOT NULL,
    "bonusMinor" INTEGER NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACCRUED',
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_completion_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_completion_commissions_contractId_key" ON "agent_completion_commissions"("contractId");

-- CreateIndex
CREATE INDEX "agent_completion_commissions_agentId_status_idx" ON "agent_completion_commissions"("agentId", "status");
