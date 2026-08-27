'use client';

import { useEffect, useState } from 'react';
import { Plus, UserCog } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

const ROLES = ['SUPER_ADMIN', 'ADMIN', 'BRANCH_MANAGER', 'CASHIER', 'SALES', 'STORE_KEEPER', 'AUDITOR'];

interface User {
  id: string; email: string; firstName: string; lastName: string; isActive: boolean;
  branchId: string | null; role: string;
}
interface Branch { id: string; name: string; code: string }

const ALL_BRANCHES = '__all__';

export default function UsersPage() {
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ firstName: '', lastName: '', email: '', password: '', role: 'CASHIER', branchId: ALL_BRANCHES });
  const [creating, setCreating] = useState(false);

  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ role: 'CASHIER', branchId: ALL_BRANCHES, isActive: true });
  const [saving, setSaving] = useState(false);

  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? id : 'All branches');

  async function load() {
    setIsLoading(true);
    try {
      const [{ users }, { branches }] = await Promise.all([
        api.get<{ users: User[] }>('/users'),
        api.get<{ branches: Branch[] }>('/branches'),
      ]);
      setUsers(users);
      setBranches(branches);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load users', variant: 'destructive' });
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
    setCreating(true);
    try {
      await api.post('/users', {
        ...createForm,
        branchId: createForm.branchId === ALL_BRANCHES ? null : createForm.branchId,
      });
      toast({ title: 'User created' });
      setCreateOpen(false);
      setCreateForm({ firstName: '', lastName: '', email: '', password: '', role: 'CASHIER', branchId: ALL_BRANCHES });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create user', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  }

  function openEdit(u: User) {
    setEditUser(u);
    setEditForm({ role: u.role, branchId: u.branchId ?? ALL_BRANCHES, isActive: u.isActive });
  }

  async function onSaveEdit() {
    if (!editUser) return;
    setSaving(true);
    try {
      await api.patch(`/users/${editUser.id}`, {
        role: editForm.role,
        branchId: editForm.branchId === ALL_BRANCHES ? null : editForm.branchId,
        isActive: editForm.isActive,
      });
      toast({ title: 'User updated' });
      setEditUser(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update user', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500 mt-0.5">Staff accounts, roles, and branch assignment</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} size="sm" className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">New User</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 px-4">
              <UserCog className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500">No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium text-gray-900">{u.firstName} {u.lastName}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell><Badge variant="secondary">{u.role}</Badge></TableCell>
                    <TableCell>{branchName(u.branchId)}</TableCell>
                    <TableCell><Badge variant={u.isActive ? 'default' : 'secondary'}>{u.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
                    <TableCell>
                      <button className="text-xs text-blue-700 hover:underline" onClick={() => openEdit(u)}>Edit</button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create user */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New user</DialogTitle></DialogHeader>
          <form className="grid grid-cols-2 gap-4" onSubmit={onCreate}>
            <div>
              <Label>First name</Label>
              <Input required className="mt-1.5" value={createForm.firstName} onChange={(e) => setCreateForm({ ...createForm, firstName: e.target.value })} />
            </div>
            <div>
              <Label>Last name</Label>
              <Input required className="mt-1.5" value={createForm.lastName} onChange={(e) => setCreateForm({ ...createForm, lastName: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Label>Email</Label>
              <Input required type="email" className="mt-1.5" value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
            </div>
            <div className="col-span-2">
              <Label>Password</Label>
              <Input required type="password" minLength={8} className="mt-1.5" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={createForm.role} onValueChange={(v) => setCreateForm({ ...createForm, role: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Branch</Label>
              <Select value={createForm.branchId} onValueChange={(v) => setCreateForm({ ...createForm, branchId: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name} ({b.code})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="col-span-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create user'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit user */}
      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editUser?.firstName} {editUser?.lastName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Role</Label>
              <Select value={editForm.role} onValueChange={(v) => setEditForm({ ...editForm, role: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Branch</Label>
              <Select value={editForm.branchId} onValueChange={(v) => setEditForm({ ...editForm, branchId: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name} ({b.code})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={editForm.isActive} onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })} />
              Active (can sign in)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button onClick={onSaveEdit} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
