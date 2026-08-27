-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_price_chart_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "contractType" TEXT NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "paymentFrequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "depositPercentage" INTEGER NOT NULL DEFAULT 0,
    "totalPayableMinor" INTEGER NOT NULL,
    "instalmentAmountMinor" INTEGER NOT NULL,
    "interestRateBps" INTEGER,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_chart_entries_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_chart_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_price_chart_entries" ("contractType", "createdAt", "createdById", "depositPercentage", "effectiveFrom", "effectiveTo", "id", "instalmentAmountMinor", "interestRateBps", "productId", "termMonths", "totalPayableMinor") SELECT "contractType", "createdAt", "createdById", "depositPercentage", "effectiveFrom", "effectiveTo", "id", "instalmentAmountMinor", "interestRateBps", "productId", "termMonths", "totalPayableMinor" FROM "price_chart_entries";
DROP TABLE "price_chart_entries";
ALTER TABLE "new_price_chart_entries" RENAME TO "price_chart_entries";
CREATE INDEX "price_chart_entries_productId_contractType_termMonths_paymentFrequency_idx" ON "price_chart_entries"("productId", "contractType", "termMonths", "paymentFrequency");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
