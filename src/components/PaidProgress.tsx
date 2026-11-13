import { cn, formatCurrency } from '@/lib/utils';

/** How much of a contract is paid, as a bar with the balance left: what staff scan a list for. */
export function PaidProgress({ paidMinor, totalMinor, className }: { paidMinor: number; totalMinor: number; className?: string }) {
  const percent = totalMinor > 0 ? Math.min(100, Math.max(0, Math.round((paidMinor / totalMinor) * 100))) : 0;
  return (
    <div className={cn('min-w-[8rem]', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-gray-900 whitespace-nowrap">{formatCurrency(Math.max(0, totalMinor - paidMinor))} left</span>
        <span className="text-gray-500">{percent}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${percent}% paid`}>
        <div className={cn('h-full rounded-full', percent >= 100 ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
