'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Package as PackageIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

interface Product {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  model: string | null;
  cashPriceMinor: number;
  isActive: boolean;
  missingContractTypes: string[];
}
interface Category { id: string; name: string }

// Matches the legacy hirepurchase app's fixed pricing tiers exactly — see constants/contracts.ts.
const TERM_MONTHS = [3, 4, 6] as const;
const NEW_CATEGORY = '__new__';
type TermPricingForm = { totalPayable: string; deposit: string };
const emptyTermPricing: Record<number, TermPricingForm> = { 3: { totalPayable: '', deposit: '' }, 4: { totalPayable: '', deposit: '' }, 6: { totalPayable: '', deposit: '' } };

export default function ProductsPage() {
  const canCreate = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', categoryId: '', cashPrice: '' });
  const [newCategoryName, setNewCategoryName] = useState('');
  const [termPricing, setTermPricing] = useState(emptyTermPricing);
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

  useEffect(() => {
    if (!showForm) return;
    api.get<{ categories: Category[] }>('/products/categories').then((r) => setCategories(r.categories)).catch(() => undefined);
  }, [showForm]);

  function resetForm() {
    setForm({ name: '', description: '', categoryId: '', cashPrice: '' });
    setNewCategoryName('');
    setTermPricing(emptyTermPricing);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.categoryId) {
      toast({ title: 'Select a category', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      let categoryId = form.categoryId;
      if (categoryId === NEW_CATEGORY) {
        if (!newCategoryName.trim()) {
          toast({ title: 'Enter a name for the new category', variant: 'destructive' });
          setSaving(false);
          return;
        }
        const { category } = await api.post<{ category: Category }>('/products/categories', { name: newCategoryName.trim() });
        categoryId = category.id;
      }

      const termPricingPayload: Record<number, { totalPayableMinor: number; depositAmountMinor: number }> = {};
      for (const term of TERM_MONTHS) {
        const t = termPricing[term];
        if (!t.totalPayable.trim()) continue; // blank = skip this period
        termPricingPayload[term] = {
          totalPayableMinor: Math.round(parseFloat(t.totalPayable) * 100),
          depositAmountMinor: Math.round(parseFloat(t.deposit || '0') * 100),
        };
      }

      const cashPriceMinor = Math.round(parseFloat(form.cashPrice) * 100);
      await api.post('/products', {
        name: form.name, description: form.description, categoryId, cashPriceMinor,
        ...(Object.keys(termPricingPayload).length > 0 && { termPricing: termPricingPayload }),
      });
      toast({ title: 'Product created', description: `${form.name} was added to the catalogue.` });
      resetForm();
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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Add New Product</h1>
          <p className="text-sm text-gray-500 mt-0.5">Add a device model to the catalogue</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Product details</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onCreate}>
              <div>
                <Label>Product Name *</Label>
                <Input required placeholder="e.g., iPhone 15 Pro" className="mt-1.5" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Description</Label>
                <Input placeholder="Product details" className="mt-1.5" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Category *</Label>
                  <Select required value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v })}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select category" /></SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      <SelectItem value={NEW_CATEGORY}>+ Add new category…</SelectItem>
                    </SelectContent>
                  </Select>
                  {form.categoryId === NEW_CATEGORY && (
                    <Input
                      required
                      autoFocus
                      placeholder="New category name"
                      className="mt-2"
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                    />
                  )}
                </div>
                <div>
                  <Label>Base Price (GHS) *</Label>
                  <Input required type="number" step="0.01" min={0} placeholder="0.00" className="mt-1.5" value={form.cashPrice} onChange={(e) => setForm({ ...form, cashPrice: e.target.value })} />
                </div>
              </div>

              <div className="pt-2">
                <p className="text-sm font-semibold text-gray-900">Pricing by Installment Period</p>
                <div className="mt-3 space-y-3">
                  {TERM_MONTHS.map((term) => (
                    <div key={term} className="ring-1 ring-black/5 p-3">
                      <p className="text-xs font-semibold text-gray-700 mb-2">{term} months</p>
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
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  Leave blank to skip a period. These prices are auto-filled during contract creation.
                </p>
              </div>

              <div className="flex gap-2 pt-2">
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create product'}</Button>
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</Button>
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
                  <TableHead>Pricing</TableHead>
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
                    <TableCell>
                      {p.missingContractTypes.length === 0 ? (
                        <Badge variant="success">3/3 types priced</Badge>
                      ) : (
                        <Badge variant="destructive" title={`Missing: ${p.missingContractTypes.map(contractTypeLabel).join(', ')}`}>
                          {3 - p.missingContractTypes.length}/3 types priced
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell><Badge variant={p.isActive ? 'success' : 'secondary'}>{p.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
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
