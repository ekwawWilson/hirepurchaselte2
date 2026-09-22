'use client';

import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate, contractTypeLabel, getStatusColor } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { UserRound } from 'lucide-react';
import { AccessDenied } from '@/components/AccessDenied';
import { PhoneVerifyField } from '@/components/PhoneVerifyField';
import { CustomerPhotoField } from '@/components/CustomerPhotoField';
import { Textarea } from '@/components/ui/textarea';

interface Customer {
  id: string; membershipId: string; firstName: string; lastName: string;
  phone: string | null; phone2: string | null; phone3: string | null;
  email: string | null; address: string | null; nationalId: string | null;
  occupation: string | null; workAddress: string | null; photoUrl: string | null;
  guarantorName: string | null; guarantorPhone: string | null; createdAt: string;
}
interface Contract {
  id: string; contractNumber: string; contractType: string; status: string;
  // Null for SAVE_TO_OWN — open-ended savings has no target/product (contractService.ts).
  totalPayableMinor: number | null; balanceMinor: number | null; totalPaidMinor: number; product: { name: string } | null;
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canView = useAuthStore((s) => s.hasPermission('customer.view'));
  const canUpdate = useAuthStore((s) => s.hasPermission('customer.update'));
  const { toast } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ phone: '', email: '', address: '', occupation: '', workAddress: '', photoUrl: '', nationalId: '', guarantorName: '', guarantorPhone: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const [{ customer }, { contracts }] = await Promise.all([
        api.get<{ customer: Customer }>(`/customers/${id}`),
        api.get<{ contracts: Contract[] }>(`/contracts?customerId=${id}`),
      ]);
      setCustomer(customer);
      setContracts(contracts);
      setForm({
        phone: customer.phone ?? '',
        email: customer.email ?? '', address: customer.address ?? '', nationalId: customer.nationalId ?? '',
        occupation: customer.occupation ?? '', workAddress: customer.workAddress ?? '', photoUrl: customer.photoUrl ?? '',
        guarantorName: customer.guarantorName ?? '', guarantorPhone: customer.guarantorPhone ?? '',
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load customer', variant: 'destructive' });
    }
  }

  useEffect(() => {
    if (!canView) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canView]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    // A customer registered before single-number registration may hold their
    // number only in phone2/phone3, which still count on the server.
    if (!form.phone.trim() && !customer?.phone2 && !customer?.phone3) {
      toast({ title: 'A phone number is required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Leave the stored photo alone unless it was changed or removed here.
      const { photoUrl, ...rest } = form;
      await api.patch(`/customers/${id}`, photoUrl === (customer?.photoUrl ?? '') ? rest : form);
      toast({ title: 'Customer updated' });
      setEditing(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update customer', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (!canView) {
    return (
      <div className="max-w-3xl space-y-6">
        <AccessDenied
          message="You don't have permission to view customers."
          hint="Ask an administrator for the customer.view permission."
        />
      </div>
    );
  }

  if (!customer) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-[70px] h-[90px] shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center">
            {customer.photoUrl
              // eslint-disable-next-line @next/next/no-img-element -- a data URL; next/image adds nothing here
              ? <img src={customer.photoUrl} alt={`${customer.firstName} ${customer.lastName}`} className="h-full w-full object-cover" />
              : <UserRound className="h-8 w-8 text-gray-300" />}
          </div>
          <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">{customer.firstName} {customer.lastName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{customer.membershipId} &middot; {customer.phone ?? customer.phone2 ?? customer.phone3} &middot; Registered {formatDate(customer.createdAt)}</p>
          </div>
        </div>
        {canUpdate && !editing && <Button variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          {editing ? (
            <form className="grid grid-cols-2 gap-4" onSubmit={onSave}>
              <div className="col-span-2">
                <CustomerPhotoField value={form.photoUrl} onChange={(v) => setForm({ ...form, photoUrl: v })} />
              </div>
              <div className="col-span-2">
                <PhoneVerifyField label="Phone number" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
              </div>
              <div>
                <Label>Email</Label>
                <Input type="email" className="mt-1.5" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div>
                <Label>National ID</Label>
                <Input className="mt-1.5" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Residential address</Label>
                <Textarea rows={2} className="mt-1.5" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Occupation</Label>
                <Input className="mt-1.5" value={form.occupation} onChange={(e) => setForm({ ...form, occupation: e.target.value })} />
              </div>
              <div className="col-span-2">
                <Label>Work address</Label>
                <Textarea rows={2} className="mt-1.5" value={form.workAddress} onChange={(e) => setForm({ ...form, workAddress: e.target.value })} />
              </div>
              <div>
                <Label>Guarantor name</Label>
                <Input className="mt-1.5" value={form.guarantorName} onChange={(e) => setForm({ ...form, guarantorName: e.target.value })} />
              </div>
              <div>
                <Label>Guarantor phone</Label>
                <Input className="mt-1.5" value={form.guarantorPhone} onChange={(e) => setForm({ ...form, guarantorPhone: e.target.value })} />
              </div>
              <div className="col-span-2 flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div><p className="text-xs text-gray-500">Phone number</p><p className="text-gray-900">{customer.phone ?? customer.phone2 ?? customer.phone3 ?? '—'}</p></div>
              {(customer.phone2 || customer.phone3) && customer.phone && (
                <div><p className="text-xs text-gray-500">Other numbers (from earlier registration)</p><p className="text-gray-900">{[customer.phone2, customer.phone3].filter(Boolean).join(', ')}</p></div>
              )}
              <div><p className="text-xs text-gray-500">Email</p><p className="text-gray-900">{customer.email ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">National ID</p><p className="text-gray-900">{customer.nationalId ?? '—'}</p></div>
              <div className="col-span-2"><p className="text-xs text-gray-500">Residential address</p><p className="text-gray-900 whitespace-pre-line">{customer.address ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Occupation</p><p className="text-gray-900">{customer.occupation ?? '—'}</p></div>
              <div className="col-span-2"><p className="text-xs text-gray-500">Work address</p><p className="text-gray-900 whitespace-pre-line">{customer.workAddress ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Guarantor</p><p className="text-gray-900">{customer.guarantorName ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Guarantor phone</p><p className="text-gray-900">{customer.guarantorPhone ?? '—'}</p></div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Contracts</CardTitle></CardHeader>
        <CardContent className="p-0">
          {contracts.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">No contracts yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contract #</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell><Link href={`/contracts/${c.id}`} className="font-mono text-xs text-blue-700 hover:underline">{c.contractNumber}</Link></TableCell>
                    <TableCell>{c.product?.name ?? '—'}</TableCell>
                    <TableCell>{contractTypeLabel(c.contractType)}</TableCell>
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(c.status)}`}>{c.status}</span></TableCell>
                    <TableCell>
                      {c.contractType === 'SAVE_TO_OWN'
                        ? `Saved: ${formatCurrency(c.totalPaidMinor)}`
                        : `${formatCurrency(c.balanceMinor ?? 0)} / ${formatCurrency(c.totalPayableMinor ?? 0)}`}
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
