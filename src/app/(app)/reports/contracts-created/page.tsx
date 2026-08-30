'use client';

import { useEffect, useState } from 'react';
import { FileText, DollarSign } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { ReportDateFilter, today } from '@/components/ReportDateFilter';
import { StatTile } from '@/components/StatTile';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, contractTypeLabel } from '@/lib/utils';

interface Report {
  range: { start: string; end: string };
  count: number;
  totalMinor: number;
  byType: Array<{ contractType: string; count: number; totalMinor: number }>;
  byUser: Array<{ userId: string; name: string; count: number; totalMinor: number }>;
}

export default function ContractsCreatedReportPage() {
  const { toast } = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<Report | null>(null);

  async function load() {
    try {
      setReport(await api.get<Report>(`/reports/contracts-created?from=${from}&to=${to}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Contracts Created</h1>
        <p className="text-sm text-gray-500 mt-0.5">Count and value of new contracts in the selected range, by type and by staff member</p>
      </div>

      <ReportDateFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onRefresh={load} />

      {report && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatTile icon={FileText} label="Contracts created" value={String(report.count)} color="blue" />
            <StatTile icon={DollarSign} label="Total value" value={formatCurrency(report.totalMinor)} color="emerald" />
          </div>

          <Card>
            <CardHeader><CardTitle>By contract type</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Count</TableHead><TableHead>Total value</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.byType.map((r) => (
                    <TableRow key={r.contractType}>
                      <TableCell className="font-medium text-gray-900">{contractTypeLabel(r.contractType)}</TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{formatCurrency(r.totalMinor)}</TableCell>
                    </TableRow>
                  ))}
                  {report.byType.length === 0 && <TableRow><TableCell colSpan={3} className="text-center py-6 text-gray-400">No contracts in this range.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>By staff member</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Staff</TableHead><TableHead>Count</TableHead><TableHead>Total value</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.byUser.map((r) => (
                    <TableRow key={r.userId}>
                      <TableCell className="font-medium text-gray-900">{r.name}</TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{formatCurrency(r.totalMinor)}</TableCell>
                    </TableRow>
                  ))}
                  {report.byUser.length === 0 && <TableRow><TableCell colSpan={3} className="text-center py-6 text-gray-400">No contracts in this range.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
