'use client';

import { useEffect, useState } from 'react';
import { Plus, UserCog } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { AccessDenied } from '@/components/AccessDenied';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { OneTimePasswordDialog } from '@/components/OneTimePasswordDialog';

interface User {
  id: string; email: string; firstName: string; lastName: string; isActive: boolean;
  mustChangePassword: boolean; branchId: string | null; role: string;
}
interface Branch { id: string; name: string; code: string }
// Fetched from /api/roles rather than a hardcoded list — includes any custom
// role created from the Roles admin page (src/app/(app)/roles/page.tsx), not
// just the 7 built-in ones.
interface RoleOption { id: string; name: string }

const ALL_BRANCHES = '__all__';

export default function UsersPage() {
  const canManage = useAuthStore((s) => s.hasPermission('user.manage'));
  const ownId = useAuthStore((s) => s.user?.id);
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ firstName: '', lastName: '', email: '', password: '', role: '', branchId: ALL_BRANCHES });
  const [creating, setCreating] = useState(false);

  const [editUser, setEditUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ role: '', branchId: ALL_BRANCHES, isActive: true });
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  // An agent leaving with money still outstanding: the server's warning, shown before saving anyway.
  const [outstandingWarning, setOutstandingWarning] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null);

  const branchName = (id: string | null) => (id ? branches.find((b) => b.id === id)?.name ?? id : 'All branches');

  async function load() {
    setIsLoading(true);
    try {
      const [{ users }, { branches }, { roles }] = await Promise.all([
        api.get<{ users: User[] }>('/users'),
        api.get<{ branches: Branch[] }>('/branches'),
        api.get<{ roles: RoleOption[] }>('/roles'),
      ]);
      setUsers(users);
      setBranches(branches);
      setRoles(roles);
      setCreateForm((f) => ({ ...f, role: f.role || roles[0]?.name || '' }));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load users', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!canManage) { setIsLoading(false); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

  if (!canManage) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Users</h1>
          <p className="text-sm text-gray-500 mt-0.5">Staff accounts, roles, and branch assignment</p>
        </div>
        <AccessDenied
          message="You don't have permission to manage users."
          hint="Only Super Admins can view and manage staff accounts."
        />
      </div>
    );
  }

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
      setCreateForm({ firstName: '', lastName: '', email: '', password: '', role: roles[0]?.name ?? '', branchId: ALL_BRANCHES });
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

  async function onSaveEdit(acknowledgeOutstanding = false) {
    if (!editUser) return;
    setSaving(true);
    try {
      await api.patch(`/users/${editUser.id}`, {
        role: editForm.role,
        branchId: editForm.branchId === ALL_BRANCHES ? null : editForm.branchId,
        isActive: editForm.isActive,
        ...(acknowledgeOutstanding && { acknowledgeOutstanding: true }),
      });
      toast({ title: 'User updated' });
      setEditUser(null);
      setOutstandingWarning(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setOutstandingWarning(e.message); return; }
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update user', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function onResetPassword() {
    if (!editUser) return;
    setResetting(true);
    try {
      const { temporaryPassword } = await api.post<{ temporaryPassword: string }>(`/users/${editUser.id}/reset-password`);
      setIssued({ name: `${editUser.firstName} ${editUser.lastName}`, password: temporaryPassword });
      setEditUser(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to reset the password', variant: 'destructive' });
    } finally {
      setResetting(false);
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
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
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
                    <TableCell>
                      <Badge variant={u.isActive ? 'success' : 'secondary'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>
                      {u.isActive && u.mustChangePassword && <span className="ml-2 text-xs text-amber-700">Password change due</span>}
                    </TableCell>
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
              <Label>First password</Label>
              <Input required type="password" minLength={8} className="mt-1.5" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
              <p className="text-xs text-gray-400 mt-1.5">At least 8 characters, with a letter and a number. They will be asked to replace it when they first sign in.</p>
            </div>
            <div>
              <Label>Role</Label>
              <Select value={createForm.role} onValueChange={(v) => setCreateForm({ ...createForm, role: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roles.map((r) => <SelectItem key={r.id} value={r.name}>{r.name}</SelectItem>)}
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
      <Dialog open={!!editUser} onOpenChange={(open) => { if (!open) { setEditUser(null); setOutstandingWarning(null); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editUser?.firstName} {editUser?.lastName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Role</Label>
              <Select value={editForm.role} onValueChange={(v) => setEditForm({ ...editForm, role: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roles.map((r) => <SelectItem key={r.id} value={r.name}>{r.name}</SelectItem>)}
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
            {editUser && editUser.id !== ownId && (
              <div className="rounded-xl border border-gray-200 p-3">
                <p className="text-sm font-medium text-gray-900">Forgotten or compromised password</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Gives them a one-time password to pass on, signs them out everywhere and lifts any sign-in lock.
                </p>
                <Button type="button" variant="outline" size="sm" className="mt-2.5" disabled={resetting} onClick={onResetPassword}>
                  {resetting ? 'Resetting...' : 'Reset password'}
                </Button>
              </div>
            )}
          </div>
          {outstandingWarning && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{outstandingWarning}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditUser(null); setOutstandingWarning(null); }}>Cancel</Button>
            {outstandingWarning
              ? <Button variant="destructive" onClick={() => onSaveEdit(true)} disabled={saving}>{saving ? 'Saving...' : 'Save anyway'}</Button>
              : <Button onClick={() => onSaveEdit()} disabled={saving}>{saving ? 'Saving...' : 'Save changes'}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OneTimePasswordDialog password={issued?.password ?? null} title="Password reset" onClose={() => setIssued(null)}>
        <p>
          Give this one-time password to <strong>{issued?.name}</strong>. They will be asked to choose their own as soon as they sign in with it.
        </p>
      </OneTimePasswordDialog>
    </div>
  );
}
