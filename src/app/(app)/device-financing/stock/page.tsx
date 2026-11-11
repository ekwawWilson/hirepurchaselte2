'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Plus, Smartphone } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AccessDenied } from '@/components/AccessDenied';

interface Unit {
  id: string; serialNumber: string; status: string; description: string | null; createdAt: string;
  product: { id: string; name: string };
  assignedAgent: { id: string; firstName: string; lastName: string } | null;
  device: { id: string; enrollmentStatus: string; committedState: string; lastError: string | null } | null;
  contract: { id: string; contractNumber: string; status: string; createdBy: { firstName: string; lastName: string } } | null;
}
interface PhoneModel { id: string; name: string; isActive: boolean }
interface Agent { id: string; firstName: string; lastName: string }
interface Branch { id: string; name: string; code: string }
interface Outcome { imei: string; ok: boolean; message: string; dryRun: boolean }

const STATUS_LABELS: Record<string, string> = { AVAILABLE: 'In stock', RESERVED: 'On a sale awaiting deposit', ISSUED: 'With the customer', RETURNED: 'Returned', WRITTEN_OFF: 'Written off' };
const ENROLMENT_LABELS: Record<string, string> = { QUEUED: 'Enrolled, not yet switched on', ACTIVE: 'Switched on', FAILED: 'Enrolment failed', CANCELLED: 'Enrolment cancelled', REMOVED: 'Lock removed' };
const EMPTY_ADD = { productId: '', imeis: '', agentId: '', description: '', branchId: '' };

/** Device Financing phones in stock, one per IMEI: received, given to agents, enrolled with PayTrigger, and sold. */
function PhoneStock() {
  const params = useSearchParams();
  const canView = useAuthStore((s) => s.hasPermission('inventory.view'));
  const canReceive = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const canAssign = useAuthStore((s) => s.hasPermission('inventory.transfer'));
  const canEnrol = useAuthStore((s) => s.hasPermission('paytrigger.manage'));
  const isAllBranch = useAuthStore((s) => !s.user?.branchId);
  const { toast } = useToast();
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ q: '', productId: params.get('productId') ?? '', status: '', enrolment: '' });
  const [models, setModels] = useState<PhoneModel[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState(EMPTY_ADD);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ received: number; outcomes: Outcome[] } | null>(null);

  const load = useCallback(() => {
    const q = new URLSearchParams({ page: String(page), ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
    api.get<{ items: Unit[]; total: number }>(`/device-financing/stock?${q}`).then((r) => { setUnits(r.items); setTotal(r.total); })
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load the stock', variant: 'destructive' }));
  }, [filters, page, toast]);
  useEffect(() => { if (canView) load(); }, [canView, load]);
  useEffect(() => {
    if (!canView) return;
    api.get<{ phones: PhoneModel[] }>('/device-financing/phones').then((r) => setModels(r.phones)).catch(() => undefined);
    if (canAssign) api.get<{ agents: Agent[] }>('/inventory/agents').then((r) => setAgents(r.agents)).catch(() => undefined);
    if (isAllBranch) api.get<{ branches: Branch[] }>('/branches').then((r) => setBranches(r.branches)).catch(() => undefined);
  }, [canView, canAssign, isAllBranch]);

  const typed = add.imeis.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const badTyped = typed.filter((s) => !/^\d{15}$/.test(s));

  async function receive() {
    setBusy(true);
    try {
      const r = await api.post<{ received: Array<{ id: string }>; enrolment: Outcome[] }>('/device-financing/stock', {
        productId: add.productId, imeis: add.imeis, agentId: add.agentId || undefined, description: add.description || undefined, branchId: add.branchId || undefined,
      });
      setResult({ received: r.received.length, outcomes: r.enrolment });
      setAdd(EMPTY_ADD);
      load();
    } catch (e) {
      toast({ title: 'Nothing was received', description: e instanceof ApiError ? e.message : 'Could not receive the phones', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }

  async function act(path: string, body: unknown, done: string) {
    try {
      await api.post(path, body);
      toast({ title: done });
      load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'That did not work', variant: 'destructive' });
    }
  }

  if (!canView) return <AccessDenied message="You don't have permission to view phone stock." hint="Ask an administrator for the inventory.view permission." />;

  const select = 'h-10 w-full rounded-md border border-input bg-white px-2 text-sm';
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Phone stock</h1>
          <p className="text-sm text-gray-500 mt-0.5">Device Financing phones by IMEI, each enrolled with PayTrigger as it comes in</p>
        </div>
        {canReceive && <Button size="sm" onClick={() => { setResult(null); setAdding(true); }}><Plus className="mr-1.5 h-4 w-4" />Receive phones</Button>}
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Input placeholder="Search IMEI or model" value={filters.q} onChange={(e) => { setPage(1); setFilters({ ...filters, q: e.target.value }); }} />
        <select className={select} value={filters.productId} onChange={(e) => { setPage(1); setFilters({ ...filters, productId: e.target.value }); }}>
          <option value="">All models</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select className={select} value={filters.status} onChange={(e) => { setPage(1); setFilters({ ...filters, status: e.target.value }); }}>
          <option value="">Any status</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={select} value={filters.enrolment} onChange={(e) => { setPage(1); setFilters({ ...filters, enrolment: e.target.value }); }}>
          <option value="">Enrolled or not</option>
          <option value="ENROLLED">Enrolled with PayTrigger</option>
          <option value="NOT_ENROLLED">Not enrolled</option>
        </select>
      </div>

      {units === null ? <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
        : units.length === 0 ? (
          <Card><CardContent className="py-12 text-center"><Smartphone className="h-8 w-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-500">No phones match.</p></CardContent></Card>
        ) : (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>IMEI</TableHead><TableHead>Model</TableHead><TableHead>Status</TableHead><TableHead>Agent</TableHead><TableHead>PayTrigger</TableHead><TableHead>Sale</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {units.map((u) => {
                    const enrolled = u.device && ['QUEUED', 'ACTIVE'].includes(u.device.enrollmentStatus);
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-mono text-xs">{u.serialNumber}<span className="block text-gray-400">{formatDate(u.createdAt)}</span></TableCell>
                        <TableCell>{u.product.name}{u.description && <span className="block text-xs text-gray-500">{u.description}</span>}</TableCell>
                        <TableCell className="text-xs">{STATUS_LABELS[u.status] ?? u.status}</TableCell>
                        <TableCell className="text-xs">
                          {canAssign && u.status === 'AVAILABLE' ? (
                            <select className="h-8 rounded border border-input bg-white px-1 text-xs" value={u.assignedAgent?.id ?? ''}
                              onChange={(e) => act('/inventory/assign', { inventoryItemIds: [u.id], agentId: e.target.value || null }, e.target.value ? 'Given to the agent' : 'Back in the shop')}>
                              <option value="">In the shop</option>
                              {agents.map((a) => <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>)}
                            </select>
                          ) : u.assignedAgent ? `${u.assignedAgent.firstName} ${u.assignedAgent.lastName}` : 'In the shop'}
                        </TableCell>
                        <TableCell className="text-xs">
                          {u.device ? <Link href={`/paytrigger/${u.device.id}`} className={enrolled ? 'text-primary hover:underline' : 'text-red-600 hover:underline'}>{ENROLMENT_LABELS[u.device.enrollmentStatus] ?? u.device.enrollmentStatus}</Link>
                            : <span className="text-red-600">Not enrolled</span>}
                          {!enrolled && canEnrol && u.status === 'AVAILABLE' && (
                            <button type="button" className="ml-2 text-primary underline" onClick={() => act('/paytrigger/enrolment', { inventoryItemIds: [u.id] }, 'Enrolment sent to PayTrigger')}>Enrol</button>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {u.contract ? <Link href={`/contracts/${u.contract.id}`} className="text-primary hover:underline">{u.contract.contractNumber}</Link> : '—'}
                          {u.contract && <span className="block text-gray-500">by {u.contract.createdBy.firstName} {u.contract.createdBy.lastName}</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>{total} phones</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Receive phones</DialogTitle></DialogHeader>
          {result ? (
            <div className="space-y-2 text-sm">
              <p className="font-medium text-gray-900">{result.received} phone{result.received === 1 ? '' : 's'} received.</p>
              <p className="text-gray-600">{result.outcomes.filter((o) => o.ok).length} enrolled with PayTrigger{result.outcomes.some((o) => o.dryRun) ? ' (simulated: PayTrigger is in dry run)' : ''}.</p>
              {result.outcomes.filter((o) => !o.ok).map((o) => <p key={o.imei} className="text-red-600 text-xs"><span className="font-mono">{o.imei}</span>: {o.message}</p>)}
              {result.outcomes.some((o) => !o.ok) && <p className="text-xs text-gray-500">Those are in stock but not enrolled: use Enrol on each once the problem is fixed.</p>}
              <DialogFooter><Button onClick={() => setResult(null)}>Receive more</Button></DialogFooter>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <Label>Model</Label>
                  <select className={`mt-1.5 ${select}`} value={add.productId} onChange={(e) => setAdd({ ...add, productId: e.target.value })}>
                    <option value="">Choose the phone model</option>
                    {models.filter((m) => m.isActive).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <Label>IMEIs</Label>
                  <Textarea rows={5} className="mt-1.5 font-mono" placeholder={'One per line, or scan them in\n350048672133084'} value={add.imeis} onChange={(e) => setAdd({ ...add, imeis: e.target.value })} />
                  <p className={`text-xs mt-1 ${badTyped.length ? 'text-red-600' : 'text-gray-500'}`}>
                    {badTyped.length ? `Not a 15-digit IMEI: ${badTyped.join(', ')}` : `${new Set(typed).size} IMEI${new Set(typed).size === 1 ? '' : 's'}. If any is already in stock, none are received.`}
                  </p>
                </div>
                <div><Label>Specification (optional)</Label><Input className="mt-1.5" placeholder="e.g. 64 GB storage, 3 GB RAM" value={add.description} onChange={(e) => setAdd({ ...add, description: e.target.value })} /></div>
                {canAssign && (
                  <div>
                    <Label>Give to an agent (optional)</Label>
                    <select className={`mt-1.5 ${select}`} value={add.agentId} onChange={(e) => setAdd({ ...add, agentId: e.target.value })}>
                      <option value="">Keep in the shop</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>)}
                    </select>
                  </div>
                )}
                {isAllBranch && (
                  <div>
                    <Label>Branch</Label>
                    <select className={`mt-1.5 ${select}`} value={add.branchId} onChange={(e) => setAdd({ ...add, branchId: e.target.value })}>
                      <option value="">Choose the branch</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button disabled={busy || !add.productId || typed.length === 0 || badTyped.length > 0 || (isAllBranch && !add.branchId)} onClick={receive}>
                  {busy ? 'Receiving...' : 'Receive and enrol'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function PhoneStockPage() {
  return <Suspense><PhoneStock /></Suspense>;
}
