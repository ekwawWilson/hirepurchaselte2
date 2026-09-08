-- CreateTable
CREATE TABLE "hubtel_sample_logs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestPayload" TEXT,
    "responsePayload" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hubtel_sample_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hubtel_sample_logs_kind_key" ON "hubtel_sample_logs"("kind");
