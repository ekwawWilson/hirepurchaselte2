'use client';

import { useEffect, useState } from 'react';
import { Plus, Building2 } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Branch { id: string; name: string; code: string; address: string | null; phone: string | null; isActive: boolean }

export default function BranchesPage() {
  const { toast } = useToast();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', address: '', phone: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    setIsLoading(true);
    try {
      const { branches } = await api.get<{ branches: Branch[] }>('/branches');
      setBranches(branches);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load branches', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/branches', form);
      toast({ title: 'Branch created' });
      setForm({ name: '', code: '', address: '', phone: '' });
      setShowForm(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create branch', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (showForm) {
    return (
      <div className="space-y-5 max-w-2xl">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">New Branch</h1>
          <p className="text-sm text-gray-500 mt-0.5">Add a physical location</p>
        </div>
        <Card>
          <CardHeader><CardTitle>Branch details</CardTitle></CardHeader>
          <CardContent>
            <form className="grid grid-cols-2 gap-4" onSubmit={onCreate}>
              <div>
                <Label>Name</Label>
                <Input required className="mt-1.5" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Code</Label>
                <Input required className="mt-1.5" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
              </div>
              <div>
                <Label>Address</Label>
                <Input className="mt-1.5" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div>
                <Label>Phone</Label>
                <Input className="mt-1.5" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="col-span-2 flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Create branch'}</Button>
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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Branches</h1>
          <p className="text-sm text-gray-500 mt-0.5">Physical locations staff and stock are scoped to</p>
        </div>
        <Button onClick={() => setShowForm(true)} size="sm" className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">New Branch</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
          ) : branches.length === 0 ? (
            <div className="text-center py-12 px-4">
              <Building2 className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500 mb-4">No branches yet</p>
              <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add First Branch</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {branches.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium text-gray-900">{b.name}</TableCell>
                    <TableCell className="font-mono text-xs">{b.code}</TableCell>
                    <TableCell>{b.address ?? '—'}</TableCell>
                    <TableCell>{b.phone ?? '—'}</TableCell>
                    <TableCell><Badge variant={b.isActive ? 'success' : 'secondary'}>{b.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
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
