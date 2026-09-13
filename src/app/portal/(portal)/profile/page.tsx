'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, KeyRound, Phone, User } from 'lucide-react';
import { portalApi, ApiError } from '@/lib/portalApi';
import { useCustomerAuthStore } from '@/lib/customerAuthStore';
import { useToast } from '@/hooks/useToast';
import { formatDate } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface Profile {
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phone2: string | null;
  phone3: string | null;
  email: string | null;
  address: string | null;
  mustChangePassword: boolean;
  portalLastLoginAt: string | null;
  createdAt: string;
  branch: { name: string; phone: string | null; address: string | null } | null;
}

export default function PortalProfilePage() {
  const { toast } = useToast();
  const customer = useCustomerAuthStore((s) => s.customer);
  const setCustomer = useCustomerAuthStore((s) => s.setCustomer);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await portalApi.get<{ customer: Profile }>('/me');
      setProfile(data.customer);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load your details', variant: 'destructive' });
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast({ title: 'Passwords do not match', description: 'Type the same new password twice.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await portalApi.post('/me/password', { currentPassword, newPassword });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      if (customer) setCustomer({ ...customer, mustChangePassword: false });
      await load();
      toast({ title: 'Password changed', description: 'Use your new password next time you sign in.' });
    } catch (e) {
      toast({ title: 'Could not change password', description: e instanceof ApiError ? e.message : 'Something went wrong', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const phones = [profile?.phone, profile?.phone2, profile?.phone3].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My details</h1>
        <p className="text-sm text-gray-500 mt-0.5">Your account and password</p>
      </div>

      {profile?.mustChangePassword && (
        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            You are still signing in with your phone number as your password. Choose a password below so no one
            else can open your account.
          </span>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Account</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Detail icon={User} label="Name" value={`${profile?.firstName ?? ''} ${profile?.lastName ?? ''}`.trim() || '—'} />
          <Detail label="Membership ID" value={profile?.membershipId ?? '—'} mono />
          <Detail icon={Phone} label="Phone numbers" value={phones.join(', ') || '—'} />
          <Detail label="Email" value={profile?.email || '—'} />
          <Detail label="Address" value={profile?.address || '—'} />
          <Detail label="Customer since" value={profile ? formatDate(profile.createdAt) : '—'} />
          {profile?.branch && (
            <Detail label="Your branch" value={[profile.branch.name, profile.branch.phone].filter(Boolean).join(' · ')} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Change password</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2 max-w-xl" onSubmit={changePassword}>
            <div className="sm:col-span-2">
              <Label htmlFor="current">Current password</Label>
              <Input id="current" type="password" className="mt-1.5" required value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={profile?.mustChangePassword ? 'Your phone number' : ''} />
            </div>
            <div>
              <Label htmlFor="new">New password</Label>
              <Input id="new" type="password" className="mt-1.5" required minLength={6} value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="confirm">Repeat new password</Label>
              <Input id="confirm" type="password" className="mt-1.5" required minLength={6} value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={saving} className="gap-2">
                <KeyRound className="h-4 w-4" /> {saving ? 'Saving…' : 'Change password'}
              </Button>
              <p className="text-xs text-gray-400 mt-2">At least 6 characters, and not your phone number.</p>
            </div>
          </form>
        </CardContent>
      </Card>

      <p className="text-xs text-gray-400">
        Something here wrong? Your branch can correct it — the portal shows your details but does not change them.
      </p>
    </div>
  );
}

function Detail({ icon: Icon, label, value, mono }: { icon?: React.ElementType; label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-gray-500 flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-gray-400" />}{label}
      </p>
      <p className={`text-sm text-gray-900 mt-0.5 break-words ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}
