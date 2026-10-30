'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface CategoryCommission { categoryId: string; name: string; commissionMinor: number | null }
interface CommissionSettings { fixedCommissionMinor: number; deferredCommissionMinor: number; completionBonusMinor: number; categories: CategoryCommission[] }

const toGhs = (minor: number | null) => (minor === null ? '' : (minor / 100).toString());
const toMinor = (ghs: string) => Math.round(parseFloat(ghs) * 100);

/**
 * What an agent keeps out of each cash deposit they collect, by the kind of
 * product sold: an amount per product category, and a default for any
 * category left empty (commissionSettingsService.ts).
 */
export function AgentCommissionCard() {
  const { toast } = useToast();
  const [defaultGhs, setDefaultGhs] = useState('0');
  const [deferredGhs, setDeferredGhs] = useState('0');
  const [bonusGhs, setBonusGhs] = useState('0');
  const [categories, setCategories] = useState<CategoryCommission[]>([]);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  function show(settings: CommissionSettings) {
    setDefaultGhs(toGhs(settings.fixedCommissionMinor));
    setDeferredGhs(toGhs(settings.deferredCommissionMinor));
    setBonusGhs(toGhs(settings.completionBonusMinor));
    setCategories(settings.categories);
    setRates(Object.fromEntries(settings.categories.map((c) => [c.categoryId, toGhs(c.commissionMinor)])));
    setLoaded(true);
  }

  useEffect(() => {
    api.get<{ settings: CommissionSettings }>('/settings/commission')
      .then((r) => show(r.settings))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load commission settings', variant: 'destructive' }));
  }, [toast]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { settings } = await api.patch<{ settings: CommissionSettings }>('/settings/commission', {
        fixedCommissionMinor: toMinor(defaultGhs || '0'),
        deferredCommissionMinor: toMinor(deferredGhs || '0'),
        completionBonusMinor: toMinor(bonusGhs || '0'),
        categoryRates: categories.map((c) => ({
          categoryId: c.categoryId,
          commissionMinor: rates[c.categoryId]?.trim() ? toMinor(rates[c.categoryId]) : null,
        })),
      });
      show(settings);
      toast({
        title: 'Commission saved',
        description: 'Applies to deposits agents collect from now on — already-recorded deposits keep the commission they were given at the time.',
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save commission', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Agent commission</CardTitle></CardHeader>
      <CardContent>
        {!loaded ? (
          <div className="flex justify-center py-6"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" /></div>
        ) : (
          <form className="space-y-5" onSubmit={onSave}>
            <p className="text-sm text-gray-500">
              What an agent keeps out of each cash deposit they collect, by the kind of product sold. The rest is what they
              owe the office — see Agent Ledger for who owes what.
            </p>

            {categories.length > 0 && (
              <div>
                <Label>By product category (GHS per deposit)</Label>
                <div className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-200">
                  {categories.map((c) => (
                    <div key={c.categoryId} className="flex items-center justify-between gap-3 px-3 py-2">
                      <label htmlFor={`commission-${c.categoryId}`} className="text-sm text-gray-800 truncate">{c.name}</label>
                      <Input
                        id={`commission-${c.categoryId}`} type="number" step="0.01" min="0" className="w-32 shrink-0"
                        placeholder={`Default (${defaultGhs || '0'})`}
                        value={rates[c.categoryId] ?? ''}
                        onChange={(e) => setRates({ ...rates, [c.categoryId]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1.5">Leave a category empty to use the default below.</p>
              </div>
            )}

            <div className="max-w-xs">
              <Label htmlFor="commission-default">Default commission per deposit (GHS)</Label>
              <Input
                id="commission-default" required type="number" step="0.01" min="0" className="mt-1.5"
                value={defaultGhs} onChange={(e) => setDefaultGhs(e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">
                For a category with no amount of its own{categories.length === 0 ? ' — add product categories on the Products page to set amounts per category' : ''}, and for any product with no category.
              </p>
            </div>

            <div className="rounded-xl border border-gray-200 p-3 space-y-3">
              <div>
                <p className="text-sm font-medium text-gray-900">Paid when the customer completes</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Optional. Hold part of the commission back, and add a bonus, both paid once the customer has paid everything,
                  so agents earn more for sales that are paid off. Fixed on each sale when it is approved; mark them paid under Agent Ledger.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 max-w-md">
                <div>
                  <Label htmlFor="commission-deferred">Held back (GHS per sale)</Label>
                  <Input id="commission-deferred" type="number" step="0.01" min="0" className="mt-1.5" value={deferredGhs} onChange={(e) => setDeferredGhs(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="commission-bonus">Completion bonus (GHS)</Label>
                  <Input id="commission-bonus" type="number" step="0.01" min="0" className="mt-1.5" value={bonusGhs} onChange={(e) => setBonusGhs(e.target.value)} />
                </div>
              </div>
              {(Number(deferredGhs) > 0 || Number(bonusGhs) > 0) && (
                <p className="text-xs text-gray-600">
                  With the default above: an agent keeps GHS {Number(defaultGhs || 0).toFixed(2)} from the deposit at sale, and is paid
                  GHS {(Number(deferredGhs || 0) + Number(bonusGhs || 0)).toFixed(2)} more when the customer completes:
                  GHS {(Number(defaultGhs || 0) + Number(deferredGhs || 0) + Number(bonusGhs || 0)).toFixed(2)} per completed sale.
                  The amount held back is in addition to what they keep at sale; set the default lower to split the same total.
                </p>
              )}
            </div>

            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save commission'}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
