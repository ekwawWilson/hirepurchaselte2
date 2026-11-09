-- Staff locking or opening a PayTrigger phone by hand (paytrigger/admin.setManualLock).
ALTER TABLE "paytrigger_devices"
  ADD COLUMN "manualState" TEXT,
  ADD COLUMN "manualUntil" TIMESTAMP(3),
  ADD COLUMN "manualReason" TEXT,
  ADD COLUMN "manualById" TEXT,
  ADD COLUMN "manualAt" TIMESTAMP(3);
