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
import { Textarea } from '@/components/ui/textarea';
import { PhoneVerifyField } from '@/components/PhoneVerifyField';
import { CustomerPhotoField } from '@/components/CustomerPhotoField';

interface Customer {
  id: string;
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  nationalId: string | null;
  occupation: string | null;
  createdAt: string;
}

interface Branch { id: string; name: string; code: string; isActive: boolean }

const EMPTY_FORM = {
  firstName: '', lastName: '', phone: '', photoUrl: '',
  address: '', occupation: '', workAddress: '', nationalId: '',
};

export default function CustomersPage() {
  const canCreate = useAuthStore((s) => s.hasPermission('customer.create'));
  const userBranchId = useAuthStore((s) => s.user?.branchId ?? null);
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [branches, setBranches] = useState<Branch[] | null>(null);
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
    if (!showForm || branches) return;
    api.get<{ branches: Branch[] }>('/branches').then((r) => setBranches(r.branches)).catch(() => setBranches([]));
  }, [showForm, branches]);

  // The same rule the server applies (customerService.registrationBranch):
  // the user's own branch, or the business's only branch for a user who
  // covers them all.
  const activeBranches = branches?.filter((b) => b.isActive) ?? [];
  const registrationBranch = userBranchId
    ? branches?.find((b) => b.id === userBranchId) ?? null
    : activeBranches.length === 1 ? activeBranches[0] : null;

  function set<K extends keyof typeof EMPTY_FORM>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.photoUrl) {
      toast({ title: 'A customer photo is required', description: 'Take a photo or upload one.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/customers', form);
      toast({ title: 'Customer registered', description: `${form.firstName} ${form.lastName} was added.` });
      setForm(EMPTY_FORM);
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
          <p className="text-sm text-gray-500 mt-0.5">
            {branches === null
              ? 'Create account & membership ID'
              : registrationBranch
                ? <>Registering into <span className="font-medium text-gray-700">{registrationBranch.name}</span></>
                : <span className="text-amber-700">Your account has no branch — ask an administrator to assign you one under Users.</span>}
          </p>
        </div>
        <form className="space-y-5" onSubmit={onCreate}>
          <Card>
            <CardHeader><CardTitle>Personal details</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <CustomerPhotoField required value={form.photoUrl} onChange={(v) => set('photoUrl', v)} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label>First name</Label>
                  <Input required className="mt-1.5" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
                </div>
                <div>
                  <Label>Last name</Label>
                  <Input required className="mt-1.5" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
                </div>
                <PhoneVerifyField required label="Phone number" value={form.phone} onChange={(v) => set('phone', v)} />
                <div>
                  <Label>National ID (optional)</Label>
                  <Input className="mt-1.5" value={form.nationalId} onChange={(e) => set('nationalId', e.target.value)} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Home and work</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Label>Residential address</Label>
                <Textarea required rows={2} className="mt-1.5" value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="House number, street, area, town" />
              </div>
              <div className="sm:col-span-2">
                <Label>Occupation</Label>
                <Input required className="mt-1.5" value={form.occupation} onChange={(e) => set('occupation', e.target.value)} placeholder="e.g. Trader, Teacher, Driver" />
              </div>
              <div className="sm:col-span-2">
                <Label>Work address</Label>
                <Textarea required rows={2} className="mt-1.5" value={form.workAddress} onChange={(e) => set('workAddress', e.target.value)} placeholder="Business or employer name, and where it is" />
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            <Button type="submit" disabled={saving || (branches !== null && !registrationBranch)}>
              {saving ? 'Saving...' : 'Register customer'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
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
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
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
                  <TableHead>Occupation</TableHead>
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
                    <TableCell>{c.occupation ?? '—'}</TableCell>
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
