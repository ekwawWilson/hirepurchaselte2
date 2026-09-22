'use client';

import { useEffect, useState } from 'react';
import { Plus, Tags as TagsIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AccessDenied } from '@/components/AccessDenied';

interface Product { id: string; name: string; sku: string }
interface PriceChartEntry {
  id: string;
  product: Product;
  contractType: string;
  termMonths: number;
  paymentFrequency: string;
  depositAmountMinor: number;
  totalPayableMinor: number;
  instalmentAmountMinor: number;
  interestRateBps: number | null;
  effectiveTo: string | null;
}

// SAVE_TO_OWN is open-ended savings with no payment terms — it's never priced
// (priceChartService.ts rejects it), so this bundle form only ever offers
// the two types that actually have terms to price.
const CONTRACT_TYPES = ['DEPOSIT_INSTALMENT', 'DEVICE_LOAN'] as const;
const PAYMENT_FREQUENCIES = ['MONTHLY', 'WEEKLY', 'DAILY'];
// Matches the legacy hirepurchase app's fixed pricing tiers exactly (its
// ProductPricing model only ever offers 3/4/6-month terms) — see constants/contracts.ts.
const TERM_MONTHS_OPTIONS = [3, 4, 6];
const frequencyLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase();

interface TypeFormState {
  enabled: boolean;
  totalPayable: string;
  depositAmount: string;
  interestRateBps: string;
}
const emptyTypeForm: TypeFormState = { enabled: false, totalPayable: '', depositAmount: '', interestRateBps: '' };

export default function PriceChartPage() {
  const canView = useAuthStore((s) => s.hasPermission('pricechart.view'));
  const canEdit = useAuthStore((s) => s.hasPermission('pricechart.edit'));
  const { toast } = useToast();
  const [entries, setEntries] = useState<PriceChartEntry[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [productId, setProductId] = useState('');
  const [termMonths, setTermMonths] = useState('6');
  const [paymentFrequency, setPaymentFrequency] = useState('MONTHLY');
  const [typeForms, setTypeForms] = useState<Record<string, TypeFormState>>({
    DEPOSIT_INSTALMENT: { ...emptyTypeForm },
    DEVICE_LOAN: { ...emptyTypeForm },
  });

  const [editTarget, setEditTarget] = useState<PriceChartEntry | null>(null);
  const [editForm, setEditForm] = useState({ totalPayable: '', depositAmount: '', interestRateBps: '' });
  const [editSaving, setEditSaving] = useState(false);

  // Which contract types already have an active entry for the exact combo
  // currently selected — a product's price chart must satisfy all three
  // contract types, so this bundle form fills in whatever's missing rather
  // than requiring separate trips per type. See docs/01-plan.md §14.
  const alreadyPriced = new Set(
    entries
      .filter((e) => e.product.id === productId && e.termMonths === Number(termMonths) && e.paymentFrequency === paymentFrequency && !e.effectiveTo)
      .map((e) => e.contractType),
  );

  function updateType(type: string, patch: Partial<TypeFormState>) {
    setTypeForms((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));
  }

  async function load() {
    setIsLoading(true);
    try {
      const [{ entries }, { products }] = await Promise.all([
        api.get<{ entries: PriceChartEntry[] }>('/price-chart'),
        api.get<{ products: Product[] }>('/products'),
      ]);
      setEntries(entries);
      setProducts(products);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load price chart', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!canView) { setIsLoading(false); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  function resetForm() {
    setProductId('');
    setTermMonths('6');
    setPaymentFrequency('MONTHLY');
    setTypeForms({ DEPOSIT_INSTALMENT: { ...emptyTypeForm }, DEVICE_LOAN: { ...emptyTypeForm } });
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
    if (!editTarget) return;
    setEditSaving(true);
    try {
      await api.post('/price-chart', {
        productId: editTarget.product.id,
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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    const entriesPayload: Record<string, { totalPayableMinor: number; depositAmountMinor?: number; interestRateBps?: number }> = {};
    for (const type of CONTRACT_TYPES) {
      const t = typeForms[type];
      if (!t.enabled || alreadyPriced.has(type)) continue;
      entriesPayload[type] = {
        totalPayableMinor: Math.round(parseFloat(t.totalPayable || '0') * 100),
        ...(type === 'DEPOSIT_INSTALMENT' && { depositAmountMinor: Math.round(parseFloat(t.depositAmount || '0') * 100) }),
        ...(type === 'DEVICE_LOAN' && { interestRateBps: Number(t.interestRateBps || '0') }),
      };
    }
    if (Object.keys(entriesPayload).length === 0) {
      toast({ title: 'Nothing to save', description: 'Enable at least one contract type to price.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/price-chart/bundle', { productId, termMonths: Number(termMonths), paymentFrequency, entries: entriesPayload });
      toast({ title: 'Price chart entries created' });
      setShowForm(false);
      resetForm();
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create entries', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-3xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Price a Product</h1>
          <p className="text-sm text-gray-500 mt-0.5">Every product needs pricing for both contract types with terms — fill in whichever is missing for this term. Save to Own has no payment terms and is never priced.</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Product &amp; term</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <Label>Product</Label>
                <Select required value={productId} onValueChange={setProductId}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select a product..." /></SelectTrigger>
                  <SelectContent>
                    {products.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} ({p.sku})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Term</Label>
                <Select value={termMonths} onValueChange={setTermMonths}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TERM_MONTHS_OPTIONS.map((m) => <SelectItem key={m} value={String(m)}>{m} months</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Payment frequency</Label>
                <Select value={paymentFrequency} onValueChange={setPaymentFrequency}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{frequencyLabel(f)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <form onSubmit={onCreate} className="space-y-4">
          {CONTRACT_TYPES.map((type) => {
            const priced = productId && alreadyPriced.has(type);
            const t = typeForms[type];
            return (
              <Card key={type} className={priced ? 'opacity-60' : undefined}>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="flex items-center gap-2">
                    {contractTypeLabel(type)}
                    {priced && <Badge variant="success">Already priced</Badge>}
                  </CardTitle>
                  {!priced && (
                    <label className="flex items-center gap-2 text-sm text-gray-600">
                      <input type="checkbox" checked={t.enabled} onChange={(e) => updateType(type, { enabled: e.target.checked })} />
                      Price this type
                    </label>
                  )}
                </CardHeader>
                {!priced && t.enabled && (
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Total payable (GHS)</Label>
                        <Input required type="number" step="0.01" className="mt-1.5" value={t.totalPayable} onChange={(e) => updateType(type, { totalPayable: e.target.value })} />
                      </div>
                      {type === 'DEPOSIT_INSTALMENT' && (
                        <div>
                          <Label>Deposit required (GHS)</Label>
                          <Input required type="number" step="0.01" min={0} className="mt-1.5" value={t.depositAmount} onChange={(e) => updateType(type, { depositAmount: e.target.value })} />
                        </div>
                      )}
                      {type === 'DEVICE_LOAN' && (
                        <div>
                          <Label>Interest rate (bps/yr, e.g. 2400 = 24%)</Label>
                          <Input required type="number" className="mt-1.5" value={t.interestRateBps} onChange={(e) => updateType(type, { interestRateBps: e.target.value })} />
                        </div>
                      )}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}

          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !productId}>{saving ? 'Saving...' : 'Save pricing'}</Button>
            <Button type="button" variant="outline" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</Button>
          </div>
        </form>
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Price Chart</h1>
          <p className="text-sm text-gray-500 mt-0.5">Admin-managed pricing that contracts read from</p>
        </div>
        <AccessDenied
          message="You don't have permission to view the price chart."
          hint="Ask an administrator for the pricechart.view permission."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Price Chart</h1>
          <p className="text-sm text-gray-500 mt-0.5">Admin-managed pricing that contracts read from</p>
        </div>
        {canEdit && (
          <Button onClick={() => setShowForm(true)} size="sm" className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">New Entry</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
          ) : entries.length === 0 ? (
            <div className="text-center py-12 px-4">
              <TagsIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">No price chart entries yet</p>
              {canEdit && <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add First Entry</Button>}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Deposit</TableHead>
                  <TableHead>Total Payable</TableHead>
                  <TableHead>Instalment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium text-gray-900">{e.product.name}</TableCell>
                    <TableCell>{contractTypeLabel(e.contractType)}</TableCell>
                    <TableCell>{e.termMonths}mo</TableCell>
                    <TableCell>{frequencyLabel(e.paymentFrequency)}</TableCell>
                    <TableCell>{formatCurrency(e.depositAmountMinor)}</TableCell>
                    <TableCell>{formatCurrency(e.totalPayableMinor)}</TableCell>
                    <TableCell>{formatCurrency(e.instalmentAmountMinor)}</TableCell>
                    <TableCell>
                      {e.effectiveTo ? <Badge variant="secondary">Superseded</Badge> : <Badge variant="success">Active</Badge>}
                    </TableCell>
                    <TableCell>
                      {/* SAVE_TO_OWN entries are historical only — new ones are rejected
                          (priceChartService.ts), so an old one can't be re-priced either. */}
                      {canEdit && !e.effectiveTo && e.contractType !== 'SAVE_TO_OWN' && (
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

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit price</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <>
              <p className="text-sm text-muted-foreground">
                {editTarget.product.name} &middot; {contractTypeLabel(editTarget.contractType)} &middot; {editTarget.termMonths} months &middot; {frequencyLabel(editTarget.paymentFrequency)}
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
