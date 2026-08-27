/**
 * Single source of truth for roles and permissions. prisma/seed.ts imports
 * this so the seeded DB and the app's permission checks never drift apart.
 * See docs/01-plan.md §7.
 */

export const PERMISSIONS = [
  'customer.create', 'customer.view', 'customer.update',
  'contract.create', 'contract.view', 'contract.cancel', 'contract.writeoff', 'contract.reschedule',
  'payment.cash.record', 'payment.reverse', 'payment.view',
  'pricechart.view', 'pricechart.edit',
  'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view',
  'report.view.branch', 'report.view.all', 'report.export',
  'user.manage', 'role.manage', 'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'BRANCH_MANAGER',
  'CASHIER',
  'SALES',
  'STORE_KEEPER',
  'AUDITOR',
] as const;

export type RoleName = (typeof ROLES)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  SUPER_ADMIN: ALL,
  ADMIN: ALL.filter((p) => p !== 'user.manage' && p !== 'role.manage'),
  BRANCH_MANAGER: [
    'customer.create', 'customer.view', 'customer.update',
    'contract.create', 'contract.view', 'contract.cancel', 'contract.writeoff', 'contract.reschedule',
    'payment.cash.record', 'payment.reverse', 'payment.view',
    'pricechart.view',
    'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view',
    'report.view.branch', 'report.export',
  ],
  CASHIER: [
    'customer.create', 'customer.view',
    'contract.create', 'contract.view',
    'payment.cash.record', 'payment.view',
    'pricechart.view',
    'report.view.branch',
  ],
  SALES: [
    'customer.create', 'customer.view',
    'contract.create', 'contract.view',
    'pricechart.view', 'inventory.view',
  ],
  STORE_KEEPER: [
    'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view',
  ],
  AUDITOR: [
    'customer.view', 'contract.view', 'payment.view',
    'pricechart.view', 'inventory.view',
    'report.view.all', 'report.export', 'audit.view',
  ],
};

/** Roles that see only their own branch's data (every other role — SUPER_ADMIN, ADMIN, AUDITOR — sees all branches). */
export const BRANCH_SCOPED_ROLES: RoleName[] = ['BRANCH_MANAGER', 'CASHIER', 'SALES', 'STORE_KEEPER'];

export const SEED_PASSWORD = 'Passw0rd!123';

export const DEMO_USERS: Array<{ role: RoleName; email: string; firstName: string; lastName: string }> = [
  { role: 'SUPER_ADMIN', email: 'superadmin@hplite.test', firstName: 'Super', lastName: 'Admin' },
  { role: 'ADMIN', email: 'admin@hplite.test', firstName: 'System', lastName: 'Admin' },
  { role: 'BRANCH_MANAGER', email: 'branchmanager@hplite.test', firstName: 'Branch', lastName: 'Manager' },
  { role: 'CASHIER', email: 'cashier@hplite.test', firstName: 'Front', lastName: 'Cashier' },
  { role: 'SALES', email: 'sales@hplite.test', firstName: 'Sales', lastName: 'Rep' },
  { role: 'STORE_KEEPER', email: 'storekeeper@hplite.test', firstName: 'Store', lastName: 'Keeper' },
  { role: 'AUDITOR', email: 'auditor@hplite.test', firstName: 'System', lastName: 'Auditor' },
];
