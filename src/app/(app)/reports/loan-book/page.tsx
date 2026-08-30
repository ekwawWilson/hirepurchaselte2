'use client';

import { useEffect, useState } from 'react';
import { Landmark, TrendingUp, Clock } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';

interface Row {
  contractId: string; contractNumber: string; customerName: string; status: string;
  principalMinor: number; disbursedAt: string | null; principalOutstandingMinor: number;
  interestEarnedMinor: number; interestOutstandingMinor: number;
}
interface Totals { principalOutstandingMinor: number; interestEarnedMinor: number; interestOutstandingMinor: number }
interface Report { rows: Row[]; totals: Totals }

export default function LoanBookReportPage() {
  const { toast } = useToast();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    api.get<Report>('/reports/loan-book')
      .then(setReport)
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Loan Book</h1>
        <p className="text-sm text-gray-500 mt-0.5">Device Loan contracts — cash disbursed for the customer to buy a device outside the store, with principal/interest still outstanding vs earned</p>
      </div>

      {report && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile icon={Landmark} label="Principal outstanding" value={formatCurrency(report.totals.principalOutstandingMinor)} color="amber" />
            <StatTile icon={TrendingUp} label="Interest earned" value={formatCurrency(report.totals.interestEarnedMinor)} color="emerald" />
            <StatTile icon={Clock} label="Interest outstanding" value={formatCurrency(report.totals.interestOutstandingMinor)} color="blue" />
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contract</TableHead><TableHead>Customer</TableHead><TableHead>Status</TableHead><TableHead>Disbursed</TableHead>
                    <TableHead>Principal</TableHead><TableHead>Principal outstanding</TableHead><TableHead>Interest earned</TableHead><TableHead>Interest outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.rows.map((r) => (
                    <TableRow key={r.contractId}>
                      <TableCell className="font-mono text-xs">{r.contractNumber}</TableCell>
                      <TableCell className="font-medium text-gray-900">{r.customerName}</TableCell>
                      <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(r.status)}`}>{r.status}</span></TableCell>
                      <TableCell>{formatDate(r.disbursedAt)}</TableCell>
                      <TableCell>{formatCurrency(r.principalMinor)}</TableCell>
                      <TableCell>{formatCurrency(r.principalOutstandingMinor)}</TableCell>
                      <TableCell>{formatCurrency(r.interestEarnedMinor)}</TableCell>
                      <TableCell>{formatCurrency(r.interestOutstandingMinor)}</TableCell>
                    </TableRow>
                  ))}
                  {report.rows.length === 0 && <TableRow><TableCell colSpan={8} className="text-center py-6 text-gray-400">No Device Loan contracts yet.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
