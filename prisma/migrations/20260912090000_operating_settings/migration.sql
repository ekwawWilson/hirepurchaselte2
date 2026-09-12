-- CreateTable
CREATE TABLE "operating_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "worksSaturday" BOOLEAN NOT NULL DEFAULT false,
    "worksSunday" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "operating_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "operating_settings" ADD CONSTRAINT "operating_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
