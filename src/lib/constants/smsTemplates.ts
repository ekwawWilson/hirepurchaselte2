/**
 * Every SMS the app sends. prisma/seed.ts keeps a development database in
 * step with this list; production gets the same rows from the migration
 * 20260914090000_sms_templates, since deploys never run the seed — change a
 * wording here and in a new migration together.
 *
 * Variables: {{customerName}} {{contractNumber}} {{currency}} {{amountPaid}}
 * {{outstandingBalance}} {{nextDueLine}} {{companyName}}, plus per-message
 * extras passed to queueSms (amountDue, amountOverdue, daysOverdue, lockDate).
 * A template with isActive false is not sent; those below stay off until their
 * wording is approved.
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
  {
    key: 'directdebit.notice',
    name: 'Direct debit notice (day before)',
    bodyTemplate:
      'Hi {{customerName}}, {{currency}} {{amountDue}} will be deducted from your mobile money wallet tomorrow for contract {{contractNumber}}. ' +
      'Please keep enough funds in your wallet. {{companyName}}',
  },
  {
    key: 'paytrigger.lock_tomorrow',
    name: 'Phone locks tomorrow',
    isActive: false,
    bodyTemplate:
      'Hi {{customerName}}, your phone will lock on {{lockDate}} because {{currency}} {{amountDue}} is unpaid on contract {{contractNumber}}. ' +
      'Please pay today to keep it open. {{companyName}}',
  },
  {
    key: 'contract.defaulted',
    name: 'Contract defaulted',
    isActive: false,
    bodyTemplate:
      'Hi {{customerName}}, contract {{contractNumber}} is now in default because payments are overdue. ' +
      'Outstanding balance: {{currency}} {{outstandingBalance}}. Please pay or contact us. {{companyName}}',
  },
  {
    key: 'contract.cancelled',
    name: 'Contract cancelled',
    isActive: false,
    bodyTemplate: 'Hi {{customerName}}, contract {{contractNumber}} has been cancelled. Please contact us about anything you have paid. {{companyName}}',
  },
  {
    key: 'contract.written_off',
    name: 'Contract written off',
    isActive: false,
    bodyTemplate: 'Hi {{customerName}}, contract {{contractNumber}} has been closed as unpaid. Please contact us if you have any questions. {{companyName}}',
  },
  {
    key: 'contract.rescheduled',
    name: 'Contract rescheduled',
    isActive: false,
    bodyTemplate:
      'Hi {{customerName}}, the payment schedule for contract {{contractNumber}} has changed. {{nextDueLine}} ' +
      'Outstanding balance: {{currency}} {{outstandingBalance}}. {{companyName}}',
  },
  {
    key: 'customer.portal_password',
    name: 'Customer sign-in password',
    isActive: false,
    bodyTemplate: 'Hi {{customerName}}, your {{companyName}} sign-in password is {{password}}. Use it with this number in the app or portal, then choose your own.',
  },
] as const;
