"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, ChevronDown } from "lucide-react";
import { useAuthStore } from "@/lib/authStore";
import { useOrgSettingsStore } from "@/lib/orgSettingsStore";
import { cn, companyInitials } from "@/lib/utils";
import { CompanyLogo } from "@/components/CompanyLogo";

function UserMenu() {
  const router = useRouter();
  const { user, clearAuth } = useAuthStore();
  const [open, setOpen] = useState(false);

  if (!user) return null;
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase();

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-xl border transition-all",
          open ? "bg-gray-100 border-gray-300" : "bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300"
        )}
      >
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center text-white text-[11px] font-bold shrink-0">
          {initials}
        </div>
        <div className="hidden sm:flex flex-col items-start leading-none">
          <span className="text-[13px] font-semibold text-gray-800">{user.firstName} {user.lastName}</span>
          <span className="text-[11px] text-gray-500 mt-0.5">{user.role}</span>
        </div>
        <ChevronDown className={cn("h-3.5 w-3.5 text-gray-400 transition-transform hidden sm:block", open && "rotate-180")} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-56 z-50 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden animate-slide-down">
            <div className="px-4 py-3 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center text-white text-sm font-bold shrink-0">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{user.firstName} {user.lastName}</p>
                  <p className="text-xs text-gray-500 truncate">{user.email}</p>
                </div>
              </div>
              <span className="inline-flex mt-2 items-center px-2 py-0.5 rounded-md bg-blue-50 border border-blue-100 text-[11px] font-semibold text-blue-700">
                {user.role}
              </span>
            </div>
            <div className="p-1.5">
              <button
                onClick={() => {
                  setOpen(false);
                  clearAuth();
                  router.push("/login");
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-red-600 hover:bg-red-50 transition-colors text-left"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function AppTopBar() {
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);

  return (
    <header className="h-14 shrink-0 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-6 z-30 sticky top-0">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <CompanyLogo
            logoUrl={logoUrl}
            companyName={companyName}
            imgClassName="w-8 h-8 rounded-lg object-cover shrink-0"
            fallback={
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <span className="text-white text-[13px] font-extrabold tracking-tighter leading-none">{companyInitials(companyName)}</span>
              </div>
            }
          />
          <div className="flex flex-col leading-none min-w-0">
            <span className="font-heading text-[15px] font-extrabold text-gray-900 tracking-tight truncate">{companyName}</span>
            <span className="text-[10px] text-gray-400 font-medium tracking-wide uppercase hidden sm:block">Hire Purchase System</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2">
        <UserMenu />
      </div>
    </header>
  );
}
