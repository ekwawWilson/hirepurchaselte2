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
import { PhoneVerifyField } from '@/components/PhoneVerifyField';

interface Customer {
  id: string; membershipId: string; firstName: string; lastName: string;
  phone: string | null; phone2: string | null; phone3: string | null;
  email: string | null; address: string | null; nationalId: string | null;
  guarantorName: string | null; guarantorPhone: string | null; createdAt: string;
}
interface Contract {
  id: string; contractNumber: string; contractType: string; status: string;
  totalPayableMinor: number; balanceMinor: number; product: { name: string };
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canUpdate = useAuthStore((s) => s.hasPermission('customer.update'));
  const { toast } = useToast();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ phone: '', phone2: '', phone3: '', email: '', address: '', nationalId: '', guarantorName: '', guarantorPhone: '' });
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
        phone: customer.phone ?? '', phone2: customer.phone2 ?? '', phone3: customer.phone3 ?? '',
        email: customer.email ?? '', address: customer.address ?? '', nationalId: customer.nationalId ?? '',
        guarantorName: customer.guarantorName ?? '', guarantorPhone: customer.guarantorPhone ?? '',
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load customer', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.phone.trim() && !form.phone2.trim() && !form.phone3.trim()) {
      toast({ title: 'At least one phone number is required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/customers/${id}`, form);
      toast({ title: 'Customer updated' });
      setEditing(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update customer', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (!customer) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{customer.firstName} {customer.lastName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{customer.membershipId} &middot; {customer.phone ?? customer.phone2 ?? customer.phone3} &middot; Registered {formatDate(customer.createdAt)}</p>
        </div>
        {canUpdate && !editing && <Button variant="outline" onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          {editing ? (
            <form className="grid grid-cols-2 gap-4" onSubmit={onSave}>
              <div className="col-span-2">
                <p className="text-xs text-gray-500 mb-2">At least one phone number is required.</p>
                <div className="grid grid-cols-1 gap-3">
                  <PhoneVerifyField label="Phone 1" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
                  <PhoneVerifyField label="Phone 2 (optional)" value={form.phone2} onChange={(v) => setForm({ ...form, phone2: v })} />
                  <PhoneVerifyField label="Phone 3 (optional)" value={form.phone3} onChange={(v) => setForm({ ...form, phone3: v })} />
                </div>
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
                <Label>Address</Label>
                <Input className="mt-1.5" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
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
              <div><p className="text-xs text-gray-500">Phone 1</p><p className="text-gray-900">{customer.phone ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Phone 2</p><p className="text-gray-900">{customer.phone2 ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Phone 3</p><p className="text-gray-900">{customer.phone3 ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">Email</p><p className="text-gray-900">{customer.email ?? '—'}</p></div>
              <div><p className="text-xs text-gray-500">National ID</p><p className="text-gray-900">{customer.nationalId ?? '—'}</p></div>
              <div className="col-span-2"><p className="text-xs text-gray-500">Address</p><p className="text-gray-900">{customer.address ?? '—'}</p></div>
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
                    <TableCell>{c.product.name}</TableCell>
                    <TableCell>{contractTypeLabel(c.contractType)}</TableCell>
                    <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(c.status)}`}>{c.status}</span></TableCell>
                    <TableCell>{formatCurrency(c.balanceMinor)} / {formatCurrency(c.totalPayableMinor)}</TableCell>
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
