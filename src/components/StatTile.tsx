import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const COLOR_MAP = {
  blue: 'bg-blue-100 text-primary',
  emerald: 'bg-emerald-100 text-emerald-600',
  amber: 'bg-amber-100 text-amber-600',
  red: 'bg-red-100 text-red-600',
  purple: 'bg-purple-100 text-purple-600',
  gray: 'bg-gray-100 text-gray-600',
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
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center shrink-0', COLOR_MAP[color])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{label}</p>
          <p className="text-lg font-semibold text-gray-900 truncate">{value}</p>
          {caption && <p className="text-xs text-gray-400 mt-0.5">{caption}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
