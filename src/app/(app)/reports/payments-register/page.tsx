'use client';

import { useEffect, useState } from 'react';
import { Receipt, DollarSign } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { ReportDateFilter, today } from '@/components/ReportDateFilter';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDateTime, getStatusColor } from '@/lib/utils';

interface PaymentRow {
  id: string; entryType: string; amountMinor: number; channel: string; status: string;
  receiptNumber: string | null; reversesPaymentId: string | null; createdAt: string;
  contract: { contractNumber: string };
  createdBy: { firstName: string; lastName: string } | null;
}
interface Report {
  range: { start: string; end: string };
  payments: PaymentRow[];
}

export default function PaymentsRegisterReportPage() {
  const { toast } = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<Report | null>(null);

  async function load() {
    try {
      setReport(await api.get<Report>(`/reports/payments-register?from=${from}&to=${to}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const successful = report?.payments.filter((p) => p.status === 'SUCCESS' && !p.reversesPaymentId) ?? [];
  // A WITHDRAWAL is cash paid back out to the customer, not received — it
  // subtracts from the total the same way it subtracts from a contract's
  // totalPaidMinor (paymentService.recomputeContract).
  const totalMinor = successful.reduce((s, p) => s + (p.entryType === 'WITHDRAWAL' ? -p.amountMinor : p.amountMinor), 0);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Payments Register</h1>
        <p className="text-sm text-gray-500 mt-0.5">Every payment transaction in range, across cash, USSD, and direct debit</p>
      </div>

      <ReportDateFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onRefresh={load} />

      {report && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatTile icon={Receipt} label="Transactions" value={String(report.payments.length)} color="blue" />
            <StatTile icon={DollarSign} label="Total (successful, non-reversal)" value={formatCurrency(totalMinor)} color="emerald" />
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead><TableHead>Contract</TableHead><TableHead>Type</TableHead>
                    <TableHead>Channel</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead>
                    <TableHead>Receipt</TableHead><TableHead>Recorded by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-gray-500">{formatDateTime(p.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{p.contract.contractNumber}</TableCell>
                      <TableCell>
                        {p.reversesPaymentId ? 'Reversal' : p.entryType === 'DEPOSIT' ? 'Deposit' : p.entryType === 'WITHDRAWAL' ? 'Withdrawal' : 'Instalment'}
                      </TableCell>
                      <TableCell>{p.channel}</TableCell>
                      <TableCell className={p.entryType === 'WITHDRAWAL' && !p.reversesPaymentId ? 'text-red-600' : undefined}>
                        {p.entryType === 'WITHDRAWAL' && !p.reversesPaymentId ? '-' : ''}{formatCurrency(p.amountMinor)}
                      </TableCell>
                      <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(p.status)}`}>{p.status}</span></TableCell>
                      <TableCell className="font-mono text-xs">{p.receiptNumber ?? '—'}</TableCell>
                      <TableCell>{p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : '—'}</TableCell>
                    </TableRow>
                  ))}
                  {report.payments.length === 0 && <TableRow><TableCell colSpan={8} className="text-center py-6 text-gray-400">No payments in this range.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
