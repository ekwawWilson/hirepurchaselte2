-- An agent's own PIN for paying in deposits on the short code, and the count of wrong tries.
ALTER TABLE "users" ADD COLUMN "paymentPin" TEXT;
CREATE UNIQUE INDEX "users_paymentPin_key" ON "users"("paymentPin");

CREATE TABLE "agent_pin_failures" (
    "id" TEXT NOT NULL,
    "msisdn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_pin_failures_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_pin_failures_msisdn_createdAt_idx" ON "agent_pin_failures"("msisdn", "createdAt");

-- Every agent already on the books gets one now.
DO $$
DECLARE
  agent RECORD;
  pin TEXT;
BEGIN
  FOR agent IN SELECT u."id" FROM "users" u JOIN "roles" r ON r."id" = u."roleId" WHERE r."name" = 'AGENT' LOOP
    LOOP
      pin := (100000 + floor(random() * 900000))::int::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "users" WHERE "paymentPin" = pin);
    END LOOP;
    UPDATE "users" SET "paymentPin" = pin WHERE "id" = agent."id";
  END LOOP;
END $$;
