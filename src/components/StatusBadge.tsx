import { cn, getStatusColor, statusLabel } from '@/lib/utils';

/** A contract, instalment, payment or stock status as a coloured pill, in plain words. */
export function StatusBadge({ status, label, size = 'md', className }: { status: string; label?: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-full font-medium', size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs', getStatusColor(status), className)}>
      {label ?? statusLabel(status)}
    </span>
  );
}
