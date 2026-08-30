"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  Building2,
  Settings,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAuthStore } from "@/lib/authStore";
import { useOrgSettingsStore } from "@/lib/orgSettingsStore";
import { APP_NAME } from "@/lib/constants/branding";
import { cn, companyInitials } from "@/lib/utils";

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  perms?: string[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, perms: ["report.view.branch", "report.view.all"] },
    ],
  },
  {
    label: "Customers",
    items: [
      { name: "Customers", href: "/customers", icon: Users, perms: ["customer.view"] },
    ],
  },
  {
    label: "Contracts & Payments",
    items: [
      { name: "Contracts", href: "/contracts", icon: FileText, perms: ["contract.view"] },
    ],
  },
  {
    label: "Inventory",
    items: [
      { name: "Products", href: "/products", icon: Package, perms: ["inventory.view"] },
      { name: "Inventory", href: "/inventory", icon: Warehouse, perms: ["inventory.view"] },
      { name: "Price Chart", href: "/price-chart", icon: Tags, perms: ["pricechart.view"] },
    ],
  },
  {
    label: "Reports",
    items: [
      { name: "Reports", href: "/reports", icon: BarChart3, perms: ["report.view.branch", "report.view.all"] },
    ],
  },
  {
    label: "Tools",
    items: [
      { name: "USSD Simulator", href: "/ussd-simulator", icon: Smartphone },
    ],
  },
  {
    label: "Administration",
    items: [
      { name: "Users", href: "/users", icon: UserCog, perms: ["user.manage"] },
      { name: "Branches", href: "/branches", icon: Building2, perms: ["user.manage"] },
      { name: "Settings", href: "/settings", icon: Settings, perms: ["settings.manage"] },
    ],
  },
];

function BrandStrip() {
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);

  return (
    <div className="h-14 flex items-center gap-2.5 px-4 border-b border-slate-800 shrink-0">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt={companyName} className="w-7 h-7 rounded-lg object-cover shrink-0" />
      ) : (
        <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <span className="text-white text-[11px] font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
        </div>
      )}
      <div className="leading-none min-w-0">
        <p className="text-[14px] font-extrabold text-white tracking-tight truncate">{companyName}</p>
        <p className="text-[9px] text-slate-500 font-medium uppercase tracking-widest mt-0.5">Hire Purchase</p>
      </div>
    </div>
  );
}

function SidebarNav({ pathname, onNavigate }: { pathname: string | null; onNavigate: () => void }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);

  const visibleGroups = navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.perms?.length || hasPermission(...i.perms)) }))
    .filter((g) => g.items.length > 0);

  return (
    <nav className="flex-1 overflow-y-auto sidebar-scroll py-3 px-2.5 space-y-0.5">
      {visibleGroups.map((group) => (
        <div key={group.label}>
          <p className="px-2.5 pt-5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                    active ? "bg-blue-600 text-white" : "text-slate-400 hover:text-white hover:bg-white/8"
                  )}
                >
                  <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-slate-500")} />
                  <span className="flex-1 truncate">{item.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export default function AppSidebar({ mobileOpen, onMobileClose }: { mobileOpen: boolean; onMobileClose: () => void }) {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop sidebar */}
      <div className="hidden lg:flex h-full w-60 shrink-0 flex-col bg-slate-900 border-r border-slate-800">
        <BrandStrip />
        <SidebarNav pathname={pathname} onNavigate={() => {}} />
        <div className="border-t border-slate-800 px-3 py-3 shrink-0">
          <p className="text-[10px] text-slate-600 text-center">{APP_NAME} &middot; hire-purchase, simplified</p>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/40" onClick={onMobileClose} />
      )}
      <div
        className={cn(
          "lg:hidden fixed inset-y-0 left-0 z-50 w-64 flex flex-col bg-slate-900 border-r border-slate-800 transform transition-transform duration-200",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between">
          <BrandStrip />
          <button onClick={onMobileClose} className="mr-3 p-1.5 rounded-lg text-slate-400 hover:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>
        <SidebarNav pathname={pathname} onNavigate={onMobileClose} />
      </div>
    </>
  );
}
