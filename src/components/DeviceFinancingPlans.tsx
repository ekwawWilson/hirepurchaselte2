'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency } from '@/lib/utils';
import { PLAN_MONTHS_MAX, PLAN_MONTHS_MIN, planInstalmentMinor } from '@/lib/constants/deviceFinancing';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface Plan { months: number; totalPriceMinor: number; depositMinor: number }
interface Row { months: string; total: string; deposit: string }

const toRow = (p: Plan): Row => ({ months: String(p.months), total: (p.totalPriceMinor / 100).toFixed(2), deposit: (p.depositMinor / 100).toFixed(2) });
const toPlan = (r: Row): Plan => ({ months: Number(r.months), totalPriceMinor: Math.round(Number(r.total) * 100), depositMinor: Math.round(Number(r.deposit) * 100) });

/**
 * A Device Financing phone's price plans: each a length in months, the total
 * the customer pays (deposit included) and the deposit. A sale takes its
 * figures from the plan chosen; changing a plan affects new sales only.
 */
export function DeviceFinancingPlans({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ plans: Plan[] }>(`/products/${productId}/plans`).then((r) => setRows(r.plans.map(toRow))).catch(() => setRows([]));
  }, [productId]);

  async function save() {
    if (!rows) return;
    setSaving(true);
    try {
      const r = await api.patch<{ plans: Plan[] }>(`/products/${productId}/plans`, { plans: rows.map(toPlan) });
      setRows(r.plans.map(toRow));
      toast({ title: 'Plans saved', description: 'New sales of this phone use them. Sales already made keep their own figures.' });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not save the plans', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const set = (i: number, change: Partial<Row>) => setRows((rs) => rs!.map((r, n) => (n === i ? { ...r, ...change } : r)));

  return (
    <Card>
      <CardHeader><CardTitle>Device Financing plans</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-gray-500">
          What the customer pays in all for each plan length, deposit included, and the deposit. A sale must use one of these.
          A month is 30 daily or 4 weekly payments.
        </p>
        {rows === null ? <p className="text-sm text-gray-400">Loading...</p> : (
          <>
            {rows.length === 0 && <p className="text-sm text-amber-700">No plans yet: this phone cannot be sold until it has one.</p>}
            {rows.length > 0 && (
              <div className="grid grid-cols-[4.5rem_1fr_1fr_1.5rem] sm:grid-cols-[5rem_1fr_1fr_1fr_1.5rem] gap-2 text-xs font-medium text-gray-500">
                <span>Months</span><span>Total (GHS)</span><span>Deposit (GHS)</span><span className="hidden sm:block">Pays</span><span />
              </div>
            )}
            {rows.map((r, i) => {
              const plan = toPlan(r);
              const valid = plan.months > 0 && plan.totalPriceMinor > plan.depositMinor;
              return (
                <div key={i} className="grid grid-cols-[4.5rem_1fr_1fr_1.5rem] sm:grid-cols-[5rem_1fr_1fr_1fr_1.5rem] gap-2 items-center">
                  <Input type="number" min={PLAN_MONTHS_MIN} max={PLAN_MONTHS_MAX} aria-label="Months" disabled={!canEdit} value={r.months} onChange={(e) => set(i, { months: e.target.value })} />
                  <Input type="number" min={0} step="0.01" aria-label="Total price" disabled={!canEdit} value={r.total} onChange={(e) => set(i, { total: e.target.value })} />
                  <Input type="number" min={0} step="0.01" aria-label="Deposit" disabled={!canEdit} value={r.deposit} onChange={(e) => set(i, { deposit: e.target.value })} />
                  <span className="hidden sm:block text-xs text-gray-600">
                    {valid ? `${formatCurrency(planInstalmentMinor(plan, 'DAILY'))}/day or ${formatCurrency(planInstalmentMinor(plan, 'WEEKLY'))}/week` : ''}
                  </span>
                  {canEdit
                    ? <button type="button" className="text-gray-400 hover:text-red-600" aria-label={`Remove the ${r.months}-month plan`} onClick={() => setRows(rows.filter((_, n) => n !== i))}>&times;</button>
                    : <span />}
                </div>
              );
            })}
            {canEdit && (
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  const last = rows[rows.length - 1];
                  setRows([...rows, { months: String(Math.min(PLAN_MONTHS_MAX, (last ? Number(last.months) : 2) + 1)), total: '', deposit: '' }]);
                }}>Add a plan</Button>
                <Button type="button" size="sm" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save plans'}</Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
