'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

/**
 * Shows a one-time password exactly once — it is stored only as a hash, so
 * closing this is the last anyone sees of it. Used for a staff password an
 * administrator has reset and for a customer's portal password.
 */
export function OneTimePasswordDialog({ password, title, children, onClose }: {
  password: string | null; title: string; children: React.ReactNode; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (insecure context, denied) — the password is on screen to read.
    }
  }

  return (
    <Dialog open={!!password} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="text-sm text-gray-600 space-y-3">{children}</div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
          <span className="font-mono text-2xl font-bold tracking-[0.2em] text-gray-900 select-all" data-testid="one-time-password">{password}</span>
          <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-amber-700">It will not be shown again. If it is lost, issue a new one.</p>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
