'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, FileText as FileTextIcon, ChevronRight, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, getStatusColor } from '@/lib/utils';
import {
  DEPOSIT_INSTALMENT_FREQUENCIES, DEPOSIT_INSTALMENT_MIN_TERM_WEEKS, DEPOSIT_INSTALMENT_MAX_TERM_WEEKS,
  DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, DIRECT_DEBIT_NETWORKS, type PaymentFrequencyName,
} from '@/lib/constants/contracts';
import { generateStraightLineSchedule, type GeneratedInstalment } from '@/lib/services/scheduleService';
import { DEFAULT_WORKING_DAYS, type WorkingDays } from '@/lib/workingDays';
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
const frequencyLabel = (f: string) => f.charAt(0) + f.slice(1).toLowerCase();
const initials = (first: string, last: string) => `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();

interface Contract {
  id: string; contractNumber: string; contractType: string; status: string;
  // Null for SAVE_TO_OWN/DEVICE_LOAN — neither has a fixed target/product (contractService.ts).
  totalPayableMinor: number | null; balanceMinor: number | null; totalPaidMinor: number;
  customer: { firstName: string; lastName: string }; product: { name: string } | null;
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

  // Three-step wizard — Select Customer, Select Type & Unit, Configure Payment Terms.
  // Only DEPOSIT_INSTALMENT reserves an inventory unit in step 2; SAVE_TO_OWN and
  // DEVICE_LOAN are both open-ended/not linked to a product at all (contractService.ts),
  // so step 2 is skipped straight to a confirmation for those two types.
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  // Fetched so the preview shows the same due dates the server will actually
  // write (contractService.ts reads the same setting at creation).
  const [workingDays, setWorkingDays] = useState<WorkingDays>(DEFAULT_WORKING_DAYS);
  // Save to Own and Device Loan are only offered once activated in Settings
  // (the server refuses them otherwise) — hidden until the settings load.
  const [enabledTypes, setEnabledTypes] = useState({ saveToOwnEnabled: false, deviceLoanEnabled: false });
  const [typesLoaded, setTypesLoaded] = useState(false);
  const contractTypeOptions = CONTRACT_TYPE_OPTIONS.filter((o) =>
    o.value === 'SAVE_TO_OWN' ? enabledTypes.saveToOwnEnabled
      : o.value === 'DEVICE_LOAN' ? enabledTypes.deviceLoanEnabled
        : true);

  const [customerSearch, setCustomerSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [inventoryItemId, setInventoryItemId] = useState('');
  const [contractType, setContractType] = useState('DEPOSIT_INSTALMENT');
  const [paymentFrequency, setPaymentFrequency] = useState<PaymentFrequencyName>('WEEKLY');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [gracePeriodDays, setGracePeriodDays] = useState('7');
  const [penaltyPercent, setPenaltyPercent] = useState('0');
  const [paymentMethod, setPaymentMethod] = useState<'CUSTOMER_INITIATED' | 'DIRECT_DEBIT' | 'BOTH'>('CUSTOMER_INITIATED');
  const [directDebitNetwork, setDirectDebitNetwork] = useState('');
  const [directDebitMsisdn, setDirectDebitMsisdn] = useState('');
  const [showSchedulePreview, setShowSchedulePreview] = useState(false);

  // DEPOSIT_INSTALMENT: total price, deposit, and term are entered directly now —
  // no price chart lookup at all (contractService.ts).
  const [totalPrice, setTotalPrice] = useState('');
  const [depositAmount, setDepositAmount] = useState('');
  const [termWeeks, setTermWeeks] = useState('4');

  // DEVICE_LOAN: just the amount disbursed — the daily 1% rate and grace period
  // are global settings (Settings → Loan payment terms), snapshotted server-side.
  const [loanAmount, setLoanAmount] = useState('');

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;
  const selectedItem = items.find((i) => i.id === inventoryItemId) ?? null;
  const isSaveToOwn = contractType === 'SAVE_TO_OWN';
  const isDeviceLoan = contractType === 'DEVICE_LOAN';
  const isDepositInstalment = contractType === 'DEPOSIT_INSTALMENT';
  const directDebitEligible = (DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES as string[]).includes(contractType);

  const parsedTotalPrice = Math.round(parseFloat(totalPrice || '0') * 100);
  const parsedDeposit = Math.round(parseFloat(depositAmount || '0') * 100);
  const parsedTermWeeks = parseInt(termWeeks, 10);
  const parsedLoanAmount = Math.round(parseFloat(loanAmount || '0') * 100);
  const financeAmountMinor = isDepositInstalment && parsedTotalPrice > parsedDeposit ? parsedTotalPrice - parsedDeposit : 0;
  const instalmentCount = isDepositInstalment && Number.isInteger(parsedTermWeeks) && parsedTermWeeks > 0
    ? (paymentFrequency === 'DAILY' ? parsedTermWeeks * 7 : parsedTermWeeks)
    : 0;
  const instalmentAmountMinor = instalmentCount > 0 ? Math.ceil(financeAmountMinor / instalmentCount) : 0;

  // "Deposit + Instalment contracts", or "Save to Own and Deposit + Instalment
  // contracts" — only the types this company has activated.
  const enabledLabels = contractTypeOptions.map((o) => o.label);
  const enabledTypesSubtitle = `${enabledLabels.length > 1
    ? `${enabledLabels.slice(0, -1).join(', ')} and ${enabledLabels[enabledLabels.length - 1]}`
    : enabledLabels[0]} contracts`;

  const step1Valid = !!customerId;
  const step2Valid = isDepositInstalment ? !!inventoryItemId : true;
  const depositTermsValid = Number.isFinite(parsedTotalPrice) && parsedTotalPrice > 0
    && Number.isFinite(parsedDeposit) && parsedDeposit >= 0 && parsedDeposit < parsedTotalPrice
    && Number.isInteger(parsedTermWeeks) && parsedTermWeeks >= DEPOSIT_INSTALMENT_MIN_TERM_WEEKS && parsedTermWeeks <= DEPOSIT_INSTALMENT_MAX_TERM_WEEKS
    && (DEPOSIT_INSTALMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency);
  const loanTermsValid = Number.isFinite(parsedLoanAmount) && parsedLoanAmount > 0;
  const step3Valid = !saving && (
    isSaveToOwn ? true
    : isDeviceLoan ? loanTermsValid
    : depositTermsValid && (paymentMethod === 'CUSTOMER_INITIATED' || (!!directDebitNetwork && !!directDebitMsisdn.trim()))
  );

  function resetWizard() {
    setStep(1);
    setCustomerId(''); setInventoryItemId('');
    setContractType('DEPOSIT_INSTALMENT');
    setPaymentFrequency('WEEKLY');
    setStartDate(new Date().toISOString().slice(0, 10));
    setGracePeriodDays('7'); setPenaltyPercent('0');
    setPaymentMethod('CUSTOMER_INITIATED'); setDirectDebitNetwork(''); setDirectDebitMsisdn(''); setShowSchedulePreview(false);
    setCustomerSearch(''); setItemSearch('');
    setTotalPrice(''); setDepositAmount(''); setTermWeeks('4'); setLoanAmount('');
  }

  function previewSchedule(): GeneratedInstalment[] {
    if (!isDepositInstalment || !depositTermsValid) return [];
    return generateStraightLineSchedule(financeAmountMinor, 1, new Date(startDate), paymentFrequency, instalmentCount, workingDays);
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
    // Which types this company offers (Settings > Contract types) — drives both
    // the page's subtitle and the wizard's type picker.
    api.get<{ settings: { saveToOwnEnabled: boolean; deviceLoanEnabled: boolean } }>('/settings/contract-types')
      .then((r) => setEnabledTypes({ saveToOwnEnabled: r.settings.saveToOwnEnabled, deviceLoanEnabled: r.settings.deviceLoanEnabled }))
      .catch(() => undefined) // falls back to Deposit + Instalment only, which is always allowed
      .finally(() => setTypesLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!showForm) return;
    api.get<{ settings: { worksSaturday: boolean; worksSunday: boolean } }>('/settings/operating')
      .then((r) => setWorkingDays({ saturday: r.settings.worksSaturday, sunday: r.settings.worksSunday }))
      .catch(() => undefined); // preview falls back to Mon-Fri; not worth blocking the wizard over
    api.get<{ customers: Customer[] }>('/customers')
      .then((r) => setCustomers(r.customers))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load customers', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  useEffect(() => {
    // A different customer may belong to a different branch — the previously-picked
    // unit is no longer necessarily valid.
    setInventoryItemId('');
    if (!selectedCustomer) { setItems([]); return; }
    api.get<{ items: InventoryItem[] }>(`/inventory?status=AVAILABLE&branchId=${selectedCustomer.branchId}`).then((r) => setItems(r.items));
    if (!directDebitMsisdn) setDirectDebitMsisdn(customerPhone(selectedCustomer) === '—' ? '' : customerPhone(selectedCustomer));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  useEffect(() => {
    // A different contract type may show a completely different step 2 —
    // whatever unit was picked before isn't necessarily valid for the new type.
    setInventoryItemId('');
    setPaymentFrequency('WEEKLY');
    setPaymentMethod('CUSTOMER_INITIATED');
  }, [contractType]);

  async function onSubmit() {
    if (!customerId) { toast({ title: 'Select a customer', variant: 'destructive' }); return; }

    if (isSaveToOwn) {
      setSaving(true);
      try {
        const { contract } = await api.post<{ contract: { status: string } }>('/contracts', {
          contractType, customerId, startDate,
          ...(selectedCustomer?.branchId && { branchId: selectedCustomer.branchId }),
        });
        toast(contract.status === 'PENDING_APPROVAL'
          ? { title: 'Submitted for approval', description: 'A manager or admin needs to approve this before it goes live.' }
          : { title: 'Savings account created' });
        setShowForm(false);
        resetWizard();
        await loadContracts();
      } catch (e) {
        toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create contract', variant: 'destructive' });
      } finally {
        setSaving(false);
      }
      return;
    }

    if (isDeviceLoan) {
      if (!loanTermsValid) { toast({ title: 'Enter a positive loan amount', variant: 'destructive' }); return; }
      setSaving(true);
      try {
        const { contract } = await api.post<{ contract: { status: string } }>('/contracts', {
          contractType, customerId, startDate, loanAmountMinor: parsedLoanAmount,
          ...(selectedCustomer?.branchId && { branchId: selectedCustomer.branchId }),
        });
        toast(contract.status === 'PENDING_APPROVAL'
          ? { title: 'Submitted for approval', description: 'Nothing is disbursed until a manager or admin approves it.' }
          : { title: 'Loan disbursed' });
        setShowForm(false);
        resetWizard();
        await loadContracts();
      } catch (e) {
        toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create contract', variant: 'destructive' });
      } finally {
        setSaving(false);
      }
      return;
    }

    // DEPOSIT_INSTALMENT
    if (!inventoryItemId) { toast({ title: 'Select an available unit', variant: 'destructive' }); return; }
    if (!depositTermsValid) { toast({ title: 'Check total price, deposit, and installment period', variant: 'destructive' }); return; }
    if (paymentMethod !== 'CUSTOMER_INITIATED' && (!directDebitNetwork || !directDebitMsisdn.trim())) {
      toast({ title: 'Select a network and enter a mobile money number', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const { contract } = await api.post<{ contract: { status: string } }>('/contracts', {
        contractType, customerId, inventoryItemId,
        totalPayableMinor: parsedTotalPrice, depositAmountMinor: parsedDeposit,
        termWeeks: parsedTermWeeks, paymentFrequency,
        startDate,
        gracePeriodDays: Number(gracePeriodDays || '0'), penaltyRateBps: Math.round(parseFloat(penaltyPercent || '0') * 100),
        paymentMethod,
        ...(paymentMethod !== 'CUSTOMER_INITIATED' && { directDebitNetwork, directDebitMsisdn: directDebitMsisdn.trim() }),
        ...(selectedCustomer?.branchId && { branchId: selectedCustomer.branchId }),
      });
      toast(contract.status === 'PENDING_APPROVAL'
        ? { title: 'Submitted for approval', description: 'A manager or admin needs to approve this before it goes live.' }
        : { title: 'Contract created' });
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
              Step {step} of 3 — {step === 1 ? 'Select Customer' : step === 2 ? (isDepositInstalment ? 'Select Type & Unit' : 'Select Type') : 'Configure Payment Terms'}
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
                  <Button onClick={() => setStep(2)} disabled={!step1Valid} className="flex-1">Next: Select Type</Button>
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
                      {contractTypeOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {contractTypeOptions.length < CONTRACT_TYPE_OPTIONS.length && (
                    <p className="text-xs text-gray-400 mt-1">
                      {CONTRACT_TYPE_OPTIONS.filter((o) => !contractTypeOptions.includes(o)).map((o) => o.label).join(' and ')}
                      {' '}not activated — an admin can turn {contractTypeOptions.length === 1 ? 'them' : 'it'} on in Settings.
                    </p>
                  )}
                  {isDeviceLoan && (
                    <p className="text-xs text-gray-400 mt-1">Cash is disbursed to the customer — not linked to a product. The customer pays 1% daily interest on the loan amount, or the full amount, via USSD.</p>
                  )}
                  {isSaveToOwn && (
                    <p className="text-xs text-gray-400 mt-1">Open-ended savings — not linked to any product. The customer deposits any amount, any time, until they withdraw or the saved amount goes toward a purchase.</p>
                  )}
                  {isDepositInstalment && (
                    <p className="text-xs text-gray-400 mt-1">Reserves a serialized unit from stock — the total price, deposit, and installment period are entered on the next step.</p>
                  )}
                </div>

                {!isDepositInstalment ? (
                  <div className="bg-blue-50 p-3 text-sm text-blue-900">
                    {isDeviceLoan
                      ? 'No product or unit to select for a Device Loan — continue to enter the loan amount.'
                      : 'No product or unit to select for Save to Own — continue to review and create the account.'}
                  </div>
                ) : (
                <>
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
                </>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1">Back</Button>
                  <Button onClick={() => setStep(3)} disabled={!step2Valid} className="flex-1">Next: {isSaveToOwn || isDeviceLoan ? 'Review' : 'Payment Terms'}</Button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="bg-blue-50 p-3">
                  <p className="text-xs font-medium text-blue-900">Customer</p>
                  <p className="text-sm text-blue-900">{selectedCustomer?.firstName} {selectedCustomer?.lastName} &middot; {selectedCustomer?.membershipId}</p>
                </div>
                {isSaveToOwn && (
                  <>
                    <div className="bg-green-50 p-3">
                      <p className="text-xs font-medium text-green-900">Save to Own</p>
                      <p className="text-sm text-green-900">Open-ended savings — no product, no target amount, no term. The customer deposits any amount, any time.</p>
                    </div>
                    <div>
                      <Label>Start Date</Label>
                      <Input type="date" className="mt-1.5" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    </div>
                  </>
                )}

                {isDeviceLoan && (
                  <>
                    <div className="bg-green-50 p-3">
                      <p className="text-xs font-medium text-green-900">Device Loan</p>
                      <p className="text-sm text-green-900">Not linked to a product. 1% daily interest accrues on the loan amount (working days only, after the grace period) until fully paid.</p>
                    </div>
                    <div>
                      <Label>Loan Amount (GHS) *</Label>
                      <Input required type="number" step="0.01" min={0} className="mt-1.5" value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} />
                    </div>
                    <div>
                      <Label>Start Date</Label>
                      <Input type="date" className="mt-1.5" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                    </div>
                    <div className="border border-gray-200 p-3 space-y-1.5 text-sm">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Summary</p>
                      <div className="flex justify-between"><span className="text-gray-500">Loan Amount</span><span className="font-medium text-gray-900">{formatCurrency(parsedLoanAmount || 0)}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Daily Interest (1%)</span><span className="font-medium text-gray-900">{formatCurrency(Math.round((parsedLoanAmount || 0) * 0.01))} / working day</span></div>
                    </div>
                  </>
                )}

                {isDepositInstalment && (
                <>
                <div className="bg-green-50 p-3">
                  <p className="text-xs font-medium text-green-900">Product & Unit</p>
                  <p className="text-sm text-green-900">
                    {selectedItem?.product.name} &middot; <span className="font-mono">{selectedItem?.serialNumber}</span>
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Total Price (GHS) *</Label>
                    <Input required type="number" step="0.01" min={0} className="mt-1.5" value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} />
                  </div>
                  <div>
                    <Label>Deposit Amount (GHS) *</Label>
                    <Input required type="number" step="0.01" min={0} className="mt-1.5" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Installment Period (weeks) *</Label>
                    <Input
                      required type="number" step="1"
                      min={DEPOSIT_INSTALMENT_MIN_TERM_WEEKS} max={DEPOSIT_INSTALMENT_MAX_TERM_WEEKS}
                      className="mt-1.5" value={termWeeks} onChange={(e) => setTermWeeks(e.target.value)}
                    />
                    <p className="text-xs text-gray-400 mt-1">{DEPOSIT_INSTALMENT_MIN_TERM_WEEKS} to {DEPOSIT_INSTALMENT_MAX_TERM_WEEKS} weeks.</p>
                  </div>
                  <div>
                    <Label>Payment Frequency *</Label>
                    <Select value={paymentFrequency} onValueChange={(v) => setPaymentFrequency(v as PaymentFrequencyName)}>
                      <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {DEPOSIT_INSTALMENT_FREQUENCIES.map((f) => <SelectItem key={f} value={f}>{frequencyLabel(f)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-400 mt-1">
                      {paymentFrequency === 'DAILY' && Number.isInteger(parsedTermWeeks) && parsedTermWeeks > 0
                        ? `${parsedTermWeeks} weeks = ${parsedTermWeeks * 7} daily installments`
                        : Number.isInteger(parsedTermWeeks) && parsedTermWeeks > 0
                          ? `${parsedTermWeeks} weekly installments`
                          : ''}
                    </p>
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
                  <div className="flex justify-between"><span className="text-gray-500">Total Price</span><span className="font-medium text-gray-900">{formatCurrency(parsedTotalPrice || 0)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Deposit</span><span className="font-medium text-gray-900">{formatCurrency(parsedDeposit || 0)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Finance Amount</span><span className="font-medium text-gray-900">{formatCurrency(financeAmountMinor)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Installment Amount</span><span className="font-medium text-gray-900">{formatCurrency(instalmentAmountMinor)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Payment Frequency</span><Badge variant="secondary">{paymentFrequency}</Badge></div>
                  <div className="flex justify-between"><span className="text-gray-500">Installments</span><span className="font-medium text-gray-900">{instalmentCount || '—'}</span></div>
                </div>

                {depositTermsValid && (
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
                </>
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
          <p className="text-sm text-gray-500 mt-0.5">{typesLoaded ? enabledTypesSubtitle : 'Contract accounts'}</p>
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
                    <TableCell>{c.product?.name ?? '—'}</TableCell>
                    <TableCell>{contractTypeLabel(c.contractType)}</TableCell>
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(c.status)}`}>{c.status}</span></TableCell>
                    <TableCell>
                      {c.contractType === 'SAVE_TO_OWN'
                        ? `Saved: ${formatCurrency(c.totalPaidMinor)}`
                        : c.contractType === 'DEVICE_LOAN'
                          ? `Paid: ${formatCurrency(c.totalPaidMinor)}`
                          : `${formatCurrency(c.balanceMinor ?? 0)} / ${formatCurrency(c.totalPayableMinor ?? 0)}`}
                    </TableCell>
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
