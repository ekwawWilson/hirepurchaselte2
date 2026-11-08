-- Pop-ups on the phone before an instalment is due: off until switched on.
ALTER TABLE "paytrigger_settings"
  ADD COLUMN "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reminderDaysBefore" TEXT NOT NULL DEFAULT '3,1,0',
  ADD COLUMN "reminderIncludeDaily" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reminderTitle" TEXT NOT NULL DEFAULT 'Payment reminder',
  ADD COLUMN "reminderText" TEXT NOT NULL DEFAULT 'Dear {firstName}, your payment of {amount} is due on {dueDate}. Please pay on time to keep your phone open.';

-- Customer texts, not sent until their wording is approved and isActive is set.
-- Source of truth: src/lib/constants/smsTemplates.ts.
INSERT INTO "sms_templates" ("id", "key", "name", "bodyTemplate", "isActive") VALUES
  (gen_random_uuid()::text, 'paytrigger.lock_tomorrow', 'Phone locks tomorrow', 'Hi {{customerName}}, your phone will lock on {{lockDate}} because {{currency}} {{amountDue}} is unpaid on contract {{contractNumber}}. Please pay today to keep it open. {{companyName}}', false),
  (gen_random_uuid()::text, 'contract.defaulted', 'Contract defaulted', 'Hi {{customerName}}, contract {{contractNumber}} is now in default because payments are overdue. Outstanding balance: {{currency}} {{outstandingBalance}}. Please pay or contact us. {{companyName}}', false),
  (gen_random_uuid()::text, 'contract.cancelled', 'Contract cancelled', 'Hi {{customerName}}, contract {{contractNumber}} has been cancelled. Please contact us about anything you have paid. {{companyName}}', false),
  (gen_random_uuid()::text, 'contract.written_off', 'Contract written off', 'Hi {{customerName}}, contract {{contractNumber}} has been closed as unpaid. Please contact us if you have any questions. {{companyName}}', false),
  (gen_random_uuid()::text, 'contract.rescheduled', 'Contract rescheduled', 'Hi {{customerName}}, the payment schedule for contract {{contractNumber}} has changed. {{nextDueLine}} Outstanding balance: {{currency}} {{outstandingBalance}}. {{companyName}}', false),
  (gen_random_uuid()::text, 'customer.portal_password', 'Customer sign-in password', 'Hi {{customerName}}, your {{companyName}} sign-in password is {{password}}. Use it with this number in the app or portal, then choose your own.', false)
ON CONFLICT ("key") DO NOTHING;
