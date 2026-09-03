'use client';

import { useEffect, useState, use } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface PriceChartEntry {
  id: string; contractType: string; termMonths: number; paymentFrequency: string;
  totalPayableMinor: number; depositAmountMinor: number; interestRateBps: number | null; effectiveTo: string | null;
}
interface Category { id: string; name: string }
interface Product {
  id: string; sku: string; name: string; description: string | null; brand: string | null; model: string | null;
  cashPriceMinor: number; isActive: boolean; category: Category | null; priceChartEntries: PriceChartEntry[];
}

const frequencyLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase();
const ALL_CONTRACT_TYPES = ['SAVE_TO_OWN', 'DEPOSIT_INSTALMENT', 'DEVICE_LOAN'];
const TERM_MONTHS = [3, 4, 6] as const;
type TermPricingForm = { totalPayable: string; deposit: string };
const emptyTermPricing: Record<number, TermPricingForm> = { 3: { totalPayable: '', deposit: '' }, 4: { totalPayable: '', deposit: '' }, 6: { totalPayable: '', deposit: '' } };
type DeviceLoanPricingForm = { totalPayable: string; interestRate: string };
const emptyDeviceLoanPricing: Record<number, DeviceLoanPricingForm> = { 3: { totalPayable: '', interestRate: '' }, 4: { totalPayable: '', interestRate: '' }, 6: { totalPayable: '', interestRate: '' } };

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canUpdate = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const canEditPricing = useAuthStore((s) => s.hasPermission('pricechart.edit'));
  const { toast } = useToast();
  const [product, setProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', categoryId: '', brand: '', model: '', cashPrice: '', isActive: true });
  const [saving, setSaving] = useState(false);
  const [showTermPricingForm, setShowTermPricingForm] = useState(false);
  const [termPricing, setTermPricing] = useState(emptyTermPricing);
  const [savingTermPricing, setSavingTermPricing] = useState(false);
  const [showDeviceLoanForm, setShowDeviceLoanForm] = useState(false);
  const [deviceLoanPricing, setDeviceLoanPricing] = useState(emptyDeviceLoanPricing);
  const [savingDeviceLoan, setSavingDeviceLoan] = useState(false);
  const [editTarget, setEditTarget] = useState<PriceChartEntry | null>(null);
  const [editForm, setEditForm] = useState({ totalPayable: '', depositAmount: '', interestRateBps: '' });
  const [editSaving, setEditSaving] = useState(false);

  async function load() {
    try {
      const { product } = await api.get<{ product: Product }>(`/products/${id}`);
      setProduct(product);
      setForm({
        name: product.name, description: product.description ?? '', categoryId: product.category?.id ?? '',
        brand: product.brand ?? '', model: product.model ?? '',
        cashPrice: (product.cashPriceMinor / 100).toFixed(2), isActive: product.isActive,
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load product', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!editing) return;
    api.get<{ categories: Category[] }>('/products/categories').then((r) => setCategories(r.categories)).catch(() => undefined);
  }, [editing]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/products/${id}`, {
        name: form.name, description: form.description, categoryId: form.categoryId || null, brand: form.brand, model: form.model,
        cashPriceMinor: Math.round(parseFloat(form.cashPrice) * 100), isActive: form.isActive,
      });
      toast({ title: 'Product updated' });
      setEditing(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update product', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  function openEdit(entry: PriceChartEntry) {
    setEditTarget(entry);
    setEditForm({
      totalPayable: (entry.totalPayableMinor / 100).toFixed(2),
      depositAmount: (entry.depositAmountMinor / 100).toFixed(2),
      interestRateBps: entry.interestRateBps !== null ? String(entry.interestRateBps) : '',
    });
  }

  async function onSaveEdit() {
    if (!editTarget || !product) return;
    setEditSaving(true);
    try {
      await api.post('/price-chart', {
        productId: product.id,
        contractType: editTarget.contractType,
        termMonths: editTarget.termMonths,
        paymentFrequency: editTarget.paymentFrequency,
        totalPayableMinor: Math.round(parseFloat(editForm.totalPayable) * 100),
        depositAmountMinor: editTarget.contractType === 'DEPOSIT_INSTALMENT' ? Math.round(parseFloat(editForm.depositAmount || '0') * 100) : 0,
        ...(editTarget.contractType === 'DEVICE_LOAN' && { interestRateBps: Number(editForm.interestRateBps || '0') }),
      });
      toast({ title: 'Price updated', description: 'The previous entry is kept as history, not overwritten.' });
      setEditTarget(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update pricing', variant: 'destructive' });
    } finally {
      setEditSaving(false);
    }
  }

  async function onSaveTermPricing() {
    if (!product) return;
    const payload: Record<number, { totalPayableMinor: number; depositAmountMinor: number }> = {};
    for (const term of TERM_MONTHS) {
      const t = termPricing[term];
      if (!t.totalPayable.trim()) continue; // blank = skip this period
      payload[term] = { totalPayableMinor: Math.round(parseFloat(t.totalPayable) * 100), depositAmountMinor: Math.round(parseFloat(t.deposit || '0') * 100) };
    }
    if (Object.keys(payload).length === 0) {
      toast({ title: 'Enter at least one period to price', variant: 'destructive' });
      return;
    }
    setSavingTermPricing(true);
    try {
      await api.patch(`/products/${id}`, { termPricing: payload });
      toast({ title: 'Deposit + Instalment pricing added' });
      setShowTermPricingForm(false);
      setTermPricing(emptyTermPricing);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save pricing', variant: 'destructive' });
    } finally {
      setSavingTermPricing(false);
    }
  }

  async function onSaveDeviceLoanPricing() {
    if (!product) return;
    const payload: Record<number, { totalPayableMinor: number; interestRateBps: number }> = {};
    for (const term of TERM_MONTHS) {
      const t = deviceLoanPricing[term];
      if (!t.totalPayable.trim()) continue; // blank = skip this period
      payload[term] = { totalPayableMinor: Math.round(parseFloat(t.totalPayable) * 100), interestRateBps: Number(t.interestRate || '0') };
    }
    if (Object.keys(payload).length === 0) {
      toast({ title: 'Enter at least one period to price', variant: 'destructive' });
      return;
    }
    setSavingDeviceLoan(true);
    try {
      await api.patch(`/products/${id}`, { deviceLoanPricing: payload });
      toast({ title: 'Device Loan pricing added' });
      setShowDeviceLoanForm(false);
      setDeviceLoanPricing(emptyDeviceLoanPricing);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save Device Loan pricing', variant: 'destructive' });
    } finally {
      setSavingDeviceLoan(false);
    }
  }

  if (!product) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  const pricedTermMonths = new Set(
    product.priceChartEntries.filter((e) => e.contractType === 'DEPOSIT_INSTALMENT' && !e.effectiveTo).map((e) => e.termMonths),
  );
  const hasMissingTerm = TERM_MONTHS.some((t) => !pricedTermMonths.has(t));
  const pricedDeviceLoanTerms = new Set(
    product.priceChartEntries.filter((e) => e.contractType === 'DEVICE_LOAN' && !e.effectiveTo).map((e) => e.termMonths),
  );
  const hasMissingDeviceLoanTerm = TERM_MONTHS.some((t) => !pricedDeviceLoanTerms.has(t));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{product.name}</h1>
          <p className="text-sm text-gray-500 mt-0.5 font-mono">{product.sku}</p>
        </div>
        {canUpdate && !editing && <Button variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          {editing ? (
            <form className="grid grid-cols-2 gap-4" onSubmit={onSave}>
              <div className="col-span-2">
                <Label>Name</Label>
                <Input required className="mt-1.5" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Description</Label>
                <Input className="mt-1.5" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Category</Label>
                <Select value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v })}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select category" /></SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Brand</Label>
                <Input className="mt-1.5" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
              </div>
              <div>
                <Label>Model</Label>
                <Input className="mt-1.5" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </div>
              <div>
                <Label>Cash price (GHS)</Label>
                <Input required type="number" step="0.01" className="mt-1.5" value={form.cashPrice} onChange={(e) => setForm({ ...form, cashPrice: e.target.value })} />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                  Active in catalogue
                </label>
              </div>
              <div className="col-span-2 flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><p className="text-xs text-gray-500">Category</p><p className="text-gray-900">{product.category?.name ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Brand/Model</p><p className="text-gray-900">{[product.brand, product.model].filter(Boolean).join(' ') || '—'}</p></div>
              <div><p className="text-xs text-gray-500">Cash price</p><p className="text-gray-900">{formatCurrency(product.cashPriceMinor)}</p></div>
              <div><p className="text-xs text-gray-500">Status</p><Badge variant={product.isActive ? 'success' : 'secondary'}>{product.isActive ? 'Active' : 'Inactive'}</Badge></div>
              <div className="col-span-2"><p className="text-xs text-gray-500">Description</p><p className="text-gray-900">{product.description ?? '—'}</p></div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>Price chart entries</CardTitle>
          {(() => {
            const priced = new Set(product.priceChartEntries.filter((e) => !e.effectiveTo).map((e) => e.contractType));
            const missing = ALL_CONTRACT_TYPES.filter((t) => !priced.has(t));
            return missing.length === 0 ? (
              <Badge variant="success">All 3 contract types priced</Badge>
            ) : (
              <Badge variant="destructive">Missing: {missing.map(contractTypeLabel).join(', ')}</Badge>
            );
          })()}
        </CardHeader>
        <CardContent className="p-0">
          {product.priceChartEntries.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">No price chart entries yet — add one from the Price Chart page</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Deposit</TableHead>
                  <TableHead>Total Payable</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {product.priceChartEntries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{contractTypeLabel(e.contractType)}</TableCell>
                    <TableCell>{e.termMonths}mo</TableCell>
                    <TableCell>{frequencyLabel(e.paymentFrequency)}</TableCell>
                    <TableCell>{formatCurrency(e.depositAmountMinor)}</TableCell>
                    <TableCell>{formatCurrency(e.totalPayableMinor)}</TableCell>
                    <TableCell>{e.effectiveTo ? <Badge variant="secondary">Superseded</Badge> : <Badge variant="success">Active</Badge>}</TableCell>
                    <TableCell>
                      {canEditPricing && !e.effectiveTo && (
                        <button className="text-xs text-primary hover:underline" onClick={() => openEdit(e)}>Edit</button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {canUpdate && hasMissingTerm && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle>Deposit + Instalment pricing</CardTitle>
            {!showTermPricingForm && (
              <Button size="sm" variant="outline" onClick={() => setShowTermPricingForm(true)}>Add missing pricing</Button>
            )}
          </CardHeader>
          {showTermPricingForm && (
            <CardContent className="space-y-3">
              {TERM_MONTHS.map((term) => {
                const priced = pricedTermMonths.has(term);
                return (
                  <div key={term} className={`ring-1 ring-black/5 p-3 ${priced ? 'opacity-60' : ''}`}>
                    <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      {term} months
                      {priced && <Badge variant="success">Already priced</Badge>}
                    </div>
                    {!priced && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs font-normal text-gray-500">Base Price (GHS)</Label>
                          <Input
                            type="number" step="0.01" min={0} placeholder="0.00" className="mt-1"
                            value={termPricing[term].totalPayable}
                            onChange={(e) => setTermPricing({ ...termPricing, [term]: { ...termPricing[term], totalPayable: e.target.value } })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs font-normal text-gray-500">Deposit (GHS)</Label>
                          <Input
                            type="number" step="0.01" min={0} placeholder="0.00" className="mt-1"
                            value={termPricing[term].deposit}
                            onChange={(e) => setTermPricing({ ...termPricing, [term]: { ...termPricing[term], deposit: e.target.value } })}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-gray-400">Leave blank to skip a period. These prices are auto-filled during contract creation.</p>
              <div className="flex gap-2 pt-1">
                <Button type="button" onClick={onSaveTermPricing} disabled={savingTermPricing}>{savingTermPricing ? 'Saving...' : 'Save pricing'}</Button>
                <Button type="button" variant="outline" onClick={() => { setShowTermPricingForm(false); setTermPricing(emptyTermPricing); }}>Cancel</Button>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {canUpdate && hasMissingDeviceLoanTerm && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <CardTitle>Device Loan pricing</CardTitle>
            {!showDeviceLoanForm && (
              <Button size="sm" variant="outline" onClick={() => setShowDeviceLoanForm(true)}>Add missing pricing</Button>
            )}
          </CardHeader>
          {showDeviceLoanForm && (
            <CardContent className="space-y-3">
              {TERM_MONTHS.map((term) => {
                const priced = pricedDeviceLoanTerms.has(term);
                return (
                  <div key={term} className={`ring-1 ring-black/5 p-3 ${priced ? 'opacity-60' : ''}`}>
                    <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-2">
                      {term} months
                      {priced && <Badge variant="success">Already priced</Badge>}
                    </div>
                    {!priced && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs font-normal text-gray-500">Total Payable (GHS)</Label>
                          <Input
                            type="number" step="0.01" min={0} placeholder="0.00" className="mt-1"
                            value={deviceLoanPricing[term].totalPayable}
                            onChange={(e) => setDeviceLoanPricing({ ...deviceLoanPricing, [term]: { ...deviceLoanPricing[term], totalPayable: e.target.value } })}
                          />
                        </div>
                        <div>
                          <Label className="text-xs font-normal text-gray-500">Interest rate (bps/yr, e.g. 2400 = 24%)</Label>
                          <Input
                            type="number" min={0} placeholder="0" className="mt-1"
                            value={deviceLoanPricing[term].interestRate}
                            onChange={(e) => setDeviceLoanPricing({ ...deviceLoanPricing, [term]: { ...deviceLoanPricing[term], interestRate: e.target.value } })}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-gray-400">Leave blank to skip a period. Cash is disbursed to the customer for a Device Loan — no deposit applies.</p>
              <div className="flex gap-2 pt-1">
                <Button type="button" onClick={onSaveDeviceLoanPricing} disabled={savingDeviceLoan}>{savingDeviceLoan ? 'Saving...' : 'Save pricing'}</Button>
                <Button type="button" variant="outline" onClick={() => { setShowDeviceLoanForm(false); setDeviceLoanPricing(emptyDeviceLoanPricing); }}>Cancel</Button>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit price</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <>
              <p className="text-sm text-muted-foreground">
                {contractTypeLabel(editTarget.contractType)} &middot; {editTarget.termMonths} months &middot; {frequencyLabel(editTarget.paymentFrequency)}
              </p>
              <p className="text-xs text-gray-400">
                Saving creates a new price entry effective now and supersedes this one — contracts already
                priced from it are unaffected; this only changes pricing for contracts created from now on.
              </p>
              <div className="space-y-3">
                <div>
                  <Label>Total payable (GHS)</Label>
                  <Input required type="number" step="0.01" className="mt-1.5" value={editForm.totalPayable} onChange={(e) => setEditForm({ ...editForm, totalPayable: e.target.value })} />
                </div>
                {editTarget.contractType === 'DEPOSIT_INSTALMENT' && (
                  <div>
                    <Label>Deposit required (GHS)</Label>
                    <Input required type="number" step="0.01" min={0} className="mt-1.5" value={editForm.depositAmount} onChange={(e) => setEditForm({ ...editForm, depositAmount: e.target.value })} />
                  </div>
                )}
                {editTarget.contractType === 'DEVICE_LOAN' && (
                  <div>
                    <Label>Interest rate (bps/yr, e.g. 2400 = 24%)</Label>
                    <Input required type="number" className="mt-1.5" value={editForm.interestRateBps} onChange={(e) => setEditForm({ ...editForm, interestRateBps: e.target.value })} />
                  </div>
                )}
              </div>
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={onSaveEdit} disabled={editSaving}>{editSaving ? 'Saving...' : 'Save new price'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
