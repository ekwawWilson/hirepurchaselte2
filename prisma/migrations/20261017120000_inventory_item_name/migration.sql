-- A stock unit's own model name (e.g. "HP Envy" under the product "HP Laptop").
ALTER TABLE "inventory_items" ADD COLUMN "name" TEXT;
