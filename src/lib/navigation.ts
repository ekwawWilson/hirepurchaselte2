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
      { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, perms: ['report.view.branch', 'report.view.all'] },
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
