'use client';

import { useEffect, useState } from 'react';
import { Warehouse } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Row {
  productName: string; branchName: string;
  AVAILABLE: number; RESERVED: number; ISSUED: number; RETURNED: number; WRITTEN_OFF: number;
}

export default function InventoryPositionReportPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    api.get<{ report: Row[] }>('/reports/inventory-position')
      .then((r) => setRows(r.report))
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalUnits = rows?.reduce((s, r) => s + r.AVAILABLE + r.RESERVED + r.ISSUED + r.RETURNED + r.WRITTEN_OFF, 0) ?? 0;
  const totalAvailable = rows?.reduce((s, r) => s + r.AVAILABLE, 0) ?? 0;

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Inventory Position</h1>
        <p className="text-sm text-gray-500 mt-0.5">Stock levels per product per branch, by status</p>
      </div>

      {rows && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <StatTile icon={Warehouse} label="Total units" value={String(totalUnits)} color="blue" />
            <StatTile icon={Warehouse} label="Available now" value={String(totalAvailable)} color="emerald" />
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead><TableHead>Branch</TableHead><TableHead>Available</TableHead>
                    <TableHead>Reserved</TableHead><TableHead>Issued</TableHead><TableHead>Returned</TableHead><TableHead>Written off</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, idx) => (
                    <TableRow key={`${r.productName}-${r.branchName}-${idx}`}>
                      <TableCell className="font-medium text-gray-900">{r.productName}</TableCell>
                      <TableCell>{r.branchName}</TableCell>
                      <TableCell>{r.AVAILABLE}</TableCell>
                      <TableCell>{r.RESERVED}</TableCell>
                      <TableCell>{r.ISSUED}</TableCell>
                      <TableCell>{r.RETURNED}</TableCell>
                      <TableCell>{r.WRITTEN_OFF}</TableCell>
                    </TableRow>
                  ))}
                  {rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-6 text-gray-400">No inventory yet.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
