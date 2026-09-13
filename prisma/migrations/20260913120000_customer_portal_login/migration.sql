-- Customer portal sign-in. Existing customers get in with their phone number
-- as the initial password (no backfill needed — see customerPortalService),
-- and are forced to choose their own on first sign-in.
ALTER TABLE "customers" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "customers" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "customers" ADD COLUMN "portalLastLoginAt" TIMESTAMP(3);
