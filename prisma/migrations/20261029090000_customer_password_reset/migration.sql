-- CreateTable
CREATE TABLE "customer_password_resets" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_password_resets_customerId_createdAt_idx" ON "customer_password_resets"("customerId", "createdAt");
