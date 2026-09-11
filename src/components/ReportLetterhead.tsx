'use client';

import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import { companyInitials } from '@/lib/utils';
import { CompanyLogo } from '@/components/CompanyLogo';

/** Company branding shown at the top of every report page — see docs/01-plan.md. */
export function ReportLetterhead() {
  const { companyName, address, phone, email, logoUrl } = useOrgSettingsStore((s) => s.settings);
  const contactLine = [address, phone, email].filter(Boolean).join(' · ');

  return (
    <div className="flex items-center gap-3 pb-4 mb-1 border-b border-gray-200">
      <CompanyLogo
        logoUrl={logoUrl}
        companyName={companyName}
        imgClassName="w-9 h-9 rounded-lg object-cover shrink-0"
        fallback={
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <span className="text-white text-sm font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
          </div>
        }
      />
      <div className="leading-tight">
        <p className="font-bold text-gray-900">{companyName}</p>
        {contactLine && <p className="text-xs text-gray-500">{contactLine}</p>}
      </div>
    </div>
  );
}
