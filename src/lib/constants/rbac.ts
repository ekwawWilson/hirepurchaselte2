/**
 * Single source of truth for roles and permissions. prisma/seed.ts imports
 * this so the seeded DB and the app's permission checks never drift apart.
 * See docs/01-plan.md §7.
 */

export const PERMISSIONS = [
  'customer.create', 'customer.view', 'customer.update',
  'contract.create', 'contract.view', 'contract.cancel', 'contract.writeoff', 'contract.reschedule',
  'contract.approve',
  'payment.cash.record', 'payment.reverse', 'payment.view',
  'pricechart.view', 'pricechart.edit',
  'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view',
  'report.view.branch', 'report.view.all', 'report.export',
  'user.manage', 'role.manage', 'audit.view',
  'settings.manage',
  'agent.ledger.view', 'agent.ledger.remit', 'agent.ledger.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Human-readable label for each permission — the Roles admin UI's checkbox grid. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'customer.create': 'Create customers',
  'customer.view': 'View customers',
  'customer.update': 'Edit customers',
  'contract.create': 'Create contracts',
  'contract.view': 'View contracts',
  'contract.cancel': 'Cancel contracts',
  'contract.writeoff': 'Write off contracts',
  'contract.reschedule': 'Reschedule contracts',
  'contract.approve': 'Approve agent-submitted contracts',
  'payment.cash.record': 'Record cash / USSD payments',
  'payment.reverse': 'Reverse payments',
  'payment.view': 'View payments',
  'pricechart.view': 'View price chart',
  'pricechart.edit': 'Edit price chart',
  'inventory.receive': 'Receive stock',
  'inventory.issue': 'Issue stock',
  'inventory.transfer': 'Transfer stock between branches',
  'inventory.adjust': 'Adjust stock',
  'inventory.view': 'View inventory',
  'report.view.branch': "View own branch's reports",
  'report.view.all': 'View all-branch reports',
  'report.export': 'Export reports',
  'user.manage': 'Manage users',
  'role.manage': 'Manage roles & permissions',
  'audit.view': 'View audit trail',
  'settings.manage': 'Manage settings',
  'agent.ledger.view': "View own agent deposit/commission ledger",
  'agent.ledger.remit': 'Record a remittance against own agent ledger',
  'agent.ledger.manage': "View and confirm every agent's deposit ledger",
};

/** Permissions grouped for display — the Roles admin UI's checkbox grid, in this order. */
export const PERMISSION_GROUPS: Array<{ label: string; permissions: Permission[] }> = [
  { label: 'Customers', permissions: ['customer.create', 'customer.view', 'customer.update'] },
  { label: 'Contracts', permissions: ['contract.create', 'contract.view', 'contract.cancel', 'contract.writeoff', 'contract.reschedule', 'contract.approve'] },
  { label: 'Payments', permissions: ['payment.cash.record', 'payment.reverse', 'payment.view'] },
  { label: 'Price Chart', permissions: ['pricechart.view', 'pricechart.edit'] },
  { label: 'Inventory', permissions: ['inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view'] },
  { label: 'Reports', permissions: ['report.view.branch', 'report.view.all', 'report.export'] },
  { label: 'Agent ledger', permissions: ['agent.ledger.view', 'agent.ledger.remit', 'agent.ledger.manage'] },
  { label: 'Administration', permissions: ['user.manage', 'role.manage', 'audit.view'] },
  { label: 'Settings', permissions: ['settings.manage'] },
];

// These 7 are the SYSTEM roles: syncRbac.ts force-replaces each one's
// permission set from ROLE_PERMISSIONS below on every deploy (see that
// file's comment — it's how a permission added/removed in code propagates to
// every already-deployed database). That means editing a system role's
// permissions through the Roles admin UI would just get silently overwritten
// on the next deploy — so that UI only lets an admin create/edit/delete
// CUSTOM roles (any Role row whose name isn't one of these 7), which
// syncRbac never touches at all. See src/app/api/roles/[id]/route.ts.
export const ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'BRANCH_MANAGER',
  'CASHIER',
  'SALES',
  'AGENT',
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
    'contract.approve',
    'payment.cash.record', 'payment.reverse', 'payment.view',
    'pricechart.view',
    'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view',
    'report.view.branch', 'report.export',
    'agent.ledger.manage',
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
  // The Agent role (docs/01-plan.md's Agent module, ported from the legacy
  // hirepurchase app's own AGENT role): registers customers and creates
  // contracts exactly like SALES, but every contract they create requires an
  // approver's sign-off before it enters its real lifecycle (contract.approve,
  // held by BRANCH_MANAGER/ADMIN/SUPER_ADMIN), and — unlike every other
  // role — they see only the customers and contracts they personally created,
  // never a whole branch's (OWN_SCOPED_ROLES below). agent.ledger.* covers
  // their own commission/deposit-custody ledger.
  AGENT: [
    'customer.create', 'customer.view',
    'contract.create', 'contract.view',
    'pricechart.view', 'inventory.view',
    'agent.ledger.view', 'agent.ledger.remit',
  ],
  STORE_KEEPER: [
    'inventory.receive', 'inventory.issue', 'inventory.transfer', 'inventory.adjust', 'inventory.view',
  ],
  AUDITOR: [
    'customer.view', 'contract.view', 'payment.view',
    'pricechart.view', 'inventory.view',
    'report.view.all', 'report.export', 'audit.view',
    'agent.ledger.manage',
  ],
};

/** Roles that see only their own branch's data (every other role — SUPER_ADMIN, ADMIN, AUDITOR — sees all branches). */
export const BRANCH_SCOPED_ROLES: RoleName[] = ['BRANCH_MANAGER', 'CASHIER', 'SALES', 'AGENT', 'STORE_KEEPER'];

/**
 * Roles restricted, ON TOP OF their branch scope, to only the customers and
 * contracts they themselves created — see rbac.ts's ownRecordsWhere. Every
 * other branch-scoped role (BRANCH_MANAGER, CASHIER, SALES) sees the whole
 * branch's book; an AGENT sees only their own portfolio, matching the legacy
 * app's "you will only ever see contracts you personally created" rule.
 */
export const OWN_SCOPED_ROLES: RoleName[] = ['AGENT'];

export const SEED_PASSWORD = 'Passw0rd!123';

export const DEMO_USERS: Array<{ role: RoleName; email: string; firstName: string; lastName: string }> = [
  { role: 'SUPER_ADMIN', email: 'superadmin@example.test', firstName: 'Super', lastName: 'Admin' },
  { role: 'ADMIN', email: 'admin@example.test', firstName: 'System', lastName: 'Admin' },
  { role: 'BRANCH_MANAGER', email: 'branchmanager@example.test', firstName: 'Branch', lastName: 'Manager' },
  { role: 'CASHIER', email: 'cashier@example.test', firstName: 'Front', lastName: 'Cashier' },
  { role: 'SALES', email: 'sales@example.test', firstName: 'Sales', lastName: 'Rep' },
  { role: 'AGENT', email: 'agent@example.test', firstName: 'Field', lastName: 'Agent' },
  { role: 'STORE_KEEPER', email: 'storekeeper@example.test', firstName: 'Store', lastName: 'Keeper' },
  { role: 'AUDITOR', email: 'auditor@example.test', firstName: 'System', lastName: 'Auditor' },
];
