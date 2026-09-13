"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOrgSettingsStore } from "@/lib/orgSettingsStore";
import { APP_NAME } from "@/lib/constants/branding";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useVisibleNavGroups, type NavItem } from "@/lib/navigation";
import { cn, companyInitials } from "@/lib/utils";
import { CompanyLogo } from "@/components/CompanyLogo";

function BrandStrip() {
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);

  return (
    <div className="h-14 flex items-center gap-2.5 px-4 border-b border-slate-800 shrink-0">
      <CompanyLogo
        logoUrl={logoUrl}
        companyName={companyName}
        imgClassName="w-7 h-7 rounded-lg object-cover shrink-0"
        fallback={
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <span className="text-white text-[11px] font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
          </div>
        }
      />
      <div className="leading-none min-w-0">
        <p className="font-heading text-[14px] font-extrabold text-white tracking-tight truncate">{companyName}</p>
        <p className="text-[9px] text-slate-500 font-medium uppercase tracking-widest mt-0.5">Hire Purchase</p>
      </div>
    </div>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string | null }) {
  const active = pathname === item.href || pathname?.startsWith(item.href + "/");
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
        active ? "bg-primary text-white" : "text-slate-400 hover:text-white hover:bg-white/8"
      )}
    >
      <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-white" : "text-slate-500")} />
      <span className="flex-1 truncate">{item.name}</span>
    </Link>
  );
}

/**
 * Grouped navigation, as the legacy app lays it out: a group holding a single
 * page is just a heading and its link, while a group of several collapses
 * behind a chevron. The first group and whichever group holds the current
 * page start open, so the page you are on is never hidden.
 */
function SidebarNav({ pathname }: { pathname: string | null }) {
  const visibleGroups = useVisibleNavGroups();
  const activeLabel = visibleGroups.find((g) =>
    g.items.some((i) => pathname === i.href || pathname?.startsWith(i.href + "/"))
  )?.label;

  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set([visibleGroups[0]?.label, activeLabel].filter((l): l is string => !!l))
  );

  // Navigating into a collapsed group opens it.
  useEffect(() => {
    if (activeLabel) setOpenGroups((prev) => (prev.has(activeLabel) ? prev : new Set(prev).add(activeLabel)));
  }, [activeLabel]);

  function toggle(label: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <nav className="flex-1 overflow-y-auto sidebar-scroll py-3 px-2.5 space-y-0.5">
      {visibleGroups.map((group) => {
        if (group.items.length === 1) {
          return (
            <div key={group.label}>
              <p className="px-2.5 pt-5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {group.label}
              </p>
              <NavLink item={group.items[0]} pathname={pathname} />
            </div>
          );
        }

        const isOpen = openGroups.has(group.label);
        return (
          <div key={group.label}>
            <button
              type="button"
              onClick={() => toggle(group.label)}
              aria-expanded={isOpen}
              className="w-full flex items-center justify-between px-2.5 pt-5 pb-1 group"
            >
              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 group-hover:text-slate-400">
                {group.label}
              </span>
              {isOpen
                ? <ChevronDown className="h-3 w-3 text-slate-600" />
                : <ChevronRight className="h-3 w-3 text-slate-600" />}
            </button>
            {isOpen && (
              <div className="space-y-0.5">
                {group.items.map((item) => <NavLink key={item.href} item={item} pathname={pathname} />)}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** Desktop-only (`lg:` and up) — mobile nav is MobileTabBar + MoreSheet instead. */
export default function AppSidebar() {
  const pathname = usePathname();

  return (
    <div className="hidden lg:flex h-full w-60 shrink-0 flex-col bg-slate-900 border-r border-slate-800">
      <BrandStrip />
      <SidebarNav pathname={pathname} />
      <div className="border-t border-slate-800 px-5 py-3 shrink-0">
        <p className="text-xs text-slate-600 text-center truncate">{APP_NAME}</p>
      </div>
    </div>
  );
}
