'use client';

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { ReportDateFilter, today } from '@/components/ReportDateFilter';
import { StatTile } from '@/components/StatTile';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatDate } from '@/lib/utils';

interface Customer {
  id: string; membershipId: string; firstName: string; lastName: string;
  phone: string | null; phone2: string | null; phone3: string | null; createdAt: string;
  createdBy: { firstName: string; lastName: string } | null;
}
interface Report {
  count: number;
  byUser: Array<{ userId: string; name: string; count: number }>;
  customers: Customer[];
}

export default function CustomerRegistrationsReportPage() {
  const { toast } = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<Report | null>(null);

  async function load() {
    try {
      setReport(await api.get<Report>(`/reports/customer-registrations?from=${from}&to=${to}`));
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
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Customer Registrations</h1>
        <p className="text-sm text-gray-500 mt-0.5">New customer sign-ups in range, by staff member</p>
      </div>

      <ReportDateFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onRefresh={load} />

      {report && (
        <>
          <StatTile icon={UserPlus} label="New customers" value={String(report.count)} color="blue" />

          <Card>
            <CardHeader><CardTitle>By staff member</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Staff</TableHead><TableHead>Count</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.byUser.map((r) => (
                    <TableRow key={r.userId}>
                      <TableCell className="font-medium text-gray-900">{r.name}</TableCell>
                      <TableCell>{r.count}</TableCell>
                    </TableRow>
                  ))}
                  {report.byUser.length === 0 && <TableRow><TableCell colSpan={2} className="text-center py-6 text-gray-400">No registrations in this range.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Customers</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Membership ID</TableHead><TableHead>Name</TableHead><TableHead>Phone</TableHead><TableHead>Registered</TableHead><TableHead>By</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.customers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.membershipId}</TableCell>
                      <TableCell className="font-medium text-gray-900">{c.firstName} {c.lastName}</TableCell>
                      <TableCell>{c.phone ?? c.phone2 ?? c.phone3 ?? '—'}</TableCell>
                      <TableCell>{formatDate(c.createdAt)}</TableCell>
                      <TableCell>{c.createdBy ? `${c.createdBy.firstName} ${c.createdBy.lastName}` : '—'}</TableCell>
                    </TableRow>
                  ))}
                  {report.customers.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-gray-400">No registrations in this range.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
