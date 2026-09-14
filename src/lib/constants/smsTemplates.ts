/**
 * Every SMS the app sends. prisma/seed.ts keeps a development database in
 * step with this list; production gets the same rows from the migration
 * 20260914090000_sms_templates, since deploys never run the seed — change a
 * wording here and in a new migration together.
 *
 * Variables: {{customerName}} {{contractNumber}} {{currency}} {{amountPaid}}
 * {{outstandingBalance}} {{nextDueLine}} {{companyName}}, plus per-message
 * extras passed to queueSms (amountDue, amountOverdue, daysOverdue).
 */
export const SMS_TEMPLATES = [
  {
    key: 'payment.success',
    name: 'Payment received',
    bodyTemplate:
      'Hi {{customerName}}, we received your payment of {{currency}} {{amountPaid}} for contract {{contractNumber}}. ' +
      'Outstanding balance: {{currency}} {{outstandingBalance}}. {{nextDueLine}}',
  },
  {
    key: 'contract.activated',
    name: 'Contract activated / welcome',
    bodyTemplate:
      'Hi {{customerName}}, your contract {{contractNumber}} is now active. ' +
      'Outstanding balance: {{currency}} {{outstandingBalance}}. {{nextDueLine}}',
  },
  {
    key: 'instalment.due_today',
    name: 'Payment due today (daily reminder)',
    bodyTemplate:
      'Hi {{customerName}}, your payment of {{currency}} {{amountDue}} for contract {{contractNumber}} is due today. ' +
      'Pay at {{companyName}} or by mobile money. Thank you.',
  },
  {
    key: 'instalment.overdue',
    name: 'Payment overdue (reminder)',
    bodyTemplate:
      'Hi {{customerName}}, {{currency}} {{amountOverdue}} on contract {{contractNumber}} is overdue by {{daysOverdue}} day(s). ' +
      'Please pay as soon as possible. Outstanding balance: {{currency}} {{outstandingBalance}}. {{companyName}}',
  },
] as const;
