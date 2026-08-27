-- DropIndex
DROP INDEX "contracts_inventoryItemId_key";

-- CreateIndex
CREATE INDEX "contracts_inventoryItemId_idx" ON "contracts"("inventoryItemId");
