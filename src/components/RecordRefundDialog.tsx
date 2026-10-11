'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

export interface RefundTarget { id: string; contractNumber: string; refundDueMinor: number }

/**
 * Records what was actually handed back on a cancelled contract. Less than
 * what was paid in — nothing, if the customer kept the device — needs a
 * note saying why (refundService.ts).
 */
export function RecordRefundDialog({ target, onClose, onSaved }: { target: RefundTarget | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) { setAmount((target.refundDueMinor / 100).toFixed(2)); setNote(''); }
  }, [target]);

  const refundedMinor = Math.round(parseFloat(amount || 'NaN') * 100);
  const valid = !!target && Number.isFinite(refundedMinor) && refundedMinor >= 0 && refundedMinor <= target.refundDueMinor;
  const needsNote = valid && refundedMinor < target!.refundDueMinor;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !valid) return;
    setSaving(true);
    try {
      await api.post(`/contracts/${target.id}/refund`, { refundedMinor, note });
      toast({ title: 'Refund recorded', description: `${formatCurrency(refundedMinor)} on ${target.contractNumber}` });
      onSaved();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not record the refund', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Record refund — {target?.contractNumber}</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <p className="text-sm text-gray-600">
            The customer had paid {target && formatCurrency(target.refundDueMinor)} when this contract was cancelled. Record what was
            actually handed back to them.
          </p>
          <div>
            <Label htmlFor="refund-amount">Amount handed back (GHS)</Label>
            <Input id="refund-amount" type="number" min="0" step="0.01" max={target ? target.refundDueMinor / 100 : undefined} required className="mt-1.5" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="refund-note">{needsNote ? 'Why less than the full amount?' : 'Note (optional)'}</Label>
            <Textarea
              id="refund-note" className="mt-1.5" rows={2} required={needsNote} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={needsNote ? 'e.g. Customer kept the device; GHS 50 cancellation fee agreed' : 'e.g. Paid in cash, signed for'}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !valid}>{saving ? 'Saving...' : 'Record refund'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
