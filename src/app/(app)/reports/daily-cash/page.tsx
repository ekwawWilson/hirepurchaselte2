'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency } from '@/lib/utils';

interface DailyCashReport {
  totalMinor: number;
  byChannel: Record<string, number>;
  byCashier: Array<{ userId: string; name: string; amountMinor: number; count: number }>;
  transactionCount: number;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export default function DailyCashReportPage() {
  const { toast } = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<DailyCashReport | null>(null);

  async function load() {
    try {
      const data = await api.get<DailyCashReport>(`/reports/daily-cash?from=${from}&to=${to}`);
      setReport(data);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function exportCsv() {
    if (!report) return;
    const rows = [
      ['Cashier', 'Amount (GHS)', 'Transaction count'],
      ...report.byCashier.map((c) => [c.name, (c.amountMinor / 100).toFixed(2), String(c.count)]),
    ];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-cash-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Daily Cash Received</h1>
        <p className="text-sm text-gray-500 mt-0.5">Reconciles exactly against the payment ledger for the range</p>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div><Label>From</Label><Input type="date" className="mt-1.5" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><Label>To</Label><Input type="date" className="mt-1.5" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <Button onClick={load}>Refresh</Button>
          <Button variant="outline" onClick={exportCsv} disabled={!report}>Export CSV</Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total received</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(report.totalMinor)}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Cash</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(report.byChannel.CASH ?? 0)}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-xs text-gray-500">USSD</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(report.byChannel.USSD ?? 0)}</p></CardContent></Card>
          </div>

          <Card>
            <CardHeader><CardTitle>By cashier</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Cashier</TableHead><TableHead>Amount</TableHead><TableHead>Transactions</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {report.byCashier.map((c) => (
                    <TableRow key={c.userId}>
                      <TableCell className="font-medium text-gray-900">{c.name}</TableCell>
                      <TableCell>{formatCurrency(c.amountMinor)}</TableCell>
                      <TableCell>{c.count}</TableCell>
                    </TableRow>
                  ))}
                  {report.byCashier.length === 0 && (
                    <TableRow><TableCell colSpan={3} className="text-center py-6 text-gray-400">No payments in this range.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
