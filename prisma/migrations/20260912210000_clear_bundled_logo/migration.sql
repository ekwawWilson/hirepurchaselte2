-- The bundled logo images (public/zple.jpeg, and the older public/eyo.jpeg)
-- have been removed; the logo now comes only from Settings. Clear any saved
-- setting still pointing at them so the initials badge shows until a real
-- logo is uploaded.
UPDATE "org_settings" SET "logoUrl" = NULL WHERE "logoUrl" IN ('/zple.jpeg', '/eyo.jpeg');
