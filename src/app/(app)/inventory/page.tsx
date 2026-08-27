'use client';

import { useEffect, useState } from 'react';
import { Plus, Warehouse as WarehouseIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { getStatusColor } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

interface Product { id: string; name: string; sku: string }
interface Branch { id: string; name: string; code: string }
interface InventoryItem {
  id: string;
  serialNumber: string;
  status: string;
  product: Product;
}

export default function InventoryPage() {
  const canReceive = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const isAllBranch = useAuthStore((s) => s.user?.branchId === null);
  const { toast } = useToast();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [productId, setProductId] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [branchId, setBranchId] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    setIsLoading(true);
    try {
      const [{ items }, { products }] = await Promise.all([
        api.get<{ items: InventoryItem[] }>('/inventory'),
        api.get<{ products: Product[] }>('/products'),
      ]);
      setItems(items);
      setProducts(products);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load inventory', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showForm || !isAllBranch) return;
    api.get<{ branches: Branch[] }>('/branches').then((r) => setBranches(r.branches)).catch(() => undefined);
  }, [showForm, isAllBranch]);

  async function onReceive(e: React.FormEvent) {
    e.preventDefault();
    if (isAllBranch && !branchId) {
      toast({ title: 'Select a branch', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/inventory', { productId, serialNumber, ...(isAllBranch && { branchId }) });
      toast({ title: 'Stock received', description: `${serialNumber} added to inventory.` });
      setProductId('');
      setSerialNumber('');
      setBranchId('');
      setShowForm(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to receive stock', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-md">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Receive Stock</h1>
          <p className="text-sm text-gray-500 mt-0.5">Add a serialized unit to inventory</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Item details</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onReceive}>
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
                <Label>Serial number / IMEI</Label>
                <Input required className="mt-1.5" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
              </div>
              {isAllBranch && (
                <div>
                  <Label>Branch</Label>
                  <Select required value={branchId} onValueChange={setBranchId}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select a branch..." /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name} ({b.code})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={saving || !productId}>{saving ? 'Saving...' : 'Receive item'}</Button>
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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-0.5">Serialized stock across all branches you can see</p>
        </div>
        {canReceive && (
          <Button onClick={() => setShowForm(true)} size="sm" className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">Receive Stock</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 px-4">
              <WarehouseIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">No inventory items yet</p>
              {canReceive && <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Receive First Item</Button>}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Serial / IMEI</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.serialNumber}</TableCell>
                    <TableCell className="font-medium text-gray-900">{i.product.name}</TableCell>
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 ${getStatusColor(i.status)}`}>{i.status}</span></TableCell>
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
