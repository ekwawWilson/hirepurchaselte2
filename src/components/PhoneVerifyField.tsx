'use client';

import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

const NETWORKS = ['MTN', 'VODAFONE', 'TELECEL'];

/**
 * One phone number field with a "Verify" action — confirms the number is a real,
 * currently-registered mobile money wallet and shows the account holder's name,
 * purely as a typo/sanity check (never blocks the form; the verify call itself
 * fails open — see hubtelVerificationService.ts). Modeled on salesinventoryapp's
 * momo/verify usage, not an OTP/SMS-code flow (this app has no such feature).
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
  const [network, setNetwork] = useState('MTN');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ verified: boolean; accountName: string | null } | null>(null);

  async function verify() {
    if (!value.trim()) return;
    setChecking(true);
    setResult(null);
    try {
      const res = await api.post<{ verified: boolean; accountName: string | null; message: string }>('/customers/verify-phone', { phone: value, network });
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
          required={required}
          value={value}
          onChange={(e) => { onChange(e.target.value); setResult(null); }}
          className="flex-1"
        />
        <select
          className="h-10 border border-input bg-white px-2 text-xs text-gray-600"
          value={network}
          onChange={(e) => { setNetwork(e.target.value); setResult(null); }}
        >
          {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <Button type="button" variant="outline" size="sm" disabled={!value.trim() || checking} onClick={verify}>
          {checking ? '...' : 'Verify'}
        </Button>
      </div>
      {result?.verified && (
        <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {result.accountName ? `Registered to ${result.accountName}` : 'Registered mobile money number'}
        </p>
      )}
    </div>
  );
}
