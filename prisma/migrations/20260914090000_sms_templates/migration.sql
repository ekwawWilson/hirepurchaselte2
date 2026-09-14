-- SMS templates. Deploys never run prisma/seed.ts, so without this a
-- production database has no templates and queueSms silently sends nothing —
-- payment receipts and welcome messages included. Existing rows (a template
-- edited by hand, or a seeded development database) are left untouched.
-- Source of truth: src/lib/constants/smsTemplates.ts.
INSERT INTO "sms_templates" ("id", "key", "name", "bodyTemplate", "isActive") VALUES
  (gen_random_uuid()::text, 'payment.success', 'Payment received', 'Hi {{customerName}}, we received your payment of {{currency}} {{amountPaid}} for contract {{contractNumber}}. Outstanding balance: {{currency}} {{outstandingBalance}}. {{nextDueLine}}', true),
  (gen_random_uuid()::text, 'contract.activated', 'Contract activated / welcome', 'Hi {{customerName}}, your contract {{contractNumber}} is now active. Outstanding balance: {{currency}} {{outstandingBalance}}. {{nextDueLine}}', true),
  (gen_random_uuid()::text, 'instalment.due_today', 'Payment due today (daily reminder)', 'Hi {{customerName}}, your payment of {{currency}} {{amountDue}} for contract {{contractNumber}} is due today. Pay at {{companyName}} or by mobile money. Thank you.', true),
  (gen_random_uuid()::text, 'instalment.overdue', 'Payment overdue (reminder)', 'Hi {{customerName}}, {{currency}} {{amountOverdue}} on contract {{contractNumber}} is overdue by {{daysOverdue}} day(s). Please pay as soon as possible. Outstanding balance: {{currency}} {{outstandingBalance}}. {{companyName}}', true)
ON CONFLICT ("key") DO NOTHING;
