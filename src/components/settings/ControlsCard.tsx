'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface Controls {
  requireSecondApproval: boolean; ownerPhone: string | null;
  dailySummaryEnabled: boolean; directDebitNoticeEnabled: boolean; partialDirectDebitEnabled: boolean;
}

const SWITCHES: { key: Exclude<keyof Controls, 'ownerPhone'>; label: string; detail: string }[] = [
  {
    key: 'requireSecondApproval', label: 'A second person for reversals, write-offs and cancellations',
    detail: 'Reversing a payment, writing off a contract, or cancelling one that money has been paid on only happens once a different person approves it. Turn off only if one person runs the business alone.',
  },
  {
    key: 'directDebitNoticeEnabled', label: 'Tell customers the day before a direct debit',
    detail: 'A text at 4pm the day before an instalment is collected from their wallet, so the money is there.',
  },
  {
    key: 'partialDirectDebitEnabled', label: 'Take part of an instalment when the whole of it fails',
    detail: 'After a direct debit is refused, the retry asks for half of it rather than the same amount again. What is left is collected later.',
  },
  {
    key: 'dailySummaryEnabled', label: "Text the owner a summary every evening",
    detail: 'At 7pm: what was collected, new contracts, what is overdue and whether anything needs attention. Needs the owner\'s number below.',
  },
];

/** The owner's controls and notification switches (controlSettingsService.ts). */
export function ControlsCard() {
  const { toast } = useToast();
  const [controls, setControls] = useState<Controls | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ settings: Controls }>('/settings/controls')
      .then((r) => setControls(r.settings))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load controls', variant: 'destructive' }));
  }, [toast]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!controls) return;
    setSaving(true);
    try {
      const { settings } = await api.patch<{ settings: Controls }>('/settings/controls', { ...controls, ownerPhone: controls.ownerPhone ?? '' });
      setControls(settings);
      toast({ title: 'Controls saved' });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save controls', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Controls and notifications</CardTitle></CardHeader>
      <CardContent>
        {!controls ? (
          <div className="flex justify-center py-6"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" /></div>
        ) : (
          <form className="space-y-4" onSubmit={onSave}>
            {SWITCHES.map((s) => (
              <label key={s.key} className="flex items-start gap-3">
                <input
                  type="checkbox" className="mt-1" checked={controls[s.key]}
                  onChange={(e) => setControls({ ...controls, [s.key]: e.target.checked })}
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900">{s.label}</span>
                  <span className="block text-xs text-gray-500 mt-0.5">{s.detail}</span>
                </span>
              </label>
            ))}
            <div className="max-w-xs">
              <Label htmlFor="owner-phone">Owner&apos;s mobile number</Label>
              <Input
                id="owner-phone" type="tel" className="mt-1.5" placeholder="e.g. 0241234567"
                value={controls.ownerPhone ?? ''} onChange={(e) => setControls({ ...controls, ownerPhone: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-1">Receives alerts when something breaks, and the daily summary. A test message is sent when you change it.</p>
            </div>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save controls'}</Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
