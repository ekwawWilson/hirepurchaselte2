-- CreateTable
CREATE TABLE IF NOT EXISTS "paytrigger_products" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paytrigger_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "paytrigger_devices" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "contractId" TEXT,
    "imei" TEXT NOT NULL,
    "deviceTag" TEXT,
    "orderRef" TEXT,
    "enrollmentStatus" TEXT NOT NULL DEFAULT 'QUEUED',
    "committedState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "scheduleExpiresAt" TIMESTAMP(3),
    "providerExpiresAt" TIMESTAMP(3),
    "fingerprint" TEXT,
    "releaseAfter" TIMESTAMP(3),
    "releaseHeld" BOOLEAN NOT NULL DEFAULT false,
    "lockMessageKey" TEXT,
    "lastConnectAt" TIMESTAMP(3),
    "apkVersion" TEXT,
    "licenceConsumedAt" TIMESTAMP(3),
    "lastStatusReadAt" TIMESTAMP(3),
    "pinUnlocksUsed" INTEGER NOT NULL DEFAULT 0,
    "awaitingPinSince" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paytrigger_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "paytrigger_commands" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paytrigger_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "paytrigger_action_logs" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT,
    "contractId" TEXT,
    "action" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "dryRun" BOOLEAN NOT NULL,
    "providerCode" TEXT,
    "skippedReason" TEXT,
    "request" JSONB,
    "response" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paytrigger_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "paytrigger_webhook_events" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "notifyType" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paytrigger_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "paytrigger_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultRuleNum" INTEGER NOT NULL DEFAULT 0,
    "lockAfterOverdueDays" INTEGER NOT NULL DEFAULT 1,
    "lockOnUnpaidAgentDeposit" BOOLEAN NOT NULL DEFAULT true,
    "maxUnlockHorizonDays" INTEGER NOT NULL DEFAULT 45,
    "releaseHoldHours" INTEGER NOT NULL DEFAULT 24,
    "extendBreakerPercent" INTEGER NOT NULL DEFAULT 20,
    "lockTitle" TEXT NOT NULL DEFAULT 'Payment overdue',
    "lockTips" TEXT NOT NULL DEFAULT 'Dear {firstName}, your payment of {amount} was due on {dueDate}. Pay to open your phone. Call {supportPhone} for help.',
    "depositHoldTitle" TEXT NOT NULL DEFAULT 'Phone not yet activated',
    "depositHoldTips" TEXT NOT NULL DEFAULT 'Your phone will be activated once your agent completes registration. Contact {agentName} on {agentPhone}.',
    "unlinkedTitle" TEXT NOT NULL DEFAULT 'No contract on this device',
    "unlinkedTips" TEXT NOT NULL DEFAULT 'This phone has no contract. Please contact {companyName} on {supportPhone}.',
    "lastSweepAt" TIMESTAMP(3),
    "lastSweepSummary" JSONB,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paytrigger_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "paytrigger_products_productId_key" ON "paytrigger_products"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "paytrigger_devices_inventoryItemId_key" ON "paytrigger_devices"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "paytrigger_devices_contractId_key" ON "paytrigger_devices"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "paytrigger_devices_imei_key" ON "paytrigger_devices"("imei");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "paytrigger_devices_enrollmentStatus_idx" ON "paytrigger_devices"("enrollmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "paytrigger_commands_idempotencyKey_key" ON "paytrigger_commands"("idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "paytrigger_commands_deviceId_createdAt_idx" ON "paytrigger_commands"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "paytrigger_commands_status_nextAttemptAt_idx" ON "paytrigger_commands"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "paytrigger_action_logs_deviceId_createdAt_idx" ON "paytrigger_action_logs"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "paytrigger_action_logs_contractId_createdAt_idx" ON "paytrigger_action_logs"("contractId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "paytrigger_webhook_events_dedupeKey_key" ON "paytrigger_webhook_events"("dedupeKey");
