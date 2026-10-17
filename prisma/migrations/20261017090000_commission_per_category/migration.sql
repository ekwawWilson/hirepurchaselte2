-- Agent commission set per product category, with the existing single
-- amount kept as the default for categories that have none.
ALTER TABLE "product_categories" ADD COLUMN "agentCommissionMinor" INTEGER;
ALTER TABLE "agent_deposit_ledger" ADD COLUMN "commissionCategoryName" TEXT;
