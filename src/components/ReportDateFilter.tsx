import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

/** Shared From/To/Refresh filter bar for every date-ranged report — see reports/daily-cash's original hand-written version, extracted here so the other 5 date-ranged reports don't each duplicate it. */
export function ReportDateFilter({
  from, to, onFromChange, onToChange, onRefresh, children,
}: {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex flex-wrap items-end gap-3">
        <div><Label>From</Label><Input type="date" className="mt-1.5" value={from} onChange={(e) => onFromChange(e.target.value)} /></div>
        <div><Label>To</Label><Input type="date" className="mt-1.5" value={to} onChange={(e) => onToChange(e.target.value)} /></div>
        <Button onClick={onRefresh}>Refresh</Button>
        {children}
      </CardContent>
    </Card>
  );
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
