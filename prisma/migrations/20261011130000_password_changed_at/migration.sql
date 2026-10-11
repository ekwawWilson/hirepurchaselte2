-- A token issued before a password was changed or reset stops working.
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
ALTER TABLE "customers" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

-- What was actually handed back on a cancelled contract (may differ from what was due).
ALTER TABLE "contracts" ADD COLUMN "refundedMinor" INTEGER;
