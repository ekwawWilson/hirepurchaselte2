-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "paymentMethod" TEXT NOT NULL DEFAULT 'CUSTOMER_INITIATED';

-- Preserve today's behavior for contracts that already have an approved mandate
-- attached: they were already being proactively charged on every due instalment
-- (the only behavior that existed before this migration), so backfill them to
-- DIRECT_DEBIT rather than silently switching their collection behavior to the
-- new BOTH-style "only on default" under existing customers.
UPDATE "contracts" SET "paymentMethod" = 'DIRECT_DEBIT' WHERE "hubtelPreapprovalId" IS NOT NULL;
