-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "assignedAgentId" TEXT;

-- CreateTable
CREATE TABLE "inventory_assignments" (
    "id" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "fromAgentId" TEXT,
    "toAgentId" TEXT,
    "assignedById" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_assignments_inventoryItemId_createdAt_idx" ON "inventory_assignments"("inventoryItemId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_assignments_toAgentId_createdAt_idx" ON "inventory_assignments"("toAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_assignments_fromAgentId_createdAt_idx" ON "inventory_assignments"("fromAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_items_assignedAgentId_status_idx" ON "inventory_items"("assignedAgentId", "status");

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_assignments" ADD CONSTRAINT "inventory_assignments_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
