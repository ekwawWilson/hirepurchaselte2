'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import { APP_NAME } from '@/lib/constants/branding';
import { useToast } from '@/hooks/useToast';
import { companyInitials } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export default function SettingsPage() {
  const canManage = useAuthStore((s) => s.hasPermission('settings.manage'));
  const { toast } = useToast();
  const settings = useOrgSettingsStore((s) => s.settings);
  const setSettings = useOrgSettingsStore((s) => s.setSettings);
  const [form, setForm] = useState({ companyName: '', address: '', phone: '', email: '', logoUrl: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      companyName: settings.companyName,
      address: settings.address ?? '',
      phone: settings.phone ?? '',
      email: settings.email ?? '',
      logoUrl: settings.logoUrl ?? '',
    });
  }, [settings]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { settings: updated } = await api.patch<{ settings: typeof settings }>('/settings', form);
      setSettings(updated);
      toast({ title: 'Settings saved', description: 'The company name/logo will now show across the app on next page load.' });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save settings', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">Company details shown across the app</p>
        </div>
        <Card>
          <CardContent className="text-center py-12 px-4">
            <ShieldAlert className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">You don&apos;t have permission to manage settings.</p>
            <p className="text-xs text-gray-400 mt-1">Only Admins and Super Admins can change company details.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Shown in the browser tab title, the top navbar, and on reports</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Company details</CardTitle></CardHeader>
        <CardContent>
          <form className="grid grid-cols-2 gap-4" onSubmit={onSave}>
            <div className="col-span-2">
              <Label>Company name</Label>
              <Input
                required
                className="mt-1.5"
                value={form.companyName}
                onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <Label>Logo URL (optional)</Label>
              <Input
                className="mt-1.5"
                placeholder="https://example.com/logo.png"
                value={form.logoUrl}
                onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-1">Used in place of the initials badge wherever the logo appears. Leave blank to use initials.</p>
            </div>
            <div className="col-span-2">
              <Label>Address (optional)</Label>
              <Input className="mt-1.5" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div>
              <Label>Phone (optional)</Label>
              <Input className="mt-1.5" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label>Email (optional)</Label>
              <Input type="email" className="mt-1.5" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="col-span-2 flex gap-2">
              <Button type="submit" disabled={saving || !form.companyName.trim()}>{saving ? 'Saving...' : 'Save changes'}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center gap-2.5">
            {form.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.logoUrl} alt={form.companyName} className="w-8 h-8 rounded-lg object-cover shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <span className="text-white text-[13px] font-extrabold tracking-tighter">{companyInitials(form.companyName || APP_NAME)}</span>
              </div>
            )}
            <div className="flex flex-col leading-none">
              <span className="text-[15px] font-extrabold text-gray-900 tracking-tight">{form.companyName || APP_NAME}</span>
              <span className="text-[10px] text-gray-400 font-medium tracking-wide uppercase">Hire Purchase System</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3">This is how the navbar will look. The browser tab title and report headers update the same way.</p>
        </CardContent>
      </Card>
    </div>
  );
}
