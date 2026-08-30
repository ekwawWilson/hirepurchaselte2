'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate } from '@/lib/utils';

interface Row {
  contractNumber: string; customerName: string; instalmentNo: number;
  dueDate: string; daysPastDue: number; outstandingMinor: number; bucket: string;
}
interface Report { buckets: Record<string, number>; rows: Row[] }

const BUCKETS = ['1-30', '31-60', '61-90', '90+'] as const;
const BUCKET_COLOR: Record<string, 'amber' | 'red'> = { '1-30': 'amber', '31-60': 'amber', '61-90': 'red', '90+': 'red' };

export default function ArrearsAgeingReportPage() {
  const { toast } = useToast();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    api.get<Report>('/reports/arrears-ageing')
      .then(setReport)
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Arrears Ageing</h1>
        <p className="text-sm text-gray-500 mt-0.5">Overdue instalments bucketed by days past due — 1-30 / 31-60 / 61-90 / 90+</p>
      </div>

      {report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {BUCKETS.map((b) => (
              <StatTile key={b} icon={AlertTriangle} label={`${b} days`} value={formatCurrency(report.buckets[b] ?? 0)} color={BUCKET_COLOR[b]} />
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Contract</TableHead><TableHead>Customer</TableHead><TableHead>Instalment</TableHead><TableHead>Due date</TableHead><TableHead>Days past due</TableHead><TableHead>Outstanding</TableHead><TableHead>Bucket</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {report.rows.map((r, idx) => (
                    <TableRow key={`${r.contractNumber}-${r.instalmentNo}-${idx}`}>
                      <TableCell className="font-mono text-xs">{r.contractNumber}</TableCell>
                      <TableCell className="font-medium text-gray-900">{r.customerName}</TableCell>
                      <TableCell>#{r.instalmentNo}</TableCell>
                      <TableCell>{formatDate(r.dueDate)}</TableCell>
                      <TableCell>{r.daysPastDue}</TableCell>
                      <TableCell>{formatCurrency(r.outstandingMinor)}</TableCell>
                      <TableCell><Badge variant={r.bucket === '90+' || r.bucket === '61-90' ? 'destructive' : 'secondary'}>{r.bucket}</Badge></TableCell>
                    </TableRow>
                  ))}
                  {report.rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-6 text-gray-400">No arrears — nothing overdue.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
