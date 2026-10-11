'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export const OUTCOME_LABELS: Record<string, string> = {
  NO_ANSWER: 'No answer', SPOKE: 'Spoke to customer', PROMISED: 'Promised to pay', VISITED: 'Visited', OTHER: 'Other',
};

/**
 * Logs one contact with a customer who is behind: what happened, any promise
 * to pay (how much, by when) and when to follow up. A promise sets its own
 * follow-up for the day after it falls due (arrearsFollowUpService.ts).
 */
export function LogContactDialog({ target, onClose, onSaved }: {
  target: { contractId: string; customerName: string; contractNumber: string } | null;
  onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState('SPOKE');
  const [note, setNote] = useState('');
  const [promisedAmount, setPromisedAmount] = useState('');
  const [promisedDate, setPromisedDate] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [saving, setSaving] = useState(false);

  function reset() {
    setOutcome('SPOKE'); setNote(''); setPromisedAmount(''); setPromisedDate(''); setFollowUpAt('');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setSaving(true);
    try {
      await api.post(`/contracts/${target.contractId}/collection-notes`, {
        outcome, note,
        promisedAmountMinor: outcome === 'PROMISED' && promisedAmount ? Math.round(parseFloat(promisedAmount) * 100) : null,
        promisedDate: outcome === 'PROMISED' ? promisedDate || null : null,
        followUpAt: followUpAt || null,
      });
      toast({ title: 'Contact logged' });
      reset();
      onSaved();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not save the note', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={!!target} onOpenChange={(open) => { if (!open) { reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Log contact — {target?.customerName}</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div>
            <Label>What happened?</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {Object.entries(OUTCOME_LABELS).map(([key, label]) => (
                <button
                  key={key} type="button" onClick={() => setOutcome(key)}
                  className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
                    outcome === key ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {outcome === 'PROMISED' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="promised-amount">Amount promised (GHS)</Label>
                <Input id="promised-amount" type="number" min="0.01" step="0.01" className="mt-1.5" value={promisedAmount} onChange={(e) => setPromisedAmount(e.target.value)} placeholder="Optional" />
              </div>
              <div>
                <Label htmlFor="promised-date">To be paid by</Label>
                <Input id="promised-date" type="date" required min={today} className="mt-1.5" value={promisedDate} onChange={(e) => setPromisedDate(e.target.value)} />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="contact-note">Notes</Label>
            <Textarea
              id="contact-note" className="mt-1.5" rows={3} required={outcome !== 'PROMISED'} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={outcome === 'NO_ANSWER' ? 'e.g. Rang twice, phone off' : 'What was said or agreed'}
            />
          </div>

          <div>
            <Label htmlFor="follow-up">Follow up on</Label>
            <Input id="follow-up" type="date" min={today} className="mt-1.5" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
            <p className="text-xs text-gray-400 mt-1.5">
              {outcome === 'PROMISED' ? 'Leave empty to follow up the day after the promised date.' : 'Optional. The contract comes back under "Follow-up due" on this day.'}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
