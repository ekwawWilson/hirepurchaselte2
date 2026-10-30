'use client';

import { Lock } from 'lucide-react';
import { DEVICE_FINANCING_BRANDS, DEVICE_FINANCING_BRAND_LABELS, suggestDeviceFinancingBrand, type DeviceFinancingBrand } from '@/lib/constants/deviceFinancing';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Label } from '@/components/ui/label';

/** Marks a Device Financing phone (TECNO, Infinix, itel) wherever products and stock are listed. */
export function DeviceFinancingBadge({ brand, className = '' }: { brand: string | null | undefined; className?: string }) {
  if (!brand) return null;
  return (
    <span
      title="Sold only on Device Financing: PayTrigger locks the phone if payments stop"
      className={`inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200/60 whitespace-nowrap ${className}`}
    >
      <Lock className="h-3 w-3" />
      Device Financing · {DEVICE_FINANCING_BRAND_LABELS[brand as DeviceFinancingBrand] ?? brand}
    </span>
  );
}

export const ALL_FINANCING = '__all__';

/** All products, Device Financing phones only, or every other product. */
export function FinancingFilterSelect({ value, onChange, className = 'sm:w-48' }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label="Device Financing or regular"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_FINANCING}>All products</SelectItem>
        <SelectItem value="device">Device Financing phones</SelectItem>
        <SelectItem value="regular">Regular products</SelectItem>
      </SelectContent>
    </Select>
  );
}

export const NOT_DEVICE_FINANCING = 'NONE';

/**
 * The product form's choice: a regular product, or a Device Financing phone
 * and its brand. Offers the brand the name suggests. `locked`: the product
 * is already marked and this user may not change or remove the mark.
 */
export function DeviceFinancingField({ value, onChange, nameHint, locked }: {
  value: string; onChange: (v: string) => void; nameHint: string; locked?: boolean;
}) {
  const suggested = suggestDeviceFinancingBrand(nameHint);
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3">
      <Label>Device Financing (PayTrigger)</Label>
      <Select value={value} onValueChange={onChange} disabled={locked}>
        <SelectTrigger className="mt-1.5 bg-white"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_DEVICE_FINANCING}>No: a regular product</SelectItem>
          {DEVICE_FINANCING_BRANDS.map((b) => <SelectItem key={b} value={b}>Yes: a {DEVICE_FINANCING_BRAND_LABELS[b]} phone</SelectItem>)}
        </SelectContent>
      </Select>
      {value === NOT_DEVICE_FINANCING && suggested && !locked && (
        <p className="text-xs text-amber-700 mt-1.5">
          This looks like a {DEVICE_FINANCING_BRAND_LABELS[suggested]} phone.{' '}
          <button type="button" className="font-semibold underline" onClick={() => onChange(suggested)}>Mark it as Device Financing</button>
        </p>
      )}
      <p className="text-xs text-gray-500 mt-1.5">
        {locked
          ? 'Only an admin who can change settings may change or remove this mark.'
          : 'A Device Financing phone is sold only on Device Financing, after it is enrolled with PayTrigger, and locks itself if payments stop. It is never sold on Deposit + Instalment.'}
      </p>
    </div>
  );
}

/** Whether a product passes the filter, for pages that filter what they already loaded. */
export function matchesFinancing(filter: string, brand: string | null | undefined): boolean {
  return filter === ALL_FINANCING || (filter === 'device') === !!brand;
}
