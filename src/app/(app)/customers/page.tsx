'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, Users as UsersIcon } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { PhoneVerifyField } from '@/components/PhoneVerifyField';

interface Customer {
  id: string;
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  nationalId: string | null;
  createdAt: string;
}

interface Branch { id: string; name: string; code: string }

export default function CustomersPage() {
  const canCreate = useAuthStore((s) => s.hasPermission('customer.create'));
  const isAllBranch = useAuthStore((s) => s.user?.branchId === null);
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', phone2: '', phone3: '', nationalId: '', branchId: '' });
  const [branches, setBranches] = useState<Branch[]>([]);
  const [saving, setSaving] = useState(false);

  async function load(search?: string) {
    setIsLoading(true);
    try {
      const query = search ? `?q=${encodeURIComponent(search)}` : '';
      const { customers } = await api.get<{ customers: Customer[] }>(`/customers${query}`);
      setCustomers(customers);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load customers', variant: 'destructive' });
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

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.phone.trim() && !form.phone2.trim() && !form.phone3.trim()) {
      toast({ title: 'At least one phone number is required', variant: 'destructive' });
      return;
    }
    if (isAllBranch && !form.branchId) {
      toast({ title: 'Select a branch', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/customers', form);
      toast({ title: 'Customer registered', description: `${form.firstName} ${form.lastName} was added.` });
      setForm({ firstName: '', lastName: '', phone: '', phone2: '', phone3: '', nationalId: '', branchId: '' });
      setShowForm(false);
      await load(q);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create customer', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Register Customer</h1>
          <p className="text-sm text-gray-500 mt-0.5">Create account & membership ID</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Customer details</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="grid grid-cols-2 gap-4" onSubmit={onCreate}>
              <div>
                <Label>First name</Label>
                <Input required className="mt-1.5" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </div>
              <div>
                <Label>Last name</Label>
                <Input required className="mt-1.5" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </div>
              <div className="col-span-2">
                <p className="text-xs text-gray-500 mb-2">At least one phone number is required.</p>
                <div className="grid grid-cols-1 gap-3">
                  <PhoneVerifyField label="Phone 1" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
                  <PhoneVerifyField label="Phone 2 (optional)" value={form.phone2} onChange={(v) => setForm({ ...form, phone2: v })} />
                  <PhoneVerifyField label="Phone 3 (optional)" value={form.phone3} onChange={(v) => setForm({ ...form, phone3: v })} />
                </div>
              </div>
              <div>
                <Label>National ID (optional)</Label>
                <Input className="mt-1.5" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} />
              </div>
              {isAllBranch && (
                <div className="col-span-2">
                  <Label>Branch</Label>
                  <Select required value={form.branchId} onValueChange={(v) => setForm({ ...form, branchId: v })}>
                    <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select a branch..." /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name} ({b.code})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="col-span-2 flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create customer'}</Button>
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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Customers</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage customer accounts and memberships</p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowForm(true)} size="sm" className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            <span className="hidden sm:inline">Register Customer</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Search name, ID, phone..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load(q)}
                className="pl-10"
              />
            </div>
            <Button onClick={() => load(q)} size="sm" className="shrink-0">Search</Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : customers.length === 0 ? (
            <div className="text-center py-12 px-4">
              <UsersIcon className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">No customers found</p>
              {canCreate && (
                <Button onClick={() => setShowForm(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Register First Customer
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Membership ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>National ID</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/customers/${c.id}`} className="font-mono text-xs text-blue-700 hover:underline">{c.membershipId}</Link>
                    </TableCell>
                    <TableCell className="font-medium text-gray-900">
                      <Link href={`/customers/${c.id}`} className="hover:underline">{c.firstName} {c.lastName}</Link>
                    </TableCell>
                    <TableCell>{c.phone ?? c.phone2 ?? c.phone3 ?? '—'}</TableCell>
                    <TableCell>{c.nationalId ?? '—'}</TableCell>
                    <TableCell className="text-gray-500">{formatDate(c.createdAt)}</TableCell>
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
