'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, FileText as FileTextIcon, ChevronRight, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, getStatusColor } from '@/lib/utils';
import { PRICE_CHART_TERM_MONTHS, PAYMENT_FREQUENCIES, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, DIRECT_DEBIT_NETWORKS, numberOfInstalmentsForTerm, type PaymentFrequencyName } from '@/lib/constants/contracts';
import { generateStraightLineSchedule, generateLoanSchedule, derivePrincipalFromTotalPayable, type GeneratedInstalment } from '@/lib/services/scheduleService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

interface Customer {
  id: string; firstName: string; lastName: string; phone: string | null; phone2?: string | null; phone3?: string | null;
  email?: string | null; membershipId: string; branchId: string; photoUrl?: string | null;
}
const customerPhone = (c: Customer) => c.phone ?? c.phone2 ?? c.phone3 ?? '—';
interface InventoryItem {
  id: string; serialNumber: string; productId: string;
  product: { id: string; name: string; cashPriceMinor: number; category?: { name: string } | null };
}
interface Product {
  id: string; name: string; sku: string; cashPriceMinor: number;
  category?: { name: string } | null; missingContractTypes: string[];
}
interface PriceChartEntry {
  id: string; termMonths: number; paymentFrequency: string; contractType: string;
  totalPayableMinor: number; depositAmountMinor: number; instalmentAmountMinor: number; interestRateBps: number | null;
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
  // A negotiated deal that differs from the standard price chart tier —
  // reserved for the two most-trusted roles; the API independently re-checks
  // this server-side (contracts/route.ts) and ignores these fields for
  // anyone else, so this client-side gate is only about what the form shows.
  const canOverridePricing = useAuthStore((s) => s.user?.role === 'SUPER_ADMIN' || s.user?.role === 'ADMIN');
  const { toast } = useToast();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // Three-step wizard — Select Customer, Select Type & Product, Configure Payment Terms —
  // modeled on the main hire-purchase app's contract creation flow, adapted to HP-Lite's
  // simplified, price-chart-driven pricing (no free-typed totals/deposit) and contract types.
  // Contract type moves the branching in step 2 (an inventory unit for SAVE_TO_OWN/
  // DEPOSIT_INSTALMENT vs. a Product only for DEVICE_LOAN, which disburses cash rather
  // than reserving a unit — docs/01-plan.md §20), so it has to be picked before it, not
  // inside step 3 as originally built.
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [chartEntries, setChartEntries] = useState<PriceChartEntry[]>([]);

  const [customerSearch, setCustomerSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [inventoryItemId, setInventoryItemId] = useState('');
  // DEVICE_LOAN disburses cash for the customer to buy a device outside the store — it's
  // priced against a Product directly, never a specific serialized stock unit (docs/01-plan.md §20).
  const [loanProductId, setLoanProductId] = useState('');
  const [contractType, setContractType] = useState('DEPOSIT_INSTALMENT');
  const [paymentFrequency, setPaymentFrequency] = useState<PaymentFrequencyName>('MONTHLY');
  const [selectedTermMonths, setSelectedTermMonths] = useState<number | null>(null);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [gracePeriodDays, setGracePeriodDays] = useState('7');
  const [penaltyPercent, setPenaltyPercent] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<'CUSTOMER_INITIATED' | 'DIRECT_DEBIT' | 'BOTH'>('CUSTOMER_INITIATED');
  const [directDebitNetwork, setDirectDebitNetwork] = useState('');
  const [directDebitMsisdn, setDirectDebitMsisdn] = useState('');
  const [showSchedulePreview, setShowSchedulePreview] = useState(false);
  // Free-text override of the price chart's own figures, SUPER_ADMIN/ADMIN
  // only — '' means "use the price chart tier as selected", not "zero".
  const [totalPriceOverride, setTotalPriceOverride] = useState('');
  const [depositOverride, setDepositOverride] = useState('');

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const selectedItem = items.find((i) => i.id === inventoryItemId) ?? null;
  const isDeviceLoan = contractType === 'DEVICE_LOAN';
  const selectedLoanProduct = products.find((p) => p.id === loanProductId) ?? null;
  const effectiveProductId = isDeviceLoan ? loanProductId : selectedItem?.productId;
  const entriesForFrequency = chartEntries.filter((e) => e.paymentFrequency === paymentFrequency);
  const selectedEntry = entriesForFrequency.find((e) => e.termMonths === selectedTermMonths) ?? null;
  const directDebitEligible = (DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES as string[]).includes(contractType);
  const totalInstalments = selectedTermMonths ? numberOfInstalmentsForTerm(selectedTermMonths, paymentFrequency) : null;

  // Everything below reads from these two, never selectedEntry directly, so a
  // manual override (SUPER_ADMIN/ADMIN) cascades into the finance amount, the
  // schedule preview, and the summary with no separate branch per figure —
  // mirrors exactly how contractService.ts's runContractTransaction does the
  // same substitution server-side.
  const parsedTotalOverride = parseFloat(totalPriceOverride);
  const parsedDepositOverride = parseFloat(depositOverride);
  const effectiveTotalPayableMinor = totalPriceOverride !== '' && !Number.isNaN(parsedTotalOverride)
    ? Math.round(parsedTotalOverride * 100)
    : (selectedEntry?.totalPayableMinor ?? 0);
  const effectiveDepositAmountMinor = depositOverride !== '' && !Number.isNaN(parsedDepositOverride)
    ? Math.round(parsedDepositOverride * 100)
    : (selectedEntry?.depositAmountMinor ?? 0);
  const financeAmountMinor = selectedEntry ? effectiveTotalPayableMinor - effectiveDepositAmountMinor : 0;
  // Same formula contractService.ts's runContractTransaction recomputes
  // server-side whenever a price is overridden — kept in lockstep here so the
  // summary previews exactly what will actually be stored, not the price
  // chart tier's now-possibly-stale figure.
  const effectiveInstalmentAmountMinor = selectedEntry && totalInstalments ? Math.ceil(financeAmountMinor / totalInstalments) : 0;

  // A newly-selected term/product means a different price chart tier — clear
  // any override from the previous one rather than silently carrying a
  // negotiated price over onto an unrelated tier.
  useEffect(() => {
    setTotalPriceOverride('');
    setDepositOverride('');
  }, [selectedEntry?.id]);

  const step1Valid = !!customerId;
  const step2Valid = isDeviceLoan ? !!loanProductId : !!inventoryItemId;
  const step3Valid = !!selectedEntry && !saving &&
    (paymentMethod === 'CUSTOMER_INITIATED' || (!!directDebitNetwork && !!directDebitMsisdn.trim()));

  function resetWizard() {
    setStep(1);
    setCustomerId(''); setInventoryItemId(''); setLoanProductId('');
    setContractType('DEPOSIT_INSTALMENT');
    setPaymentFrequency('MONTHLY'); setSelectedTermMonths(null);
    setStartDate(new Date().toISOString().slice(0, 10));
    setGracePeriodDays('7'); setPenaltyPercent('0');
    setPaymentMethod('CUSTOMER_INITIATED'); setDirectDebitNetwork(''); setDirectDebitMsisdn(''); setShowSchedulePreview(false);
    setCustomerSearch(''); setItemSearch(''); setTotalPriceOverride(''); setDepositOverride('');
  }

  function previewSchedule(): GeneratedInstalment[] {
    if (!selectedEntry || contractType === 'SAVE_TO_OWN') return [];
    const start = new Date(startDate);
    if (contractType === 'DEVICE_LOAN') {
      if (selectedEntry.interestRateBps == null) return [];
      const principal = derivePrincipalFromTotalPayable(effectiveTotalPayableMinor, selectedEntry.interestRateBps, selectedEntry.termMonths);
      return generateLoanSchedule(principal, selectedEntry.interestRateBps, selectedEntry.termMonths, start, paymentFrequency);
    }
    return generateStraightLineSchedule(financeAmountMinor, selectedEntry.termMonths, start, paymentFrequency);
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
    api.get<{ products: Product[] }>('/products')
      .then((r) => setProducts(r.products))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load products', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  useEffect(() => {
    // A different customer may belong to a different branch — the previously-picked
    // unit and everything derived from it is no longer necessarily valid.
    setInventoryItemId('');
    setSelectedTermMonths(null);
    if (!selectedCustomer) { setItems([]); return; }
    api.get<{ items: InventoryItem[] }>(`/inventory?status=AVAILABLE&branchId=${selectedCustomer.branchId}`).then((r) => setItems(r.items));
    if (!directDebitMsisdn) setDirectDebitMsisdn(customerPhone(selectedCustomer) === '—' ? '' : customerPhone(selectedCustomer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  useEffect(() => {
    // A different contract type may show a completely different step 2 (product-only
    // for DEVICE_LOAN vs. inventory-unit for the others) — whatever was picked before
    // isn't necessarily valid for the new type.
    setInventoryItemId(''); setLoanProductId('');
  }, [contractType]);

  useEffect(() => {
    setSelectedTermMonths(null);
    setPaymentFrequency('MONTHLY');
    if (!effectiveProductId || !contractType) { setChartEntries([]); return; }
    api.get<{ entries: PriceChartEntry[] }>(`/price-chart?productId=${effectiveProductId}&contractType=${contractType}&activeOnly=true`)
      .then((r) => setChartEntries(r.entries));
  }, [effectiveProductId, contractType]);

  useEffect(() => {
    // Whatever term was picked may not be priced at the newly-chosen frequency.
    setSelectedTermMonths(null);
  }, [paymentFrequency]);

  async function onSubmit() {
    if (!customerId) { toast({ title: 'Select a customer', variant: 'destructive' }); return; }
    if (isDeviceLoan ? !loanProductId : !inventoryItemId) {
      toast({ title: isDeviceLoan ? 'Select a product' : 'Select an available unit', variant: 'destructive' });
      return;
    }
    if (!selectedEntry) { toast({ title: 'Select an installment period', variant: 'destructive' }); return; }
    if (paymentMethod !== 'CUSTOMER_INITIATED' && (!directDebitNetwork || !directDebitMsisdn.trim())) {
      toast({ title: 'Select a network and enter a mobile money number', variant: 'destructive' });
      return;
    }
    const hasPriceOverride = canOverridePricing && totalPriceOverride !== '';
    const hasDepositOverride = canOverridePricing && contractType === 'DEPOSIT_INSTALMENT' && depositOverride !== '';
    if (hasDepositOverride && effectiveDepositAmountMinor >= effectiveTotalPayableMinor) {
      toast({ title: 'Deposit must be less than the total price', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/contracts', {
        contractType, customerId,
        ...(isDeviceLoan ? { productId: loanProductId } : { inventoryItemId }),
        termMonths: selectedEntry.termMonths, paymentFrequency: selectedEntry.paymentFrequency,
        startDate,
        ...(hasPriceOverride && { totalPayableMinorOverride: effectiveTotalPayableMinor }),
        ...(hasDepositOverride && { depositAmountMinorOverride: effectiveDepositAmountMinor }),
        ...(directDebitEligible && {
          gracePeriodDays: Number(gracePeriodDays || '0'), penaltyRateBps: Math.round(parseFloat(penaltyPercent || '0') * 100),
          paymentMethod,
        }),
        ...(directDebitEligible && paymentMethod !== 'CUSTOMER_INITIATED' && {
          directDebitNetwork, directDebitMsisdn: directDebitMsisdn.trim(),
        }),
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
      [c.phone, c.phone2, c.phone3].some((p) => p?.toLowerCase().includes(q)) ||
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

  const filteredProducts = products.filter((p) => {
    if (!itemSearch.trim()) return true;
    const q = itemSearch.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      (p.category?.name ?? '').toLowerCase().includes(q)
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
                <div key={s} className={`h-2 flex-1 ${s <= step ? 'bg-primary' : 'bg-gray-200'}`} />
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              Step {step} of 3 — {step === 1 ? 'Select Customer' : step === 2 ? 'Select Type & Product' : 'Configure Payment Terms'}
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
                        <p className="text-xs text-gray-500">{c.membershipId} &middot; {customerPhone(c)}</p>
                      </div>
                    </div>
                  ))}
                  {filteredCustomers.length === 0 && (
                    <p className="text-center text-sm text-gray-400 py-8">No customers found</p>
                  )}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => { setShowForm(false); resetWizard(); }} className="flex-1">Cancel</Button>
                  <Button onClick={() => setStep(2)} disabled={!step1Valid} className="flex-1">Next: Select Type & Product</Button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <Label>Contract type</Label>
                  <Select value={contractType} onValueChange={setContractType}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CONTRACT_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {isDeviceLoan && (
                    <p className="text-xs text-gray-400 mt-1">Cash is disbursed to the customer to buy a device outside the store — no unit is reserved from stock.</p>
                  )}
                </div>

                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder={isDeviceLoan ? 'Search by product name or category...' : 'Search by product name, category, or serial/IMEI...'}
                    className="flex h-10 w-full border border-input bg-white/90 pl-9 pr-3 py-2 text-sm"
                    value={itemSearch}
                    onChange={(e) => setItemSearch(e.target.value)}
                  />
                </div>

                {isDeviceLoan ? (
                  <div className="max-h-96 overflow-y-auto space-y-2">
                    {filteredProducts.map((p) => {
                      const priced = !p.missingContractTypes.includes('DEVICE_LOAN');
                      return (
                        <div
                          key={p.id}
                          className={`p-3 border transition-colors flex justify-between items-start gap-3 ${
                            !priced ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                            : loanProductId === p.id ? 'border-blue-500 bg-blue-50 cursor-pointer' : 'border-gray-200 hover:border-blue-300 cursor-pointer'
                          }`}
                          onClick={() => priced && setLoanProductId(p.id)}
                        >
                          <div className="min-w-0">
                            <p className={`font-medium ${priced ? 'text-gray-900' : 'text-gray-300'}`}>{p.name}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">{p.sku}</span>
                              {p.category?.name && <span className="ml-2">{p.category.name}</span>}
                              {!priced && <span className="ml-2 text-red-500">Not priced for Device Loan</span>}
                            </p>
                          </div>
                          <p className="font-semibold text-gray-900 shrink-0">{formatCurrency(p.cashPriceMinor)}</p>
                        </div>
                      );
                    })}
                    {filteredProducts.length === 0 && (
                      <p className="text-center text-sm text-gray-400 py-8">No products found</p>
                    )}
                  </div>
                ) : (
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
                )}

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
                  <p className="text-xs font-medium text-green-900">{isDeviceLoan ? 'Product' : 'Product & Unit'}</p>
                  <p className="text-sm text-green-900">
                    {isDeviceLoan
                      ? `${selectedLoanProduct?.name} · ${contractTypeLabel('DEVICE_LOAN')}`
                      : <>{selectedItem?.product.name} &middot; <span className="font-mono">{selectedItem?.serialNumber}</span></>}
                  </p>
                </div>

                <div>
                  <Label>Installment Period *</Label>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {PRICE_CHART_TERM_MONTHS.map((term) => {
                      const entry = entriesForFrequency.find((e) => e.termMonths === term);
                      const active = selectedTermMonths === term;
                      return (
                        <button
                          type="button"
                          key={term}
                          disabled={!entry}
                          onClick={() => setSelectedTermMonths(term)}
                          className={`min-w-0 p-3 border text-left transition-colors ${
                            !entry ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                            : active ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'
                          }`}
                        >
                          <p className="text-xs font-medium text-gray-500">{term} Months</p>
                          <p className={`text-sm font-semibold mt-0.5 break-words ${entry ? 'text-gray-900' : 'text-gray-300'}`}>
                            {entry ? formatCurrency(entry.totalPayableMinor) : 'Not priced'}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  {chartEntries.length === 0 && (
                    <p className="text-xs text-red-600 mt-1.5">No price chart entries for this product/contract type — price it from the Products or Price Chart page first.</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Total Price (GHS)</Label>
                    <Input
                      disabled={!canOverridePricing}
                      type={canOverridePricing ? 'number' : 'text'}
                      step="0.01"
                      className={`mt-1.5 ${canOverridePricing ? '' : 'bg-gray-50'}`}
                      value={totalPriceOverride !== '' ? totalPriceOverride : (selectedEntry ? (selectedEntry.totalPayableMinor / 100).toFixed(2) : '0.00')}
                      onChange={(e) => setTotalPriceOverride(e.target.value)}
                    />
                    {canOverridePricing && (
                      <p className="text-xs text-gray-400 mt-1">Negotiated price — overrides the price chart tier for this contract only.</p>
                    )}
                  </div>
                  {contractType === 'DEPOSIT_INSTALMENT' && (
                    <div>
                      <Label>Deposit Amount (GHS)</Label>
                      <Input
                        disabled={!canOverridePricing}
                        type={canOverridePricing ? 'number' : 'text'}
                        step="0.01"
                        className={`mt-1.5 ${canOverridePricing ? '' : 'bg-gray-50'}`}
                        value={depositOverride !== '' ? depositOverride : (selectedEntry ? (selectedEntry.depositAmountMinor / 100).toFixed(2) : '0.00')}
                        onChange={(e) => setDepositOverride(e.target.value)}
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Payment Frequency *</Label>
                    <Select value={paymentFrequency} onValueChange={(v) => setPaymentFrequency(v as PaymentFrequencyName)}>
                      <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PAYMENT_FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{frequencyLabel(f)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Total Installments</Label>
                    <Input disabled className="mt-1.5 bg-gray-50" value={totalInstalments ? `${totalInstalments} (auto)` : 'Auto'} />
                  </div>
                </div>

                <div>
                  <Label>Start Date</Label>
                  <Input type="date" className="mt-1.5" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>

                {directDebitEligible && (
                  <>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label>Grace Period (days)</Label>
                        <Input type="number" min={0} className="mt-1.5" value={gracePeriodDays} onChange={(e) => setGracePeriodDays(e.target.value)} />
                      </div>
                      <div>
                        <Label>Penalty (%)</Label>
                        <Input type="number" min={0} step="0.1" className="mt-1.5" value={penaltyPercent} onChange={(e) => setPenaltyPercent(e.target.value)} />
                      </div>
                    </div>

                    <div>
                      <Label>Payment Method</Label>
                      <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as 'CUSTOMER_INITIATED' | 'DIRECT_DEBIT' | 'BOTH')}>
                        <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CUSTOMER_INITIATED">Customer pays themselves (cash / USSD)</SelectItem>
                          <SelectItem value="DIRECT_DEBIT">Direct debit — auto-charged every time due</SelectItem>
                          <SelectItem value="BOTH">Both — customer can pay; direct debit if they default</SelectItem>
                        </SelectContent>
                      </Select>
                      {paymentMethod === 'DIRECT_DEBIT' && (
                        <p className="text-xs text-gray-400 mt-1">A mobile money mandate is charged automatically the moment each instalment is due.</p>
                      )}
                      {paymentMethod === 'BOTH' && (
                        <p className="text-xs text-gray-400 mt-1">Customer can pay cash/USSD on the due date; direct debit only charges once an instalment goes overdue.</p>
                      )}
                    </div>

                    {paymentMethod !== 'CUSTOMER_INITIATED' && (
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>Mobile Money Network *</Label>
                          <Select value={directDebitNetwork} onValueChange={setDirectDebitNetwork}>
                            <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select Network" /></SelectTrigger>
                            <SelectContent>
                              {DIRECT_DEBIT_NETWORKS.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label>Mobile Money Number *</Label>
                          <Input required placeholder="e.g., 0241234567" className="mt-1.5" value={directDebitMsisdn} onChange={(e) => setDirectDebitMsisdn(e.target.value)} />
                          <p className="text-xs text-gray-400 mt-1">Customer&apos;s mobile money number for payments</p>
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div className="border border-gray-200 p-3 space-y-1.5 text-sm">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Summary</p>
                  <div className="flex justify-between"><span className="text-gray-500">Total Price</span><span className="font-medium text-gray-900">{selectedEntry ? formatCurrency(effectiveTotalPayableMinor) : formatCurrency(0)}</span></div>
                  {contractType === 'DEPOSIT_INSTALMENT' && (
                    <div className="flex justify-between"><span className="text-gray-500">Deposit</span><span className="font-medium text-gray-900">{selectedEntry ? formatCurrency(effectiveDepositAmountMinor) : formatCurrency(0)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-gray-500">Finance Amount</span><span className="font-medium text-gray-900">{formatCurrency(financeAmountMinor)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Installment Amount</span><span className="font-medium text-gray-900">{formatCurrency(effectiveInstalmentAmountMinor)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Payment Frequency</span><Badge variant="secondary">{paymentFrequency}</Badge></div>
                </div>

                {contractType !== 'SAVE_TO_OWN' && selectedEntry && (
                  <div>
                    <Button type="button" variant="outline" className="w-full" onClick={() => setShowSchedulePreview((v) => !v)}>
                      {showSchedulePreview ? 'Hide' : 'Preview'} Installment Schedule
                    </Button>
                    {showSchedulePreview && (
                      <div className="mt-2 max-h-64 overflow-y-auto border border-gray-200">
                        <Table>
                          <TableHeader>
                            <TableRow><TableHead>#</TableHead><TableHead>Due date</TableHead><TableHead>Amount</TableHead></TableRow>
                          </TableHeader>
                          <TableBody>
                            {previewSchedule().map((s) => (
                              <TableRow key={s.instalmentNo}>
                                <TableCell>{s.instalmentNo}</TableCell>
                                <TableCell>{s.dueDate.toLocaleDateString()}</TableCell>
                                <TableCell>{formatCurrency(s.amountDueMinor)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
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
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
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
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(c.status)}`}>{c.status}</span></TableCell>
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
