'use client';

import Link from 'next/link';
import { X } from 'lucide-react';
import { useVisibleNavGroups, PRIMARY_MOBILE_HREFS } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/**
 * Bottom sheet for every nav item NOT promoted to a mobile primary tab —
 * grouped exactly like the desktop sidebar (same useVisibleNavGroups source),
 * just rendered as icon tiles instead of a list. Always mounted (like the
 * drawer it replaces) so the open/close transform can animate both ways.
 */
export function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = useVisibleNavGroups()
    .map((g) => ({ ...g, items: g.items.filter((i) => !PRIMARY_MOBILE_HREFS.includes(i.href)) }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      {open && <div className="lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />}
      <div
        className={cn(
          'lg:hidden fixed inset-x-0 bottom-0 z-50 max-h-[75vh] flex flex-col rounded-t-2xl bg-white shadow-2xl transform transition-transform duration-200',
          open ? 'translate-y-0' : 'translate-y-full pointer-events-none',
        )}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <p className="font-heading font-bold text-gray-900">More</p>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto p-4 pb-8 space-y-5 safe-area-bottom">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-400 mb-2">{group.label}</p>
              <div className="grid grid-cols-3 gap-3">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className="flex flex-col items-center gap-1.5 p-3 rounded-xl ring-1 ring-black/5 hover:bg-gray-50 text-center transition-colors"
                  >
                    <div className="w-10 h-10 rounded-lg bg-blue-50 text-primary flex items-center justify-center">
                      <item.icon className="h-5 w-5" />
                    </div>
                    <span className="text-xs font-medium text-gray-700 leading-tight">{item.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
