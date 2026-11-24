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
    <div className="h-[68px] flex items-center gap-3 px-5 border-b border-slate-100 shrink-0">
      <CompanyLogo
        logoUrl={logoUrl}
        companyName={companyName}
        imgClassName="w-9 h-9 rounded-xl object-cover shrink-0"
        fallback={
          <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shrink-0 shadow-sm shadow-blue-900/20">
            <span className="text-white text-[11px] font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
          </div>
        }
      />
      <div className="leading-none min-w-0">
        <p className="font-heading text-[14px] font-extrabold text-slate-900 tracking-tight truncate">{companyName}</p>
        <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest mt-1">Hire Purchase</p>
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
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all",
        active ? "bg-blue-50 text-primary shadow-sm shadow-blue-950/[0.03]" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
      )}
    >
      <item.icon className={cn("h-[18px] w-[18px] shrink-0", active ? "text-primary" : "text-slate-400")} />
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
    <nav className="flex-1 overflow-y-auto sidebar-scroll py-3 px-3 space-y-0.5">
      {visibleGroups.map((group) => {
        if (group.items.length === 1) {
          return (
            <div key={group.label}>
              <p className="px-3 pt-5 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
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
              className="w-full flex items-center justify-between px-3 pt-5 pb-2 group"
            >
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400 group-hover:text-slate-600">
                {group.label}
              </span>
              {isOpen
                ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
            </button>
            {isOpen && (
              <div className="space-y-1">
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
    <div className="hidden lg:flex h-full w-[264px] shrink-0 flex-col bg-white border-r border-slate-200/80">
      <BrandStrip />
      <SidebarNav pathname={pathname} />
      <div className="border-t border-slate-100 px-5 py-4 shrink-0">
        <p className="text-[11px] text-slate-400 text-center truncate">{APP_NAME}</p>
      </div>
    </div>
  );
}
