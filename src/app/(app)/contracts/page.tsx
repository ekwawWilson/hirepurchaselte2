'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, FileText as FileTextIcon, ChevronRight, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, getStatusColor } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

interface Customer {
  id: string; firstName: string; lastName: string; phone: string; email?: string | null;
  membershipId: string; branchId: string; photoUrl?: string | null;
}
interface InventoryItem {
  id: string; serialNumber: string; productId: string;
  product: { id: string; name: string; cashPriceMinor: number; category?: { name: string } | null };
}
interface PriceChartEntry {
  id: string; termMonths: number; paymentFrequency: string; contractType: string;
  totalPayableMinor: number; depositPercentage: number;
}
const frequencyLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase();
const initials = (first: string, last: string) => `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();

interface Contract {
  id: string; contractNumber: string; contractType: string; status: string;
  totalPayableMinor: number; balanceMinor: number;
  customer: { firstName: string; lastName: string }; product: { name: string };
}

const CONTRACT_TYPE_OPTIONS = [
  { value: 'SAVE_TO_OWN', label: 'Save to Own' },
  { value: 'DEPOSIT_INSTALMENT', label: 'Deposit + Instalment' },
  { value: 'DEVICE_LOAN', label: 'Device Loan' },
];

export default function ContractsPage() {
  const canCreate = useAuthStore((s) => s.hasPermission('contract.create'));
  const { toast } = useToast();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // Three-step wizard — Select Customer, Select Product & Unit, Configure Payment Terms —
  // modeled on the main hire-purchase app's contract creation flow, adapted to HP-Lite's
  // simplified, price-chart-driven pricing (no free-typed totals/deposit) and contract types.
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [chartEntries, setChartEntries] = useState<PriceChartEntry[]>([]);

  const [customerSearch, setCustomerSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [inventoryItemId, setInventoryItemId] = useState('');
  const [contractType, setContractType] = useState('DEPOSIT_INSTALMENT');
  const [selectedEntryId, setSelectedEntryId] = useState('');

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const selectedItem = items.find((i) => i.id === inventoryItemId) ?? null;
  const selectedEntry = chartEntries.find((c) => c.id === selectedEntryId) ?? null;

  const step1Valid = !!customerId;
  const step2Valid = !!inventoryItemId;
  const step3Valid = !!selectedEntryId && !saving;

  function resetWizard() {
    setStep(1);
    setCustomerId(''); setInventoryItemId(''); setSelectedEntryId('');
    setContractType('DEPOSIT_INSTALMENT');
    setCustomerSearch(''); setItemSearch('');
  }

  async function loadContracts() {
    setIsLoading(true);
    try {
      const { contracts } = await api.get<{ contracts: Contract[] }>('/contracts');
      setContracts(contracts);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load contracts', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadContracts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showForm) return;
    api.get<{ customers: Customer[] }>('/customers')
      .then((r) => setCustomers(r.customers))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load customers', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  useEffect(() => {
    // A different customer may belong to a different branch — the previously-picked
    // unit and everything derived from it is no longer necessarily valid.
    setInventoryItemId('');
    setSelectedEntryId('');
    if (!selectedCustomer) { setItems([]); return; }
    api.get<{ items: InventoryItem[] }>(`/inventory?status=AVAILABLE&branchId=${selectedCustomer.branchId}`).then((r) => setItems(r.items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  useEffect(() => {
    setSelectedEntryId('');
    if (!selectedItem || !contractType) { setChartEntries([]); return; }
    api.get<{ entries: PriceChartEntry[] }>(`/price-chart?productId=${selectedItem.productId}&contractType=${contractType}&activeOnly=true`)
      .then((r) => setChartEntries(r.entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryItemId, contractType]);

  async function onSubmit() {
    if (!customerId) { toast({ title: 'Select a customer', variant: 'destructive' }); return; }
    if (!inventoryItemId) { toast({ title: 'Select an available unit', variant: 'destructive' }); return; }
    if (!selectedEntry) { toast({ title: 'Select a term', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      await api.post('/contracts', {
        contractType, customerId, inventoryItemId, termMonths: selectedEntry.termMonths, paymentFrequency: selectedEntry.paymentFrequency,
        ...(selectedCustomer?.branchId && { branchId: selectedCustomer.branchId }),
      });
      toast({ title: 'Contract created' });
      setShowForm(false);
      resetWizard();
      await loadContracts();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create contract', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const filteredCustomers = customers.filter((c) => {
    if (!customerSearch.trim()) return true;
    const q = customerSearch.toLowerCase();
    return (
      `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      c.membershipId.toLowerCase().includes(q)
    );
  });

  const filteredItems = items.filter((i) => {
    if (!itemSearch.trim()) return true;
    const q = itemSearch.toLowerCase();
    return (
      i.product.name.toLowerCase().includes(q) ||
      i.serialNumber.toLowerCase().includes(q) ||
      (i.product.category?.name ?? '').toLowerCase().includes(q)
    );
  });

  if (showForm) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Create Contract</CardTitle>
            <div className="flex gap-2 mt-3">
              {[1, 2, 3].map((s) => (
                <div key={s} className={`h-2 flex-1 ${s <= step ? 'bg-blue-600' : 'bg-gray-200'}`} />
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              Step {step} of 3 — {step === 1 ? 'Select Customer' : step === 2 ? 'Select Product & Unit' : 'Configure Payment Terms'}
            </p>
          </CardHeader>
          <CardContent>
            {step === 1 && (
              <div className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search by name, phone, or membership ID..."
                    className="flex h-10 w-full border border-input bg-white/90 pl-9 pr-3 py-2 text-sm"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-96 overflow-y-auto space-y-2">
                  {filteredCustomers.map((c) => (
                    <div
                      key={c.id}
                      className={`p-3 border cursor-pointer transition-colors flex gap-3 items-center ${customerId === c.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}
                      onClick={() => setCustomerId(c.id)}
                    >
                      {c.photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.photoUrl} alt="" className="w-11 h-11 rounded-lg object-cover border border-gray-200 shrink-0" />
                      ) : (
                        <div className="w-11 h-11 rounded-lg border border-gray-200 bg-gray-100 flex items-center justify-center text-gray-500 text-sm font-semibold shrink-0">
                          {initials(c.firstName, c.lastName)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">{c.firstName} {c.lastName}</p>
                        <p className="text-xs text-gray-500">{c.membershipId} &middot; {c.phone}</p>
                      </div>
                    </div>
                  ))}
                  {filteredCustomers.length === 0 && (
                    <p className="text-center text-sm text-gray-400 py-8">No customers found</p>
                  )}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => { setShowForm(false); resetWizard(); }} className="flex-1">Cancel</Button>
                  <Button onClick={() => setStep(2)} disabled={!step1Valid} className="flex-1">Next: Select Product</Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search by product name, category, or serial/IMEI..."
                    className="flex h-10 w-full border border-input bg-white/90 pl-9 pr-3 py-2 text-sm"
                    value={itemSearch}
                    onChange={(e) => setItemSearch(e.target.value)}
                  />
                </div>
                <div className="max-h-96 overflow-y-auto space-y-2">
                  {filteredItems.map((i) => (
                    <div
                      key={i.id}
                      className={`p-3 border cursor-pointer transition-colors ${inventoryItemId === i.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'}`}
                      onClick={() => setInventoryItemId(i.id)}
                    >
                      <div className="flex justify-between items-start gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900">{i.product.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">{i.serialNumber}</span>
                            {i.product.category?.name && <span className="ml-2">{i.product.category.name}</span>}
                          </p>
                        </div>
                        <p className="font-semibold text-gray-900 shrink-0">{formatCurrency(i.product.cashPriceMinor)}</p>
                      </div>
                    </div>
                  ))}
                  {filteredItems.length === 0 && (
                    <p className="text-center text-sm text-gray-400 py-8">No available units found for this customer&apos;s branch</p>
                  )}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1">Back</Button>
                  <Button onClick={() => setStep(3)} disabled={!step2Valid} className="flex-1">Next: Payment Terms</Button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="bg-blue-50 p-3">
                  <p className="text-xs font-medium text-blue-900">Customer</p>
                  <p className="text-sm text-blue-900">{selectedCustomer?.firstName} {selectedCustomer?.lastName} &middot; {selectedCustomer?.membershipId}</p>
                </div>
                <div className="bg-green-50 p-3">
                  <p className="text-xs font-medium text-green-900">Product</p>
                  <p className="text-sm text-green-900">{selectedItem?.product.name} &middot; <span className="font-mono">{selectedItem?.serialNumber}</span></p>
                </div>

                <div>
                  <Label>Contract type</Label>
                  <Select value={contractType} onValueChange={setContractType}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONTRACT_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label>Term & payment frequency (from price chart)</Label>
                  <Select value={selectedEntryId} onValueChange={setSelectedEntryId}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder={chartEntries.length ? 'Select a term...' : 'No price chart entry for this product/type'} /></SelectTrigger>
                    <SelectContent>
                      {chartEntries.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.termMonths}mo · {frequencyLabel(c.paymentFrequency)} — {formatCurrency(c.totalPayableMinor)}{c.contractType === 'DEPOSIT_INSTALMENT' ? ` (${c.depositPercentage}% deposit)` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedEntry && (
                  <div className="border border-gray-200 p-3 space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-gray-500">Total payable</span><span className="font-medium text-gray-900">{formatCurrency(selectedEntry.totalPayableMinor)}</span></div>
                    {selectedEntry.contractType === 'DEPOSIT_INSTALMENT' && (
                      <div className="flex justify-between"><span className="text-gray-500">Deposit required</span><span className="font-medium text-gray-900">{selectedEntry.depositPercentage}% ({formatCurrency(Math.round(selectedEntry.totalPayableMinor * selectedEntry.depositPercentage / 100))})</span></div>
                    )}
                    <div className="flex justify-between"><span className="text-gray-500">Payment frequency</span><Badge variant="secondary">{frequencyLabel(selectedEntry.paymentFrequency)}</Badge></div>
                    <div className="flex justify-between"><span className="text-gray-500">Term</span><span className="font-medium text-gray-900">{selectedEntry.termMonths} months</span></div>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => setStep(2)} className="flex-1">Back</Button>
                  <Button onClick={onSubmit} disabled={!step3Valid} className="flex-1">{saving ? 'Creating...' : 'Create contract'}</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Contracts</h1>
          <p className="text-sm text-gray-500 mt-0.5">Save-to-own, deposit + instalment, and device loan contracts</p>
        </div>
        {canCreate && (
          <Button onClick={() => { resetWizard(); setShowForm(true); }} size="sm" className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">New Contract</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
          ) : contracts.length === 0 ? (
            <div className="text-center py-12 px-4">
              <FileTextIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">No contracts yet</p>
              {canCreate && <Button onClick={() => { resetWizard(); setShowForm(true); }}><Plus className="mr-2 h-4 w-4" />Create First Contract</Button>}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contract #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/contracts/${c.id}`} className="font-mono text-xs text-blue-700 hover:underline">{c.contractNumber}</Link>
                    </TableCell>
                    <TableCell>{c.customer.firstName} {c.customer.lastName}</TableCell>
                    <TableCell>{c.product.name}</TableCell>
                    <TableCell>{contractTypeLabel(c.contractType)}</TableCell>
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 ${getStatusColor(c.status)}`}>{c.status}</span></TableCell>
                    <TableCell>{formatCurrency(c.balanceMinor)} / {formatCurrency(c.totalPayableMinor)}</TableCell>
                    <TableCell>
                      <Link href={`/contracts/${c.id}`}><ChevronRight className="h-4 w-4 text-gray-300" /></Link>
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
