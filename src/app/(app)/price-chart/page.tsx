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

interface Product { id: string; name: string; sku: string }
interface PriceChartEntry {
  id: string;
  product: Product;
  contractType: string;
  termMonths: number;
  paymentFrequency: string;
  depositPercentage: number;
  totalPayableMinor: number;
  instalmentAmountMinor: number;
  interestRateBps: number | null;
  effectiveTo: string | null;
}

const CONTRACT_TYPES = ['SAVE_TO_OWN', 'DEPOSIT_INSTALMENT', 'DEVICE_LOAN'];
const PAYMENT_FREQUENCIES = ['MONTHLY', 'WEEKLY', 'DAILY'];
const frequencyLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase();

export default function PriceChartPage() {
  const canEdit = useAuthStore((s) => s.hasPermission('pricechart.edit'));
  const { toast } = useToast();
  const [entries, setEntries] = useState<PriceChartEntry[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    productId: '', contractType: 'DEPOSIT_INSTALMENT', termMonths: '6', paymentFrequency: 'MONTHLY', depositPercentage: '0', totalPayable: '', interestRateBps: '',
  });

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
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/price-chart', {
        productId: form.productId,
        contractType: form.contractType,
        termMonths: Number(form.termMonths),
        paymentFrequency: form.paymentFrequency,
        depositPercentage: Number(form.depositPercentage),
        totalPayableMinor: Math.round(parseFloat(form.totalPayable) * 100),
        ...(form.contractType === 'DEVICE_LOAN' && { interestRateBps: Number(form.interestRateBps) }),
      });
      toast({ title: 'Price chart entry created' });
      setShowForm(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create entry', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">New Price Chart Entry</h1>
          <p className="text-sm text-gray-500 mt-0.5">Drives the figures a contract auto-populates from</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Entry details</CardTitle></CardHeader>
          <CardContent>
            <form className="grid grid-cols-2 gap-4" onSubmit={onCreate}>
              <div className="col-span-2">
                <Label>Product</Label>
                <Select required value={form.productId} onValueChange={(v) => setForm({ ...form, productId: v })}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select a product..." /></SelectTrigger>
                  <SelectContent>
                    {products.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} ({p.sku})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Contract type</Label>
                <Select
                  value={form.contractType}
                  onValueChange={(v) => setForm({ ...form, contractType: v, depositPercentage: v === 'DEPOSIT_INSTALMENT' ? form.depositPercentage : '0' })}
                >
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTRACT_TYPES.map((t) => <SelectItem key={t} value={t}>{contractTypeLabel(t)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Term (months)</Label>
                <Input required type="number" min={1} className="mt-1.5" value={form.termMonths} onChange={(e) => setForm({ ...form, termMonths: e.target.value })} />
              </div>
              <div>
                <Label>Payment frequency</Label>
                <Select value={form.paymentFrequency} onValueChange={(v) => setForm({ ...form, paymentFrequency: v })}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{frequencyLabel(f)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {form.contractType === 'DEPOSIT_INSTALMENT' && (
                <div>
                  <Label>Deposit %</Label>
                  <Input required type="number" min={0} max={100} className="mt-1.5" value={form.depositPercentage} onChange={(e) => setForm({ ...form, depositPercentage: e.target.value })} />
                </div>
              )}
              <div>
                <Label>Total payable (GHS)</Label>
                <Input required type="number" step="0.01" className="mt-1.5" value={form.totalPayable} onChange={(e) => setForm({ ...form, totalPayable: e.target.value })} />
              </div>
              {form.contractType === 'DEVICE_LOAN' && (
                <div>
                  <Label>Interest rate (bps/yr, e.g. 2400 = 24%)</Label>
                  <Input required type="number" className="mt-1.5" value={form.interestRateBps} onChange={(e) => setForm({ ...form, interestRateBps: e.target.value })} />
                </div>
              )}
              <div className="col-span-2 flex gap-2">
                <Button type="submit" disabled={saving || !form.productId}>{saving ? 'Saving...' : 'Create entry'}</Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
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
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-medium text-gray-900">{e.product.name}</TableCell>
                    <TableCell>{contractTypeLabel(e.contractType)}</TableCell>
                    <TableCell>{e.termMonths}mo</TableCell>
                    <TableCell>{frequencyLabel(e.paymentFrequency)}</TableCell>
                    <TableCell>{e.depositPercentage}%</TableCell>
                    <TableCell>{formatCurrency(e.totalPayableMinor)}</TableCell>
                    <TableCell>{formatCurrency(e.instalmentAmountMinor)}</TableCell>
                    <TableCell>
                      {e.effectiveTo ? <Badge variant="secondary">Superseded</Badge> : <Badge className="bg-green-600">Active</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
