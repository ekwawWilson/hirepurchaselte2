'use client';

import { useEffect, useState } from 'react';
import { Plus, ShieldCheck, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { PERMISSION_GROUPS, PERMISSION_LABELS, type Permission } from '@/lib/constants/rbac';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

interface Role {
  id: string; name: string; description: string | null;
  isSystemRole: boolean; permissions: string[]; userCount: number;
}

interface RoleFormState {
  name: string;
  description: string;
  permissions: Set<Permission>;
}

const emptyForm = (): RoleFormState => ({ name: '', description: '', permissions: new Set() });

function PermissionGrid({ selected, onToggle, disabled }: { selected: Set<Permission>; onToggle: (p: Permission) => void; disabled?: boolean }) {
  return (
    <div className="space-y-4 max-h-80 overflow-y-auto pr-1">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">{group.label}</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {group.permissions.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={selected.has(p)}
                  disabled={disabled}
                  onChange={() => onToggle(p)}
                />
                {PERMISSION_LABELS[p]}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RolesPage() {
  const canManage = useAuthStore((s) => s.hasPermission('role.manage'));
  const { toast } = useToast();
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<RoleFormState>(emptyForm());
  const [creating, setCreating] = useState(false);

  const [editRole, setEditRole] = useState<Role | null>(null);
  const [editForm, setEditForm] = useState<RoleFormState>(emptyForm());
  const [saving, setSaving] = useState(false);

  const [viewRole, setViewRole] = useState<Role | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    setIsLoading(true);
    try {
      const { roles } = await api.get<{ roles: Role[] }>('/roles');
      setRoles(roles);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load roles', variant: 'destructive' });
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
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Roles</h1>
          <p className="text-sm text-gray-500 mt-0.5">Custom roles and permission assignment</p>
        </div>
        <Card>
          <CardContent className="text-center py-12 px-4">
            <ShieldAlert className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">You don&apos;t have permission to manage roles.</p>
            <p className="text-xs text-gray-400 mt-1">Only Super Admins can view and manage roles.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  function togglePermission(set: Set<Permission>, setState: (s: Set<Permission>) => void, p: Permission) {
    const next = new Set(set);
    if (next.has(p)) next.delete(p); else next.add(p);
    setState(next);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/roles', {
        name: createForm.name,
        description: createForm.description.trim() || undefined,
        permissions: [...createForm.permissions],
      });
      toast({ title: 'Role created' });
      setCreateOpen(false);
      setCreateForm(emptyForm());
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to create role', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  }

  function openEdit(r: Role) {
    setEditRole(r);
    setEditForm({ name: r.name, description: r.description ?? '', permissions: new Set(r.permissions as Permission[]) });
  }

  async function onSaveEdit() {
    if (!editRole) return;
    setSaving(true);
    try {
      await api.patch(`/roles/${editRole.id}`, {
        name: editForm.name,
        description: editForm.description.trim() || null,
        permissions: [...editForm.permissions],
      });
      toast({ title: 'Role updated' });
      setEditRole(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to update role', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/roles/${deleteTarget.id}`);
      toast({ title: 'Role deleted' });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to delete role', variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Roles</h1>
          <p className="text-sm text-gray-500 mt-0.5">Custom roles and permission assignment</p>
        </div>
        <Button onClick={() => { setCreateForm(emptyForm()); setCreateOpen(true); }} size="sm" className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">New Role</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      <p className="text-xs text-gray-400 -mt-2">
        The 7 built-in roles (SUPER_ADMIN, ADMIN, BRANCH_MANAGER, CASHIER, SALES, STORE_KEEPER, AUDITOR) are managed in
        code and kept in sync automatically on every deploy — they can&apos;t be edited or deleted here. Create a
        custom role for anything more specific.
      </p>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
          ) : roles.length === 0 ? (
            <div className="text-center py-12 px-4">
              <ShieldCheck className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500">No roles found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead>Users</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium text-gray-900">
                      <div className="flex items-center gap-2">
                        {r.name}
                        {r.isSystemRole && <Badge variant="secondary">System</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-gray-500">{r.description ?? '—'}</TableCell>
                    <TableCell>{r.permissions.length}</TableCell>
                    <TableCell>{r.userCount}</TableCell>
                    <TableCell>
                      {r.isSystemRole ? (
                        <button className="text-xs text-blue-700 hover:underline" onClick={() => setViewRole(r)}>View</button>
                      ) : (
                        <div className="flex items-center gap-3">
                          <button className="text-xs text-blue-700 hover:underline" onClick={() => openEdit(r)}>Edit</button>
                          <button className="text-xs text-red-600 hover:underline" onClick={() => setDeleteTarget(r)}>Delete</button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create role */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>New role</DialogTitle></DialogHeader>
          <form className="space-y-4" onSubmit={onCreate}>
            <div>
              <Label>Name</Label>
              <Input
                required className="mt-1.5" placeholder="e.g. Regional Manager"
                value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-1">Stored as {createForm.name.trim() ? createForm.name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || '—' : '—'}</p>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input className="mt-1.5" value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} />
            </div>
            <div>
              <Label>Permissions</Label>
              <div className="mt-1.5">
                <PermissionGrid
                  selected={createForm.permissions}
                  onToggle={(p) => togglePermission(createForm.permissions, (s) => setCreateForm({ ...createForm, permissions: s }), p)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !createForm.name.trim()}>{creating ? 'Creating...' : 'Create role'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit role */}
      <Dialog open={!!editRole} onOpenChange={(open) => !open && setEditRole(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Edit {editRole?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input required className="mt-1.5" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input className="mt-1.5" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
            </div>
            <div>
              <Label>Permissions</Label>
              <div className="mt-1.5">
                <PermissionGrid
                  selected={editForm.permissions}
                  onToggle={(p) => togglePermission(editForm.permissions, (s) => setEditForm({ ...editForm, permissions: s }), p)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRole(null)}>Cancel</Button>
            <Button onClick={onSaveEdit} disabled={saving || !editForm.name.trim()}>{saving ? 'Saving...' : 'Save changes'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View a system role's permissions (read-only) */}
      <Dialog open={!!viewRole} onOpenChange={(open) => !open && setViewRole(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{viewRole?.name}</DialogTitle></DialogHeader>
          <p className="text-xs text-gray-400 -mt-2">
            System role — managed in {' '}
            <code className="bg-gray-100 px-1 py-0.5 rounded">src/lib/constants/rbac.ts</code>, kept in sync automatically on every deploy.
          </p>
          {viewRole && (
            <PermissionGrid selected={new Set(viewRole.permissions as Permission[])} onToggle={() => undefined} disabled />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewRole(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.userCount > 0
                ? `${deleteTarget.userCount} user(s) still hold this role — reassign them before it can be deleted.`
                : 'This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDelete} disabled={deleting || (deleteTarget?.userCount ?? 0) > 0}>
              {deleting ? 'Deleting...' : 'Delete role'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
