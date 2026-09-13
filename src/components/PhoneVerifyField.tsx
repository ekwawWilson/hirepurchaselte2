'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { MOBILE_MONEY_NETWORK_LABELS } from '@/lib/constants/contracts';
import { networkForPhone } from '@/lib/constants/customers';

/**
 * One phone number field with a "Verify" action — confirms the number is a real,
 * currently-registered mobile money wallet and shows the account holder's name,
 * purely as a typo/sanity check (never blocks the form; the verify call itself
 * fails open — see hubtelVerificationService.ts). The network is read from the
 * number's prefix rather than asked for.
 */
export function PhoneVerifyField({
  label, value, onChange, required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; accountName: string | null } | null>(null);
  const network = value.trim().length >= 3 ? networkForPhone(value) : null;

  async function verify() {
    if (!value.trim()) return;
    setChecking(true);
    setResult(null);
    try {
      const res = await api.post<{ verified: boolean; accountName: string | null; message: string }>('/customers/verify-phone', { phone: value });
      setResult(res);
      if (!res.verified) toast({ title: 'Could not verify', description: res.message, variant: 'destructive' });
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Verification failed', variant: 'destructive' });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1.5 flex gap-1.5">
        <Input
          type="tel"
          inputMode="tel"
          required={required}
          value={value}
          placeholder="024 000 0000"
          onChange={(e) => { onChange(e.target.value); setResult(null); }}
          className="flex-1 min-w-0"
        />
        <Button type="button" variant="outline" disabled={!value.trim() || checking} onClick={verify}>
          {checking ? '...' : 'Verify'}
        </Button>
      </div>
      {result?.verified ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {result.accountName ? `Registered to ${result.accountName}` : 'Registered mobile money number'}
        </p>
      ) : network ? (
        <p className="mt-1 text-xs text-gray-500">{MOBILE_MONEY_NETWORK_LABELS[network]}</p>
      ) : value.trim().length >= 3 ? (
        <p className="mt-1 text-xs text-amber-600">Unrecognised network — check the first digits</p>
      ) : null}
    </div>
  );
}
