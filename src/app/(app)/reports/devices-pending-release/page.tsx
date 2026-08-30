'use client';

import { useEffect, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, formatDate } from '@/lib/utils';

interface Row {
  id: string; contractNumber: string; totalPayableMinor: number; completedAt: string | null;
  customer: { firstName: string; lastName: string; phone: string | null; phone2: string | null; phone3: string | null };
  inventoryItem: { serialNumber: string } | null;
}

export default function DevicesPendingReleaseReportPage() {
  const { toast } = useToast();
  const [contracts, setContracts] = useState<Row[] | null>(null);

  useEffect(() => {
    api.get<{ contracts: Row[] }>('/reports/devices-pending-release')
      .then((r) => setContracts(r.contracts))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Devices Pending Release</h1>
        <p className="text-sm text-gray-500 mt-0.5">Fully-paid Save to Own contracts waiting for the device to be handed over</p>
      </div>

      {contracts && (
        <>
          <StatTile icon={PackageCheck} label="Awaiting hand-over" value={String(contracts.length)} color="amber" />

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Contract</TableHead><TableHead>Customer</TableHead><TableHead>Phone</TableHead><TableHead>Serial/IMEI</TableHead><TableHead>Total Payable</TableHead><TableHead>Paid off</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {contracts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{c.contractNumber}</TableCell>
                      <TableCell className="font-medium text-gray-900">{c.customer.firstName} {c.customer.lastName}</TableCell>
                      <TableCell>{c.customer.phone ?? c.customer.phone2 ?? c.customer.phone3 ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{c.inventoryItem?.serialNumber ?? '—'}</TableCell>
                      <TableCell>{formatCurrency(c.totalPayableMinor)}</TableCell>
                      <TableCell>{formatDate(c.completedAt)}</TableCell>
                    </TableRow>
                  ))}
                  {contracts.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-6 text-gray-400">Nothing pending release.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
