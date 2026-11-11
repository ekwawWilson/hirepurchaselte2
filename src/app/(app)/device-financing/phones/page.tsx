'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Smartphone } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency } from '@/lib/utils';
import { DEVICE_FINANCING_BRANDS, DEVICE_FINANCING_BRAND_LABELS, PLAN_MONTHS_MAX, planInstalmentMinor } from '@/lib/constants/deviceFinancing';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AccessDenied } from '@/components/AccessDenied';
import { DeviceFinancingBadge } from '@/components/DeviceFinancing';

interface Plan { months: number; totalPriceMinor: number; depositMinor: number }
interface Phone {
  id: string; name: string; model: string | null; cashPriceMinor: number; isActive: boolean; deviceFinancingBrand: string | null;
  category: { id: string; name: string } | null; financingPlans: Plan[]; stock: { total: number; available: number };
}
interface Category { id: string; name: string }
interface PlanRow { months: string; total: string; deposit: string }

const EMPTY = { name: '', brand: 'TECNO', model: '', categoryId: '', cashPrice: '' };
const STARTING_PLANS: PlanRow[] = [{ months: '3', total: '', deposit: '' }, { months: '4', total: '', deposit: '' }, { months: '6', total: '', deposit: '' }];
const minor = (cedis: string) => Math.round(Number(cedis) * 100);

/** Device Financing phone models: each a TECNO, Infinix or itel model with its price plans, apart from every other product. */
export default function PhonesPage() {
  const canView = useAuthStore((s) => s.hasPermission('inventory.view', 'contract.create'));
  const canEdit = useAuthStore((s) => s.hasPermission('pricechart.edit'));
  const { toast } = useToast();
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [plans, setPlans] = useState<PlanRow[]>(STARTING_PLANS);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get<{ phones: Phone[] }>(`/device-financing/phones${showInactive ? '?inactive=1' : ''}`).then((r) => setPhones(r.phones))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load the phones', variant: 'destructive' }));
  }, [showInactive, toast]);
  useEffect(() => { if (canView) load(); }, [canView, load]);
  useEffect(() => {
    if (adding) api.get<{ categories: Category[] }>('/products/categories').then((r) => setCategories(r.categories)).catch(() => undefined);
  }, [adding]);

  async function create() {
    setSaving(true);
    try {
      await api.post('/device-financing/phones', {
        name: form.name, brand: form.brand, model: form.model, categoryId: form.categoryId || null, cashPriceMinor: minor(form.cashPrice),
        plans: plans.filter((p) => p.total && p.deposit).map((p) => ({ months: Number(p.months), totalPriceMinor: minor(p.total), depositMinor: minor(p.deposit) })),
      });
      toast({ title: 'Phone added', description: `${form.name} can now be stocked and sold on its plans.` });
      setAdding(false); setForm(EMPTY); setPlans(STARTING_PLANS);
      load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not add the phone', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function setActive(phone: Phone, isActive: boolean) {
    try {
      await api.patch(`/device-financing/phones/${phone.id}`, { isActive });
      toast({ title: isActive ? 'Back on sale' : 'No longer sold', description: isActive ? undefined : 'Phones already sold keep their contracts.' });
      load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not change it', variant: 'destructive' });
    }
  }

  if (!canView) return <AccessDenied message="You don't have permission to view phones." hint="Ask an administrator for the inventory.view permission." />;

  const setPlan = (i: number, change: Partial<PlanRow>) => setPlans(plans.map((p, n) => (n === i ? { ...p, ...change } : p)));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Phones</h1>
          <p className="text-sm text-gray-500 mt-0.5">Device Financing models (TECNO, Infinix, itel) and the plans they are sold on</p>
        </div>
        {canEdit && <Button size="sm" onClick={() => setAdding(true)}><Plus className="mr-1.5 h-4 w-4" />Add phone</Button>}
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show phones no longer sold
      </label>

      {phones === null ? <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
        : phones.length === 0 ? (
          <Card><CardContent className="py-12 text-center"><Smartphone className="h-8 w-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-500">No phones yet. Add a model to start.</p></CardContent></Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {phones.map((p) => (
              <Card key={p.id} className={p.isActive ? undefined : 'opacity-60'}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/products/${p.id}`} className="font-semibold text-gray-900 hover:underline">{p.name}</Link>
                      <DeviceFinancingBadge brand={p.deviceFinancingBrand} className="ml-2 align-middle" />
                      <p className="text-xs text-gray-500 mt-0.5">
                        Cash price {formatCurrency(p.cashPriceMinor)}{p.category && <> &middot; {p.category.name}</>}{!p.isActive && <> &middot; no longer sold</>}
                      </p>
                    </div>
                    <Link href={`/device-financing/stock?productId=${p.id}`} className="shrink-0 text-right text-xs text-primary hover:underline">
                      <span className="block text-lg font-semibold text-gray-900">{p.stock.available}</span>available of {p.stock.total}
                    </Link>
                  </div>
                  {p.financingPlans.length === 0 ? <p className="text-sm text-amber-700">No plans: it cannot be sold until it has one.</p> : (
                    <div className="grid grid-cols-3 gap-2">
                      {p.financingPlans.map((plan) => (
                        <div key={plan.months} className="rounded-lg border border-gray-200 p-2 text-xs">
                          <p className="font-semibold text-gray-900">{plan.months} months</p>
                          <p className="text-gray-600">{formatCurrency(plan.totalPriceMinor)}</p>
                          <p className="text-gray-500">deposit {formatCurrency(plan.depositMinor)}</p>
                          <p className="text-gray-500">{formatCurrency(planInstalmentMinor(plan, 'DAILY'))}/day</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {canEdit && (
                    <div className="flex gap-2">
                      <Button asChild size="sm" variant="outline"><Link href={`/products/${p.id}`}>Edit plans</Link></Button>
                      <Button size="sm" variant="outline" onClick={() => setActive(p, !p.isActive)}>{p.isActive ? 'Stop selling' : 'Sell again'}</Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add a phone model</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input className="mt-1.5" placeholder="e.g. Tecno Pop 20 (64/3)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Brand</Label>
                <select className="mt-1.5 h-10 w-full rounded-md border border-input bg-white px-2 text-sm" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })}>
                  {DEVICE_FINANCING_BRANDS.map((b) => <option key={b} value={b}>{DEVICE_FINANCING_BRAND_LABELS[b]}</option>)}
                </select>
              </div>
              <div><Label>Model</Label><Input className="mt-1.5" placeholder="Pop 20" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>
              <div><Label>Cash price (GHS)</Label><Input type="number" min={0} step="0.01" className="mt-1.5" value={form.cashPrice} onChange={(e) => setForm({ ...form, cashPrice: e.target.value })} /></div>
              <div>
                <Label>Category</Label>
                <select className="mt-1.5 h-10 w-full rounded-md border border-input bg-white px-2 text-sm" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                  <option value="">None</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <Label>Plans</Label>
              <p className="text-xs text-gray-500">Total includes the deposit. Leave a plan empty to not offer it.</p>
              <div className="mt-1.5 space-y-2">
                {plans.map((p, i) => (
                  <div key={i} className="grid grid-cols-[4.5rem_1fr_1fr_1.5rem] gap-2 items-center">
                    <Input type="number" min={1} max={PLAN_MONTHS_MAX} aria-label="Months" value={p.months} onChange={(e) => setPlan(i, { months: e.target.value })} />
                    <Input type="number" min={0} step="0.01" placeholder="Total" aria-label="Total price" value={p.total} onChange={(e) => setPlan(i, { total: e.target.value })} />
                    <Input type="number" min={0} step="0.01" placeholder="Deposit" aria-label="Deposit" value={p.deposit} onChange={(e) => setPlan(i, { deposit: e.target.value })} />
                    <button type="button" className="text-gray-400 hover:text-red-600" aria-label="Remove plan" onClick={() => setPlans(plans.filter((_, n) => n !== i))}>&times;</button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => setPlans([...plans, { months: '', total: '', deposit: '' }])}>Add a plan</Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button disabled={saving || !form.name.trim() || !form.cashPrice} onClick={create}>{saving ? 'Saving...' : 'Add phone'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
