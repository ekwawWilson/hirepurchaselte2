-- A paid-off phone leaves PayTrigger as soon as its contract is completed.
ALTER TABLE "paytrigger_settings" ALTER COLUMN "releaseHoldHours" SET DEFAULT 0;
UPDATE "paytrigger_settings" SET "releaseHoldHours" = 0;
