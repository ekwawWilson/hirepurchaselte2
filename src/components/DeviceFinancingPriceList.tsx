'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/apiClient';
import { formatCurrency } from '@/lib/utils';
import { planInstalmentMinor } from '@/lib/constants/deviceFinancing';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

interface Plan { months: number; totalPriceMinor: number; depositMinor: number }
interface PricedPhone { id: string; name: string; financingPlans: Plan[] }

/** Every Device Financing phone's plans, as agents sell them: read from the same plans the sale form uses. */
export function DeviceFinancingPriceList() {
  const [phones, setPhones] = useState<PricedPhone[] | null>(null);
  useEffect(() => {
    api.get<{ products: PricedPhone[] }>('/price-chart/device-financing').then((r) => setPhones(r.products)).catch(() => setPhones([]));
  }, []);
  if (!phones || phones.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle>Device Financing plans</CardTitle>
        <Button size="sm" variant="outline" className="print:hidden" onClick={() => window.print()}>Print</Button>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Phone</TableHead><TableHead>Plan</TableHead><TableHead>Total</TableHead><TableHead>Deposit</TableHead>
              <TableHead>Daily</TableHead><TableHead>Weekly</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {phones.flatMap((p) => p.financingPlans.map((plan, i) => (
              <TableRow key={`${p.id}-${plan.months}`}>
                <TableCell className="font-medium">{i === 0 ? p.name : ''}</TableCell>
                <TableCell>{plan.months} months</TableCell>
                <TableCell>{formatCurrency(plan.totalPriceMinor)}</TableCell>
                <TableCell>{formatCurrency(plan.depositMinor)}</TableCell>
                <TableCell>{formatCurrency(planInstalmentMinor(plan, 'DAILY'))}</TableCell>
                <TableCell>{formatCurrency(planInstalmentMinor(plan, 'WEEKLY'))}</TableCell>
              </TableRow>
            )))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
