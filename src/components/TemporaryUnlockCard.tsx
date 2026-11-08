'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Option { percent: number; hours: number; period: string; amountMinor: number; chargeMinor: number }
interface Offer { available: boolean; message: string | null; overdueMinor: number; options: Option[]; activeUntil: string | null; usesLeft: number }

/**
 * A locked Device Financing phone, on its contract page: what a temporary
 * unlock would cost, and for office staff, taking the cash for one
 * (paytrigger/temporaryUnlock.ts). Shows nothing when it does not apply.
 */
export function TemporaryUnlockCard({ contractId, canTakeCash, onDone }: { contractId: string; canTakeCash: boolean; onDone: () => void }) {
  const { toast } = useToast();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [chosen, setChosen] = useState<Option | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ offer: Offer | null }>(`/contracts/${contractId}/temporary-unlock`).then((r) => setOffer(r.offer)).catch(() => setOffer(null));
  }, [contractId]);
  if (!offer) return null;

  async function takeCash() {
    if (!chosen) return;
    setSaving(true);
    try {
      await api.post(`/contracts/${contractId}/temporary-unlock`, { percent: chosen.percent });
      toast({ title: 'Phone opening', description: `${formatCurrency(chosen.amountMinor)} recorded. The phone opens for ${chosen.period}.` });
      setChosen(null);
      onDone();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to record the payment', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="border-violet-200 ring-1 ring-violet-100">
      <CardContent className="p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-gray-900">Temporary unlock</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {formatCurrency(offer.overdueMinor)} overdue.
            {offer.activeUntil ? ` The phone is open until ${formatDateTime(offer.activeUntil)}.` : ' The phone is locked.'}
            {offer.available && ` ${offer.usesLeft} unlock${offer.usesLeft === 1 ? '' : 's'} left before the full overdue must be paid.`}
          </p>
        </div>
        {offer.available ? (
          <div className="flex flex-wrap gap-2">
            {offer.options.map((o) => (
              canTakeCash
                ? <Button key={o.percent} variant="outline" size="sm" onClick={() => setChosen(o)}>{formatCurrency(o.amountMinor)} &middot; {o.period}</Button>
                : <span key={o.percent} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600">{formatCurrency(o.amountMinor)} &middot; {o.period}</span>
            ))}
          </div>
        ) : <p className="text-sm text-gray-700">{offer.message}</p>}
      </CardContent>
      <AlertDialog open={!!chosen} onOpenChange={(open) => !open && setChosen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take {chosen && formatCurrency(chosen.amountMinor)} in cash?</AlertDialogTitle>
            <AlertDialogDescription>
              {!!chosen?.chargeMinor && `This includes a ${formatCurrency(chosen.chargeMinor)} charge. `}The payment is recorded now and the phone opens for {chosen?.period}. It locks again at the end unless all that is overdue has been paid.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={takeCash}>Record and open phone</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
