'use client';

import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, contractTypeLabel } from '@/lib/utils';

interface Row {
  contractId: string; contractNumber: string; customerName: string; contractType: string;
  balanceMinor: number; totalPayableMinor: number;
}
interface Report { totalOutstandingMinor: number; contracts: Row[] }

export default function OutstandingBalancesReportPage() {
  const { toast } = useToast();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    api.get<Report>('/reports/outstanding-balances')
      .then(setReport)
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Outstanding Balances</h1>
        <p className="text-sm text-gray-500 mt-0.5">Portfolio-at-risk view — every open contract, largest balance first</p>
      </div>

      {report && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatTile icon={Wallet} label="Total outstanding" value={formatCurrency(report.totalOutstandingMinor)} color="amber" />
            <StatTile icon={Wallet} label="Open contracts" value={String(report.contracts.length)} color="blue" />
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Contract</TableHead><TableHead>Customer</TableHead><TableHead>Type</TableHead><TableHead>Balance</TableHead><TableHead>Total Payable</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {report.contracts.map((r) => (
                    <TableRow key={r.contractId}>
                      <TableCell className="font-mono text-xs">{r.contractNumber}</TableCell>
                      <TableCell className="font-medium text-gray-900">{r.customerName}</TableCell>
                      <TableCell>{contractTypeLabel(r.contractType)}</TableCell>
                      <TableCell>{formatCurrency(r.balanceMinor)}</TableCell>
                      <TableCell>{formatCurrency(r.totalPayableMinor)}</TableCell>
                    </TableRow>
                  ))}
                  {report.contracts.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-gray-400">No open balances.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
