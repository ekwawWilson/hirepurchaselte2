-- A fixed charge on each temporary unlock tier, paid on top of its share of what is overdue.
ALTER TABLE "paytrigger_temporary_unlocks" ADD COLUMN "chargeMinor" INTEGER NOT NULL DEFAULT 0;
