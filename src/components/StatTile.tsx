import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const COLOR_MAP = {
  blue: 'bg-blue-50 text-blue-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  red: 'bg-red-50 text-red-600',
  purple: 'bg-purple-50 text-purple-600',
  gray: 'bg-gray-50 text-gray-600',
} as const;

/**
 * The tinted-icon-chip stat tile used across every report page (and the reports
 * hub) — one shared component instead of copy-pasting the same 8-line block
 * into 11+ pages. See docs/01-plan.md for the design-language source.
 */
export function StatTile({
  icon: Icon, label, value, color = 'blue', caption,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  color?: keyof typeof COLOR_MAP;
  caption?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-gray-100 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs sm:text-sm font-medium text-gray-500 truncate">{label}</span>
        <div className={cn('p-1.5 sm:p-2 rounded-lg shrink-0', COLOR_MAP[color])}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      </div>
      <div className="min-w-0">
        <p className="truncate text-base sm:text-xl font-bold text-gray-900" title={value}>{value}</p>
        {caption && <p className="text-xs text-gray-400 mt-0.5 truncate">{caption}</p>}
      </div>
    </div>
  );
}
