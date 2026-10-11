'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * A member of staff choosing their own password — from their account page,
 * or because the one they signed in with was issued by an administrator.
 * The change signs out every other session; this one carries on with the
 * fresh token the server sends back.
 */
export function ChangePasswordForm({ currentLabel = 'Current password', onChanged }: { currentLabel?: string; onChanged?: () => void }) {
  const { user, setAuth } = useAuthStore();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ title: 'Passwords do not match', description: 'Type the same new password twice.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const { token } = await api.post<{ token: string }>('/auth/password', { currentPassword, newPassword });
      if (user) setAuth({ ...user, mustChangePassword: false }, token);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      toast({ title: 'Password changed', description: 'Use your new password next time you sign in.' });
      onChanged?.();
    } catch (e) {
      toast({ title: 'Could not change password', description: e instanceof ApiError ? e.message : 'Something went wrong', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div>
        <Label htmlFor="current-password">{currentLabel}</Label>
        <Input id="current-password" type="password" autoComplete="current-password" required className="mt-1.5" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="new-password">New password</Label>
        <Input id="new-password" type="password" autoComplete="new-password" required minLength={8} className="mt-1.5" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        <p className="text-xs text-gray-400 mt-1.5">At least 8 characters, with a letter and a number.</p>
      </div>
      <div>
        <Label htmlFor="confirm-password">Repeat new password</Label>
        <Input id="confirm-password" type="password" autoComplete="new-password" required minLength={8} className="mt-1.5" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
      </div>
      <Button type="submit" disabled={saving}>
        <KeyRound className="mr-1.5 h-4 w-4" /> {saving ? 'Saving...' : 'Change password'}
      </Button>
    </form>
  );
}
