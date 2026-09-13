'use client';

import { useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import { APP_NAME, MAX_LOGO_BYTES, UPLOADABLE_LOGO_TYPES } from '@/lib/constants/branding';
import { useToast } from '@/hooks/useToast';
import { companyInitials } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { HubtelDiagnostics } from '@/components/settings/HubtelDiagnostics';
import { CompanyLogo } from '@/components/CompanyLogo';

export default function SettingsPage() {
  const canManage = useAuthStore((s) => s.hasPermission('settings.manage'));
  const { toast } = useToast();
  const settings = useOrgSettingsStore((s) => s.settings);
  const setSettings = useOrgSettingsStore((s) => s.setSettings);
  const [form, setForm] = useState({ companyName: '', address: '', phone: '', email: '', logoUrl: '' });
  const [saving, setSaving] = useState(false);
  const logoFileInput = useRef<HTMLInputElement>(null);

  const [loanForm, setLoanForm] = useState({ dailyInterestPercent: '1', interestGraceDays: '0' });
  const [loanSaving, setLoanSaving] = useState(false);

  const [workingDays, setWorkingDays] = useState({ worksSaturday: false, worksSunday: false, acceptsPaymentsOnClosedDays: true });
  const [workingDaysSaving, setWorkingDaysSaving] = useState(false);

  const [contractTypes, setContractTypes] = useState({ saveToOwnEnabled: false, deviceLoanEnabled: false });
  const [contractTypesSaving, setContractTypesSaving] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    api.get<{ settings: { saveToOwnEnabled: boolean; deviceLoanEnabled: boolean } }>('/settings/contract-types')
      .then((r) => setContractTypes({ saveToOwnEnabled: r.settings.saveToOwnEnabled, deviceLoanEnabled: r.settings.deviceLoanEnabled }))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load contract types', variant: 'destructive' }));
    api.get<{ settings: { dailyInterestRateBps: number; interestGraceDays: number } }>('/settings/loan-terms')
      .then((r) => setLoanForm({
        dailyInterestPercent: (r.settings.dailyInterestRateBps / 100).toString(),
        interestGraceDays: r.settings.interestGraceDays.toString(),
      }))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load loan terms', variant: 'destructive' }));
    api.get<{ settings: { worksSaturday: boolean; worksSunday: boolean; acceptsPaymentsOnClosedDays: boolean } }>('/settings/operating')
      .then((r) => setWorkingDays({
        worksSaturday: r.settings.worksSaturday,
        worksSunday: r.settings.worksSunday,
        acceptsPaymentsOnClosedDays: r.settings.acceptsPaymentsOnClosedDays,
      }))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load working days', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);

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

  function onLogoFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be chosen again after removing it
    if (!file) return;
    if (!(UPLOADABLE_LOGO_TYPES as readonly string[]).includes(file.type)) {
      toast({ title: 'Unsupported image', description: 'Upload a PNG or JPEG logo.', variant: 'destructive' });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast({ title: 'Image too large', description: `The logo must be ${Math.round(MAX_LOGO_BYTES / 1024)} KB or smaller.`, variant: 'destructive' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setForm((f) => ({ ...f, logoUrl: String(reader.result) }));
    reader.onerror = () => toast({ title: 'Error', description: 'Could not read that image.', variant: 'destructive' });
    reader.readAsDataURL(file);
  }

  async function onSaveLoanTerms(e: React.FormEvent) {
    e.preventDefault();
    setLoanSaving(true);
    try {
      const dailyInterestRateBps = Math.round(parseFloat(loanForm.dailyInterestPercent) * 100);
      const interestGraceDays = parseInt(loanForm.interestGraceDays, 10);
      await api.patch('/settings/loan-terms', { dailyInterestRateBps, interestGraceDays });
      toast({ title: 'Loan payment terms saved', description: 'Applies to device loans created from now on — existing loans keep the rate they were disbursed at.' });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save loan terms', variant: 'destructive' });
    } finally {
      setLoanSaving(false);
    }
  }

  async function onSaveWorkingDays(e: React.FormEvent) {
    e.preventDefault();
    setWorkingDaysSaving(true);
    try {
      await api.patch('/settings/operating', workingDays);
      toast({
        title: 'Working days saved',
        description: 'Applies to new contract schedules, daily loan interest, direct debit collection, and whether closed-day payments are taken — existing instalment dates stay as agreed.',
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save working days', variant: 'destructive' });
    } finally {
      setWorkingDaysSaving(false);
    }
  }

  async function onSaveContractTypes(e: React.FormEvent) {
    e.preventDefault();
    setContractTypesSaving(true);
    try {
      await api.patch('/settings/contract-types', contractTypes);
      toast({
        title: 'Contract types saved',
        description: 'Controls which types can be chosen for new contracts — existing contracts keep working either way.',
      });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save contract types', variant: 'destructive' });
    } finally {
      setContractTypesSaving(false);
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
              <Label>Logo (optional)</Label>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => logoFileInput.current?.click()}>
                  Upload image
                </Button>
                <input ref={logoFileInput} type="file" accept={UPLOADABLE_LOGO_TYPES.join(',')} className="hidden" onChange={onLogoFileChosen} />
                {form.logoUrl && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, logoUrl: '' })}>Remove logo</Button>
                )}
              </div>
              {form.logoUrl.startsWith('data:') ? (
                <p className="text-xs text-gray-500 mt-2">
                  {form.logoUrl === (settings.logoUrl ?? '') ? 'Using an uploaded image.' : 'New image chosen — click Save changes to apply it.'}
                </p>
              ) : (
                <Input
                  className="mt-2"
                  placeholder="or paste a link: https://example.com/logo.png"
                  value={form.logoUrl}
                  onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                />
              )}
              <p className="text-xs text-gray-400 mt-1">
                PNG or JPEG, up to {Math.round(MAX_LOGO_BYTES / 1024)} KB — a square image works best. Shown in the navbar, on
                reports and the login screen, and used as the browser tab icon and installed-app icon. Without a logo, the
                company&apos;s initials are used everywhere instead.
              </p>
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
          <div className="flex items-center gap-2.5 min-w-0">
            <CompanyLogo
              logoUrl={form.logoUrl || null}
              companyName={form.companyName}
              imgClassName="w-8 h-8 rounded-lg object-cover shrink-0"
              fallback={
                <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                  <span className="text-white text-[13px] font-extrabold tracking-tighter">{companyInitials(form.companyName || APP_NAME)}</span>
                </div>
              }
            />
            <div className="flex flex-col leading-none min-w-0">
              <span className="text-[15px] font-extrabold text-gray-900 tracking-tight truncate">{form.companyName || APP_NAME}</span>
              <span className="text-[10px] text-gray-400 font-medium tracking-wide uppercase">Hire Purchase System</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3">This is how the navbar will look. The browser tab title and report headers update the same way.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Contract types</CardTitle></CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSaveContractTypes}>
            <p className="text-xs text-gray-400">
              Deposit + Instalment is always available. Activate the other types to offer them when creating a
              contract. Turning a type off only stops new contracts of that type — existing ones still take
              payments and withdrawals as normal.
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={contractTypes.saveToOwnEnabled}
                  onChange={(e) => setContractTypes({ ...contractTypes, saveToOwnEnabled: e.target.checked })}
                />
                Activate Save to Own
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={contractTypes.deviceLoanEnabled}
                  onChange={(e) => setContractTypes({ ...contractTypes, deviceLoanEnabled: e.target.checked })}
                />
                Activate Device Loan
              </label>
            </div>
            <Button type="submit" disabled={contractTypesSaving}>{contractTypesSaving ? 'Saving...' : 'Save contract types'}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Working days</CardTitle></CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSaveWorkingDays}>
            <p className="text-xs text-gray-400">
              Monday to Friday are always working days. Tick a weekend day if the business operates on it — that
              controls which days instalments can fall due, which days daily loan interest is charged, and which days
              direct debit collects.
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={workingDays.worksSaturday}
                  onChange={(e) => setWorkingDays({ ...workingDays, worksSaturday: e.target.checked })}
                />
                Open on Saturdays
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={workingDays.worksSunday}
                  onChange={(e) => setWorkingDays({ ...workingDays, worksSunday: e.target.checked })}
                />
                Open on Sundays
              </label>
            </div>
            <div className="border-t border-gray-100 pt-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={workingDays.acceptsPaymentsOnClosedDays}
                  onChange={(e) => setWorkingDays({ ...workingDays, acceptsPaymentsOnClosedDays: e.target.checked })}
                />
                Accept payments on closed days
              </label>
              <p className="text-xs text-gray-400 mt-1">
                Lets a customer pay on a weekend toward a weekday instalment, or toward loan interest that only
                accrues on working days. Untick to turn those payments away until the next working day — a charge
                already collected is still always recorded, never lost.
              </p>
            </div>
            <Button type="submit" disabled={workingDaysSaving}>{workingDaysSaving ? 'Saving...' : 'Save working days'}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Loan payment terms</CardTitle></CardHeader>
        <CardContent>
          <form className="grid grid-cols-2 gap-4" onSubmit={onSaveLoanTerms}>
            <div>
              <Label>Daily interest rate (%)</Label>
              <Input
                required type="number" step="0.01" min="0.01" className="mt-1.5"
                value={loanForm.dailyInterestPercent}
                onChange={(e) => setLoanForm({ ...loanForm, dailyInterestPercent: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-1">Flat percentage of the original loan amount, charged each working day the loan is unpaid.</p>
            </div>
            <div>
              <Label>Grace period (days)</Label>
              <Input
                required type="number" step="1" min="0" className="mt-1.5"
                value={loanForm.interestGraceDays}
                onChange={(e) => setLoanForm({ ...loanForm, interestGraceDays: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-1">Days after the loan date before interest starts accruing.</p>
            </div>
            <div className="col-span-2">
              <Button type="submit" disabled={loanSaving}>{loanSaving ? 'Saving...' : 'Save loan terms'}</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <HubtelDiagnostics />
    </div>
  );
}
