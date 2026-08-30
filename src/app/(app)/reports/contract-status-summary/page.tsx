'use client';

import { useEffect, useState } from 'react';
import { PieChart, FileText } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, getStatusColor } from '@/lib/utils';

interface Row { status: string; count: number; totalMinor: number }

export default function ContractStatusSummaryReportPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    api.get<{ report: Row[] }>('/reports/contract-status-summary')
      .then((r) => setRows(r.report))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalCount = rows?.reduce((s, r) => s + r.count, 0) ?? 0;
  const totalValue = rows?.reduce((s, r) => s + r.totalMinor, 0) ?? 0;

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Contract Status Summary</h1>
        <p className="text-sm text-gray-500 mt-0.5">Portfolio health snapshot — every contract, grouped by lifecycle status</p>
      </div>

      {rows && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatTile icon={FileText} label="Total contracts" value={String(totalCount)} color="blue" />
            <StatTile icon={PieChart} label="Total value" value={formatCurrency(totalValue)} color="emerald" />
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Status</TableHead><TableHead>Count</TableHead><TableHead>Total value</TableHead></TableRow></TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.status}>
                      <TableCell><span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(r.status)}`}>{r.status}</span></TableCell>
                      <TableCell>{r.count}</TableCell>
                      <TableCell>{formatCurrency(r.totalMinor)}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && <TableRow><TableCell colSpan={3} className="text-center py-6 text-gray-400">No contracts yet.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
