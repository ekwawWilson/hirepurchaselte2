-- Registration now asks for occupation and a work address; the existing
-- address column is the customer's residential address.
ALTER TABLE "customers" ADD COLUMN "occupation" TEXT;
ALTER TABLE "customers" ADD COLUMN "workAddress" TEXT;
