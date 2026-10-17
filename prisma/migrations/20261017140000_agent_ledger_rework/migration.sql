-- Who collected each cash payment, so an agent only owes what they took.
ALTER TABLE "payments" ADD COLUMN "collectedByAgentId" TEXT;
ALTER TABLE "payments" ADD CONSTRAINT "payments_collectedByAgentId_fkey" FOREIGN KEY ("collectedByAgentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Until now every cash deposit on an agent's contract was taken to be the agent's.
UPDATE "payments" p SET "collectedByAgentId" = l."agentId"
FROM "agent_deposit_ledger" l
WHERE p."contractId" = l."contractId" AND p."entryType" = 'DEPOSIT' AND p."channel" = 'CASH' AND p."reversesPaymentId" IS NULL;

-- The ledger now carries a signed balance, the commission rate it was earned at, and payouts to the agent.
ALTER TABLE "agent_deposit_ledger" ADD COLUMN "commissionRateMinor" INTEGER;
ALTER TABLE "agent_deposit_ledger" ADD COLUMN "commissionPaidMinor" INTEGER NOT NULL DEFAULT 0;
UPDATE "agent_deposit_ledger" SET "commissionRateMinor" = "commissionAmountMinor";

CREATE TABLE "agent_commission_payouts" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "paidById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_commission_payouts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_commission_payouts_agentId_idx" ON "agent_commission_payouts"("agentId");
ALTER TABLE "agent_commission_payouts" ADD CONSTRAINT "agent_commission_payouts_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "agent_deposit_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_commission_payouts" ADD CONSTRAINT "agent_commission_payouts_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_commission_payouts" ADD CONSTRAINT "agent_commission_payouts_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
