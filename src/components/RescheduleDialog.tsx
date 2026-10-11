'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

/**
 * A new plan for what a customer still owes on a deposit and instalment
 * contract. The amount owed does not change — only how many payments it is
 * spread over and when they start (rescheduleService.ts).
 */
export function RescheduleDialog({ open, contractId, outstandingMinor, onClose, onSaved }: {
  open: boolean; contractId: string; outstandingMinor: number; onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [termWeeks, setTermWeeks] = useState('8');
  const [frequency, setFrequency] = useState('WEEKLY');
  const [startDate, setStartDate] = useState(today);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const weeks = parseInt(termWeeks, 10);
  const validWeeks = Number.isInteger(weeks) && weeks >= 1 && weeks <= 24;
  const count = validWeeks ? (frequency === 'DAILY' ? weeks * 7 : weeks) : 0;
  const each = count ? Math.ceil(outstandingMinor / count) : 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validWeeks) return;
    setSaving(true);
    try {
      await api.post(`/contracts/${contractId}/reschedule`, { termWeeks: weeks, paymentFrequency: frequency, startDate, reason });
      toast({ title: 'Contract rescheduled', description: `${count} ${frequency === 'DAILY' ? 'daily' : 'weekly'} payments of about ${formatCurrency(each)}` });
      setReason('');
      onSaved();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not reschedule the contract', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reschedule what is still owed</DialogTitle></DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <p className="text-sm text-gray-600">
            <strong className="text-gray-900">{formatCurrency(outstandingMinor)}</strong> is still to be paid on the schedule. This spreads it
            over new dates. Nothing already paid changes, and the total owed stays the same.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rs-weeks">Over how many weeks</Label>
              <Input id="rs-weeks" type="number" min="1" max="24" required className="mt-1.5" value={termWeeks} onChange={(e) => setTermWeeks(e.target.value)} />
            </div>
            <div>
              <Label>Paying</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="WEEKLY">Weekly</SelectItem>
                  <SelectItem value="DAILY">Daily</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="rs-start">Counting from</Label>
            <Input id="rs-start" type="date" required className="mt-1.5" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <p className="text-xs text-gray-400 mt-1.5">The first payment falls due one {frequency === 'DAILY' ? 'working day' : 'week'} after this date.</p>
          </div>
          {count > 0 && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
              {count} {frequency === 'DAILY' ? 'daily' : 'weekly'} payments of about <strong>{formatCurrency(each)}</strong>
            </p>
          )}
          <div>
            <Label htmlFor="rs-reason">Why is this being rescheduled?</Label>
            <Textarea id="rs-reason" rows={2} required className="mt-1.5" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Lost her job; agreed smaller weekly payments" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !validWeeks || !reason.trim()}>{saving ? 'Saving...' : 'Reschedule'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
