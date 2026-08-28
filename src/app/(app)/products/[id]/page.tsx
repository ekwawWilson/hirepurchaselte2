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

interface PriceChartEntry {
  id: string; contractType: string; termMonths: number; paymentFrequency: string;
  totalPayableMinor: number; depositAmountMinor: number; effectiveTo: string | null;
}
interface Product {
  id: string; sku: string; name: string; brand: string | null; model: string | null;
  cashPriceMinor: number; isActive: boolean; priceChartEntries: PriceChartEntry[];
}

const frequencyLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase();
const ALL_CONTRACT_TYPES = ['SAVE_TO_OWN', 'DEPOSIT_INSTALMENT', 'DEVICE_LOAN'];

export default function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canUpdate = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const { toast } = useToast();
  const [product, setProduct] = useState<Product | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', brand: '', model: '', cashPrice: '', isActive: true });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const { product } = await api.get<{ product: Product }>(`/products/${id}`);
      setProduct(product);
      setForm({
        name: product.name, brand: product.brand ?? '', model: product.model ?? '',
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

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/products/${id}`, {
        name: form.name, brand: form.brand, model: form.model,
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

  if (!product) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
  }

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
              <div><p className="text-xs text-gray-500">Brand/Model</p><p className="text-gray-900">{[product.brand, product.model].filter(Boolean).join(' ') || '—'}</p></div>
              <div><p className="text-xs text-gray-500">Cash price</p><p className="text-gray-900">{formatCurrency(product.cashPriceMinor)}</p></div>
              <div><p className="text-xs text-gray-500">Status</p><Badge variant={product.isActive ? 'success' : 'secondary'}>{product.isActive ? 'Active' : 'Inactive'}</Badge></div>
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
