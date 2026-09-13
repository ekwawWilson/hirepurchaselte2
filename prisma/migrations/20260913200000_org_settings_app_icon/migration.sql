-- A dedicated square app icon, used for installed apps and the browser tab
-- ahead of the (often wide) company logo.
ALTER TABLE "org_settings" ADD COLUMN "appIconUrl" TEXT;
