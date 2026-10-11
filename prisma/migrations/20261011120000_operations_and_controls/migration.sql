-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "refundDueMinor" INTEGER,
ADD COLUMN     "refundNote" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "refundedById" TEXT;

-- AlterTable
ALTER TABLE "hubtel_transactions" ADD COLUMN     "baseAmountMinor" INTEGER,
ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "login_throttles" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "firstFailureAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "collection_notes" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "promisedAmountMinor" INTEGER,
    "promisedDate" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "requireSecondApproval" BOOLEAN NOT NULL DEFAULT true,
    "ownerPhone" TEXT,
    "dailySummaryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "directDebitNoticeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "partialDirectDebitEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "control_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collection_notes_contractId_createdAt_idx" ON "collection_notes"("contractId", "createdAt");

-- CreateIndex
CREATE INDEX "collection_notes_followUpAt_idx" ON "collection_notes"("followUpAt");

-- CreateIndex
CREATE INDEX "approval_requests_status_branchId_idx" ON "approval_requests"("status", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "system_alerts_dedupeKey_key" ON "system_alerts"("dedupeKey");

-- CreateIndex
CREATE INDEX "system_alerts_acknowledgedAt_idx" ON "system_alerts"("acknowledgedAt");

-- AddForeignKey
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_notes" ADD CONSTRAINT "collection_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The day-before notice of a direct debit (source of truth:
-- src/lib/constants/smsTemplates.ts). Deploys never run the seed.
INSERT INTO "sms_templates" ("id", "key", "name", "bodyTemplate", "isActive") VALUES
  (gen_random_uuid()::text, 'directdebit.notice', 'Direct debit notice (day before)', 'Hi {{customerName}}, {{currency}} {{amountDue}} will be deducted from your mobile money wallet tomorrow for contract {{contractNumber}}. Please keep enough funds in your wallet. {{companyName}}', true)
ON CONFLICT ("key") DO NOTHING;
