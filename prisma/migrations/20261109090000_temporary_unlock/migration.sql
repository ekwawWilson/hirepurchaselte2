-- Device Financing: a customer pays part of what is overdue and the phone opens for a set time.
ALTER TABLE "paytrigger_settings"
  ADD COLUMN "temporaryUnlockEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "temporaryUnlockMaxUses" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "temporaryUnlockTiers" JSONB NOT NULL DEFAULT '[{"percent":25,"hours":24},{"percent":50,"hours":72},{"percent":75,"hours":120},{"percent":90,"hours":168}]',
  ADD COLUMN "lockScreenAppLink" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "paytrigger_temporary_unlocks" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "percent" INTEGER NOT NULL,
    "hours" INTEGER NOT NULL,
    "overdueMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "clientReference" TEXT NOT NULL,
    "paymentId" TEXT,
    "requestedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paytrigger_temporary_unlocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "paytrigger_temporary_unlocks_clientReference_key" ON "paytrigger_temporary_unlocks"("clientReference");
CREATE INDEX "paytrigger_temporary_unlocks_contractId_status_idx" ON "paytrigger_temporary_unlocks"("contractId", "status");
