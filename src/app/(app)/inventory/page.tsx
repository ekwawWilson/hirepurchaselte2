'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Search, Warehouse as WarehouseIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { getStatusColor } from '@/lib/utils';
import { unitTitle } from '@/lib/unitLabel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AccessDenied } from '@/components/AccessDenied';

interface Category { id: string; name: string }
interface Product { id: string; name: string; sku: string; categoryId: string | null; category: Category | null; isActive?: boolean }
interface Branch { id: string; name: string; code: string }
interface InventoryItem {
  id: string;
  serialNumber: string;
  name: string | null;
  description: string | null;
  status: string;
  product: Product;
  branch?: { name: string } | null;
  assignedAgent?: { id: string; firstName: string; lastName: string } | null;
}
interface AgentStock { id: string; firstName: string; lastName: string; branch: { name: string } | null; available: number; reserved: number; issued: number }
interface Handover { id: string; createdAt: string; fromAgentName: string | null; toAgentName: string | null; assignedByName: string | null; reason: string | null }

const ALL = '__all__';
const NO_CATEGORY = '__none__';
const EMPTY_FORM = { categoryId: '', productId: '', name: '', description: '', serialNumber: '', branchId: '' };

/**
 * Stock in three levels: category (Laptops) > product (HP Laptop) > each unit,
 * with its own model name (HP Envy), specification (15" screen, 200 GB HDD,
 * 6 GB RAM) and serial number / IMEI.
 */
export default function InventoryPage() {
  const canView = useAuthStore((s) => s.hasPermission('inventory.view'));
  const canReceive = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const canEdit = useAuthStore((s) => s.hasPermission('inventory.receive', 'inventory.adjust'));
  // Handing stock to agents (stockAssignmentService.ts); an agent sees only their own.
  const canAssign = useAuthStore((s) => s.hasPermission('inventory.transfer'));
  const isAgent = useAuthStore((s) => s.user?.role === 'AGENT');
  const isAllBranch = useAuthStore((s) => s.user?.branchId === null);
  const { toast } = useToast();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '' });
  const [agents, setAgents] = useState<AgentStock[]>([]);
  const [agentFilter, setAgentFilter] = useState(ALL);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null);
  const [history, setHistory] = useState<Handover[] | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        ...(search && { q: search }), ...(statusFilter !== ALL && { status: statusFilter }), ...(agentFilter !== ALL && { agentId: agentFilter }),
      });
      const [{ items }, { products }, { categories }, agentList] = await Promise.all([
        api.get<{ items: InventoryItem[] }>(`/inventory?${params}`),
        api.get<{ products: Product[] }>('/products'),
        api.get<{ categories: Category[] }>('/products/categories'),
        canAssign ? api.get<{ agents: AgentStock[] }>('/inventory/agents') : Promise.resolve({ agents: [] as AgentStock[] }),
      ]);
      setItems(items);
      setProducts(products);
      setCategories(categories);
      setAgents(agentList.agents);
      setSelected(new Set());
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load inventory', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [search, statusFilter, agentFilter, canAssign, toast]);

  useEffect(() => {
    if (!canView) { setIsLoading(false); return; }
    void load();
  }, [canView, load]);

  useEffect(() => {
    if (!showForm || !isAllBranch) return;
    api.get<{ branches: Branch[] }>('/branches').then((r) => setBranches(r.branches)).catch(() => undefined);
  }, [showForm, isAllBranch]);

  const productsInCategory = useMemo(
    () => products.filter((p) => p.isActive !== false && (form.categoryId === NO_CATEGORY ? !p.categoryId : p.categoryId === form.categoryId)),
    [products, form.categoryId],
  );
  const shown = categoryFilter === ALL ? items
    : items.filter((i) => (categoryFilter === NO_CATEGORY ? !i.product.categoryId : i.product.categoryId === categoryFilter));
  const uncategorised = products.some((p) => !p.categoryId);

  async function onReceive(e: React.FormEvent) {
    e.preventDefault();
    if (isAllBranch && !form.branchId) {
      toast({ title: 'Select a branch', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/inventory', {
        productId: form.productId, serialNumber: form.serialNumber, name: form.name, description: form.description,
        ...(isAllBranch && { branchId: form.branchId }),
      });
      const product = products.find((p) => p.id === form.productId);
      toast({ title: 'Stock received', description: `${unitTitle(product?.name, form.name)} (${form.serialNumber}) added to inventory.` });
      // Keep the category, product, model and specification: the next unit
      // received is very often another of the same, differing only in serial.
      setForm((f) => ({ ...f, serialNumber: '' }));
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to receive stock', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function onAssign() {
    setSaving(true);
    try {
      const r = await api.post<{ moved: number; alreadyThere: number }>('/inventory/assign', {
        inventoryItemIds: [...selected], agentId: assignTo === 'none' ? null : assignTo, reason: assignReason,
      });
      const agent = agents.find((a) => a.id === assignTo);
      toast({ title: `${r.moved} unit${r.moved === 1 ? '' : 's'} ${agent ? `assigned to ${agent.firstName} ${agent.lastName}` : 'taken back to the shop'}`, description: r.alreadyThere ? `${r.alreadyThere} already there.` : undefined });
      setAssignOpen(false);
      setAssignTo('');
      setAssignReason('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to assign stock', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  function openHistory(item: InventoryItem) {
    setHistoryItem(item);
    setHistory(null);
    api.get<{ history: Handover[] }>(`/inventory/${item.id}/assignments`).then((r) => setHistory(r.history)).catch(() => setHistory([]));
  }

  async function onSaveEdit() {
    if (!editItem) return;
    setSaving(true);
    try {
      await api.patch(`/inventory/${editItem.id}`, editForm);
      toast({ title: 'Item updated' });
      setEditItem(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update item', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Receive Stock</h1>
          <p className="text-sm text-gray-500 mt-0.5">Add a unit to inventory: its category, product, model, specification and serial number</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Item details</CardTitle></CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onReceive}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label>Category</Label>
                  <Select required value={form.categoryId} onValueChange={(v) => setForm({ ...form, categoryId: v, productId: '' })}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="e.g. Laptops" /></SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      {uncategorised && <SelectItem value={NO_CATEGORY}>No category</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Product</Label>
                  <Select required value={form.productId} onValueChange={(v) => setForm({ ...form, productId: v })} disabled={!form.categoryId}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder={form.categoryId ? 'e.g. HP Laptop' : 'Choose a category first'} /></SelectTrigger>
                    <SelectContent>
                      {productsInCategory.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {form.categoryId && productsInCategory.length === 0 && (
                    <p className="text-xs text-amber-700 mt-1">No products in this category yet — add one on the Products page.</p>
                  )}
                </div>
              </div>
              <div>
                <Label htmlFor="unit-name">Model</Label>
                <Input id="unit-name" required className="mt-1.5" placeholder="e.g. HP Envy" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="unit-spec">Description / specification</Label>
                <Textarea
                  id="unit-spec" rows={3} className="mt-1.5" placeholder={'e.g. 15" screen, 200 GB HDD, 6 GB RAM, silver'}
                  value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
                <p className="text-xs text-gray-400 mt-1">Printed on the customer&apos;s agreement and statement.</p>
              </div>
              <div>
                <Label htmlFor="unit-serial">Serial number / IMEI</Label>
                <Input id="unit-serial" required className="mt-1.5" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
              </div>
              {isAllBranch && (
                <div>
                  <Label>Branch</Label>
                  <Select required value={form.branchId} onValueChange={(v) => setForm({ ...form, branchId: v })}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select a branch..." /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name} ({b.code})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={saving || !form.productId}>{saving ? 'Saving...' : 'Receive item'}</Button>
                <Button type="button" variant="outline" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>Done</Button>
              </div>
              <p className="text-xs text-gray-400">After each unit the form keeps its details, so a batch of the same model only needs each serial number.</p>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!canView) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Inventory</h1>
          <p className="text-sm text-gray-500 mt-0.5">Serialized stock across all branches you can see</p>
        </div>
        <AccessDenied message="You don't have permission to view inventory." hint="Ask an administrator for the inventory.view permission." />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">{isAgent ? 'My stock' : 'Inventory'}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{isAgent ? 'The units assigned to you to sell, and the ones you have sold' : 'Every unit by category, product and model, across the branches you can see'}</p>
        </div>
        {canReceive && (
          <Button onClick={() => setShowForm(true)} size="sm" className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">Receive Stock</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      {canAssign && agents.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Stock with agents</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <button key={a.id} type="button" onClick={() => setAgentFilter(agentFilter === a.id ? ALL : a.id)}
                className={`rounded-lg border px-3 py-2 text-left text-sm ${agentFilter === a.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}>
                <span className="block font-medium text-gray-900">{a.firstName} {a.lastName}</span>
                <span className="block text-xs text-gray-500">{a.available} to sell · {a.reserved} reserved · {a.issued} sold{isAllBranch && a.branch ? ` · ${a.branch.name}` : ''}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className={`p-4 grid grid-cols-1 gap-2 ${canAssign ? 'sm:grid-cols-[1fr_auto_auto_auto]' : 'sm:grid-cols-[1fr_auto_auto]'}`}>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); }}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input className="pl-9" placeholder="Model, specification, product or serial..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Button type="submit" variant="outline">Search</Button>
          </form>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              {uncategorised && <SelectItem value={NO_CATEGORY}>No category</SelectItem>}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="sm:w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any status</SelectItem>
              {['AVAILABLE', 'RESERVED', 'ISSUED', 'RETURNED', 'WRITTEN_OFF'].map((s) => <SelectItem key={s} value={s}>{s.replace('_', ' ')}</SelectItem>)}
            </SelectContent>
          </Select>
          {canAssign && (
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Any holder</SelectItem>
                <SelectItem value="none">In the shop</SelectItem>
                {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.firstName} {a.lastName}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {canAssign && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
          <span className="text-sm font-medium text-blue-900">{selected.size} unit{selected.size === 1 ? '' : 's'} selected</span>
          <Button size="sm" onClick={() => setAssignOpen(true)}>Assign to agent</Button>
          <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
          ) : shown.length === 0 ? (
            <div className="text-center py-12 px-4">
              <WarehouseIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">{items.length === 0 && !search ? 'No inventory items yet' : 'Nothing matches'}</p>
              {canReceive && items.length === 0 && !search && <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Receive First Item</Button>}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {canAssign && <TableHead className="w-8" />}
                  <TableHead>Category</TableHead>
                  <TableHead>Product &amp; model</TableHead>
                  <TableHead>Serial / IMEI</TableHead>
                  {isAllBranch && <TableHead>Branch</TableHead>}
                  <TableHead>Status</TableHead>
                  {!isAgent && <TableHead>Agent</TableHead>}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((i) => (
                  <TableRow key={i.id}>
                    {canAssign && (
                      <TableCell>
                        {i.status === 'AVAILABLE' && (
                          <input type="checkbox" aria-label={`Select ${i.serialNumber}`} checked={selected.has(i.id)}
                            onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(i.id); else next.delete(i.id); setSelected(next); }} />
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-gray-600">{i.product.category?.name ?? '—'}</TableCell>
                    <TableCell>
                      <div className="font-medium text-gray-900">{unitTitle(i.product.name, i.name)}</div>
                      {i.description && <div className="text-xs text-gray-500 mt-0.5 whitespace-pre-line">{i.description}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{i.serialNumber}</TableCell>
                    {isAllBranch && <TableCell className="text-gray-600">{i.branch?.name ?? '—'}</TableCell>}
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(i.status)}`}>{i.status}</span></TableCell>
                    {!isAgent && <TableCell className="text-gray-600">{i.assignedAgent ? `${i.assignedAgent.firstName} ${i.assignedAgent.lastName}` : <span className="text-gray-400">In the shop</span>}</TableCell>}
                    <TableCell className="whitespace-nowrap space-x-3">
                      <button className="text-xs text-blue-700 hover:underline" onClick={() => openHistory(i)}>History</button>
                      {canEdit && <button className="text-xs text-blue-700 hover:underline" onClick={() => { setEditItem(i); setEditForm({ name: i.name ?? '', description: i.description ?? '' }); }}>Edit</button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Assign {selected.size} unit{selected.size === 1 ? '' : 's'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>To</Label>
              <Select value={assignTo} onValueChange={setAssignTo}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Choose an agent..." /></SelectTrigger>
                <SelectContent>
                  {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.firstName} {a.lastName}{isAllBranch && a.branch ? ` (${a.branch.name})` : ''}</SelectItem>)}
                  <SelectItem value="none">Take back to the shop</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-400 mt-1">Only that agent can then sell these units. Units on a customer&apos;s contract can&apos;t be moved.</p>
            </div>
            <div>
              <Label htmlFor="assign-reason">Reason (optional)</Label>
              <Input id="assign-reason" className="mt-1.5" placeholder="e.g. Stock for the Kasoa market" value={assignReason} onChange={(e) => setAssignReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button onClick={onAssign} disabled={saving || !assignTo}>{saving ? 'Saving...' : 'Assign'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyItem} onOpenChange={(open) => { if (!open) setHistoryItem(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{historyItem && `Who held ${historyItem.serialNumber}`}</DialogTitle></DialogHeader>
          {!history ? <p className="text-sm text-gray-500">Loading...</p> : history.length === 0 ? (
            <p className="text-sm text-gray-500">It has never been assigned to an agent.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.map((h) => (
                <li key={h.id} className="border-b last:border-0 pb-2">
                  <span className="font-medium text-gray-900">{h.fromAgentName ?? 'The shop'} → {h.toAgentName ?? 'the shop'}</span>
                  <span className="block text-xs text-gray-500">{new Date(h.createdAt).toLocaleString('en-GB')} · by {h.assignedByName ?? 'unknown'}{h.reason ? ` · ${h.reason}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editItem} onOpenChange={(open) => { if (!open) setEditItem(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editItem && `${editItem.product.name} · ${editItem.serialNumber}`}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-name">Model</Label>
              <Input id="edit-name" className="mt-1.5" placeholder="e.g. HP Envy" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="edit-spec">Description / specification</Label>
              <Textarea id="edit-spec" rows={3} className="mt-1.5" placeholder={'e.g. 15" screen, 200 GB HDD, 6 GB RAM'} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>Cancel</Button>
            <Button onClick={onSaveEdit} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
