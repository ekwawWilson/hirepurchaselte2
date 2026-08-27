'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Package as PackageIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Product {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  model: string | null;
  cashPriceMinor: number;
  isActive: boolean;
}

export default function ProductsPage() {
  const canCreate = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ sku: '', name: '', brand: '', model: '', cashPrice: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    setIsLoading(true);
    try {
      const { products } = await api.get<{ products: Product[] }>('/products');
      setProducts(products);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load products', variant: 'destructive' });
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
      const cashPriceMinor = Math.round(parseFloat(form.cashPrice) * 100);
      await api.post('/products', { sku: form.sku, name: form.name, brand: form.brand, model: form.model, cashPriceMinor });
      toast({ title: 'Product created', description: `${form.name} was added to the catalogue.` });
      setForm({ sku: '', name: '', brand: '', model: '', cashPrice: '' });
      setShowForm(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create product', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Add Product</h1>
          <p className="text-sm text-gray-500 mt-0.5">Add a device model to the catalogue</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Product details</CardTitle></CardHeader>
          <CardContent>
            <form className="grid grid-cols-2 gap-4" onSubmit={onCreate}>
              <div>
                <Label>SKU</Label>
                <Input required className="mt-1.5" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              </div>
              <div>
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
              <div className="col-span-2 flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create product'}</Button>
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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">Device models available for hire purchase</p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowForm(true)} size="sm" className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">Add Product</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
          ) : products.length === 0 ? (
            <div className="text-center py-12 px-4">
              <PackageIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">No products yet</p>
              {canCreate && <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add First Product</Button>}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Brand/Model</TableHead>
                  <TableHead>Cash Price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><Link href={`/products/${p.id}`} className="font-mono text-xs text-blue-700 hover:underline">{p.sku}</Link></TableCell>
                    <TableCell className="font-medium text-gray-900"><Link href={`/products/${p.id}`} className="hover:underline">{p.name}</Link></TableCell>
                    <TableCell>{[p.brand, p.model].filter(Boolean).join(' ') || '—'}</TableCell>
                    <TableCell>{formatCurrency(p.cashPriceMinor)}</TableCell>
                    <TableCell><Badge variant={p.isActive ? 'default' : 'secondary'}>{p.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
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
