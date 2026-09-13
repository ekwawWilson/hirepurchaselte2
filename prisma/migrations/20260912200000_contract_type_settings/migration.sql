-- CreateTable
CREATE TABLE "contract_type_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "saveToOwnEnabled" BOOLEAN NOT NULL DEFAULT false,
    "deviceLoanEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "contract_type_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "contract_type_settings" ADD CONSTRAINT "contract_type_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
