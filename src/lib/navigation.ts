'use client';

import {
  LayoutDashboard,
  Users,
  Package,
  Warehouse,
  FileText,
  BarChart3,
  Tags,
  Smartphone,
  UserCog,
  ShieldCheck,
  Building2,
  Settings,
  ClipboardCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from './authStore';

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  perms?: string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Single source of truth for every nav item, shared by the desktop sidebar,
 * the mobile bottom tab bar, and the "More" sheet — so a permission change or
 * a new page only needs adding here once. See docs/01-plan.md for the mobile
 * nav redesign this was extracted for.
 */
export const navGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      // contract.create is also here (not just report.view.*) so an AGENT or
      // SALES user — neither holds a report permission — still gets a
      // Dashboard link; the page itself renders a portfolio-style summary
      // for anyone without report access instead of the branch-wide one.
      { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, perms: ['report.view.branch', 'report.view.all', 'contract.create'] },
    ],
  },
  {
    label: 'Customers',
    items: [
      { name: 'Customers', href: '/customers', icon: Users, perms: ['customer.view'] },
    ],
  },
  {
    label: 'Contracts & Payments',
    items: [
      { name: 'Contracts', href: '/contracts', icon: FileText, perms: ['contract.view'] },
      // The Agent module: contracts an AGENT submitted, waiting for a
      // BRANCH_MANAGER/ADMIN/SUPER_ADMIN to approve or send back.
      { name: 'Approvals', href: '/contract-approvals', icon: ClipboardCheck, perms: ['contract.approve'] },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { name: 'Products', href: '/products', icon: Package, perms: ['inventory.view'] },
      { name: 'Inventory', href: '/inventory', icon: Warehouse, perms: ['inventory.view'] },
      { name: 'Price Chart', href: '/price-chart', icon: Tags, perms: ['pricechart.view'] },
    ],
  },
  {
    label: 'Reports',
    items: [
      { name: 'Reports', href: '/reports', icon: BarChart3, perms: ['report.view.branch', 'report.view.all'] },
    ],
  },
  {
    // The Agent module's commission/deposit-custody ledger — an AGENT's own
    // page and an approver's all-agents page are two different perms/routes,
    // so at most one of the two items below is ever visible to a given user.
    label: 'Agent Ledger',
    items: [
      { name: 'My Deposits', href: '/my-deposits', icon: Wallet, perms: ['agent.ledger.remit'] },
      { name: 'Agent Ledger', href: '/agent-ledger', icon: Wallet, perms: ['agent.ledger.manage'] },
    ],
  },
  {
    label: 'Tools',
    items: [
      { name: 'USSD Simulator', href: '/ussd-simulator', icon: Smartphone },
    ],
  },
  {
    label: 'Administration',
    items: [
      { name: 'Users', href: '/users', icon: UserCog, perms: ['user.manage'] },
      { name: 'Roles', href: '/roles', icon: ShieldCheck, perms: ['role.manage'] },
      { name: 'Branches', href: '/branches', icon: Building2, perms: ['user.manage'] },
      { name: 'Settings', href: '/settings', icon: Settings, perms: ['settings.manage'] },
    ],
  },
];

/** The 4 items promoted to their own mobile bottom-tab, in tab order. Everything else lives in the "More" sheet. */
export const PRIMARY_MOBILE_HREFS = ['/dashboard', '/customers', '/contracts', '/reports'];

// Derived from navGroups (not a separately-declared list) so a primary tab's
// icon/perms can never drift from its desktop-sidebar definition.
const allNavItems = navGroups.flatMap((g) => g.items);
export const primaryMobileItems: NavItem[] = PRIMARY_MOBILE_HREFS
  .map((href) => allNavItems.find((i) => i.href === href))
  .filter((i): i is NavItem => !!i);

export function useVisibleNavGroups(): NavGroup[] {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  return navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.perms?.length || hasPermission(...i.perms)) }))
    .filter((g) => g.items.length > 0);
}
