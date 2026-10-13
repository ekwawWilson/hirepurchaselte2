-- USSD payments taken by Hubtel's own checkout (AddToCart): what Hubtel
-- reported to the Service Fulfilment URL, and whether it has been told the
-- service was rendered.
ALTER TABLE "hubtel_transactions"
  ADD COLUMN "hubtelOrderId" TEXT,
  ADD COLUMN "fulfilmentReceivedAt" TIMESTAMP(3),
  ADD COLUMN "fulfilmentStatus" TEXT,
  ADD COLUMN "fulfilmentCallbackState" TEXT,
  ADD COLUMN "fulfilmentCallbackAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "hubtel_transactions_fulfilmentCallbackState_idx" ON "hubtel_transactions"("fulfilmentCallbackState");
