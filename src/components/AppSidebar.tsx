"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOrgSettingsStore } from "@/lib/orgSettingsStore";
import { APP_NAME } from "@/lib/constants/branding";
import { useVisibleNavGroups } from "@/lib/navigation";
import { cn, companyInitials } from "@/lib/utils";

function BrandStrip() {
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);

  return (
    <div className="h-14 flex items-center gap-2.5 px-4 border-b border-slate-800 shrink-0">
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt={companyName} className="w-7 h-7 rounded-lg object-cover shrink-0" />
      ) : (
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <span className="text-white text-[11px] font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
        </div>
      )}
      <div className="leading-none min-w-0">
        <p className="font-heading text-[14px] font-extrabold text-white tracking-tight truncate">{companyName}</p>
        <p className="text-[9px] text-slate-500 font-medium uppercase tracking-widest mt-0.5">Hire Purchase</p>
      </div>
    </div>
  );
}

function SidebarNav({ pathname }: { pathname: string | null }) {
  const visibleGroups = useVisibleNavGroups();

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
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                    active ? "bg-primary text-white" : "text-slate-400 hover:text-white hover:bg-white/8"
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

/** Desktop-only (`lg:` and up) — mobile nav is MobileTabBar + MoreSheet instead. */
export default function AppSidebar() {
  const pathname = usePathname();

  return (
    <div className="hidden lg:flex h-full w-60 shrink-0 flex-col bg-slate-900 border-r border-slate-800">
      <BrandStrip />
      <SidebarNav pathname={pathname} />
      <div className="border-t border-slate-800 px-3 py-3 shrink-0">
        <p className="text-[10px] text-slate-600 text-center">{APP_NAME} &middot; hire-purchase, simplified</p>
      </div>
    </div>
  );
}
