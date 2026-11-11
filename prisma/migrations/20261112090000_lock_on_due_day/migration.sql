-- No grace period for phone locks: an unpaid phone locks at the end of its due day.
ALTER TABLE "paytrigger_settings" ALTER COLUMN "lockAfterOverdueDays" SET DEFAULT 0;
UPDATE "paytrigger_settings" SET "lockAfterOverdueDays" = 0;
