'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency } from '@/lib/utils';

interface AgentRisk {
  agentId: string; agentName: string; contracts: number; outstandingMinor: number;
  par30Contracts: number; par30Minor: number; par30Percent: number;
  par1Contracts: number; par1Minor: number; par1Percent: number;
}
interface Report { agents: AgentRisk[]; limit: { thresholdPercent: number; minContracts: number } | null }

/**
 * Portfolio at risk per agent: the share of what their customers owe on
 * contracts more than 30 days behind (PAR30), and behind at all (PAR1). The
 * same figures the sale limit (Settings > Controls) uses.
 */
export default function PortfolioRiskReportPage() {
  const { toast } = useToast();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    api.get<Report>('/reports/portfolio-risk')
      .then(setReport)
      .catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const overLimit = (a: AgentRisk) => !!report?.limit && a.contracts >= report.limit.minContracts && a.par30Percent > report.limit.thresholdPercent;

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Portfolio at Risk</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Per agent: the share of what their customers owe on contracts more than 30 days behind (PAR30), and behind at all (PAR1).
          {report?.limit
            ? ` Agents over ${report.limit.thresholdPercent}% PAR30, with at least ${report.limit.minContracts} contracts, cannot make new sales.`
            : ' No PAR sale limit is set (Settings > Controls).'}
        </p>
      </div>
      {report && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead><TableHead>Contracts</TableHead><TableHead>Owed</TableHead>
                  <TableHead>PAR30</TableHead><TableHead>30+ days behind</TableHead><TableHead>PAR1</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.agents.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-gray-400 py-8">No agents</TableCell></TableRow>
                )}
                {report.agents.map((a) => (
                  <TableRow key={a.agentId}>
                    <TableCell className="font-medium text-gray-900">
                      {a.agentName}
                      {overLimit(a) && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">sales stopped</span>}
                    </TableCell>
                    <TableCell>{a.contracts}</TableCell>
                    <TableCell>{formatCurrency(a.outstandingMinor)}</TableCell>
                    <TableCell className={a.par30Percent >= (report.limit?.thresholdPercent ?? 20) ? 'font-semibold text-red-700' : ''}>{a.par30Percent}%</TableCell>
                    <TableCell>{formatCurrency(a.par30Minor)} <span className="text-xs text-gray-500">({a.par30Contracts})</span></TableCell>
                    <TableCell>{a.par1Percent}% <span className="text-xs text-gray-500">({a.par1Contracts})</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
