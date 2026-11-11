-- A Device Financing phone's price plans, one per length in months.
CREATE TABLE "device_financing_plans" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "totalPriceMinor" INTEGER NOT NULL,
    "depositMinor" INTEGER NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_financing_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "device_financing_plans_productId_months_key" ON "device_financing_plans"("productId", "months");
ALTER TABLE "device_financing_plans" ADD CONSTRAINT "device_financing_plans_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
