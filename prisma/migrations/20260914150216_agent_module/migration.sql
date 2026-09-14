-- DropForeignKey
ALTER TABLE "contracts" DROP CONSTRAINT "contracts_productId_fkey";

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "revisionReason" TEXT,
ADD COLUMN     "submittedForApprovalAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "commission_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "fixedCommissionMinor" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "commission_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_deposit_ledger" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "depositAmountMinor" INTEGER NOT NULL,
    "commissionAmountMinor" INTEGER NOT NULL,
    "amountOwedMinor" INTEGER NOT NULL,
    "amountRemittedMinor" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OWED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_deposit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_remittances" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_deposit_ledger_contractId_key" ON "agent_deposit_ledger"("contractId");

-- CreateIndex
CREATE INDEX "agent_deposit_ledger_agentId_status_idx" ON "agent_deposit_ledger"("agentId", "status");

-- CreateIndex
CREATE INDEX "agent_deposit_ledger_agentId_createdAt_idx" ON "agent_deposit_ledger"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_remittances_ledgerId_status_idx" ON "agent_remittances"("ledgerId", "status");

-- CreateIndex
CREATE INDEX "agent_remittances_agentId_status_idx" ON "agent_remittances"("agentId", "status");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_settings" ADD CONSTRAINT "commission_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deposit_ledger" ADD CONSTRAINT "agent_deposit_ledger_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_deposit_ledger" ADD CONSTRAINT "agent_deposit_ledger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_remittances" ADD CONSTRAINT "agent_remittances_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "agent_deposit_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_remittances" ADD CONSTRAINT "agent_remittances_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_remittances" ADD CONSTRAINT "agent_remittances_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
