'use client';

import { useCallback, useEffect, useState } from 'react';
import { Users, Wallet, HandCoins, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { ReportDateFilter, today } from '@/components/ReportDateFilter';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatCurrency, cn } from '@/lib/utils';
import { AGENT_CASH_HOLD_ALERT_DAYS } from '@/lib/constants/agents';

interface Row {
  agentId: string; name: string; branchName: string | null; isActive: boolean;
  submitted: number; approved: number; sentBack: number; cancelled: number; awaitingDecision: number;
  cashCollectedMinor: number; commissionEarnedMinor: number; agentOwesMinor: number; owedToAgentMinor: number;
  longestHeldDays: number | null; liveContracts: number; contractsInArrears: number; overdueMinor: number;
  completed: number; avgHoursToApproval: number | null; par30Percent: number;
}
interface Report {
  rows: Row[];
  totals: { submitted: number; approved: number; completed: number; cashCollectedMinor: number; commissionEarnedMinor: number; agentOwesMinor: number; owedToAgentMinor: number; overdueMinor: number };
}

const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };

/** Each agent's sales, cash, commission and how their customers are paying (agentReportService.ts). */
export default function AgentPerformanceReportPage() {
  const { toast } = useToast();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<Report | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await api.get<Report>(`/reports/agent-performance?from=${from}&to=${to}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Agent Performance</h1>
        <p className="text-sm text-gray-500 mt-0.5">What each agent brought in during the range, the cash and commission involved, and how their customers are paying now</p>
      </div>

      <ReportDateFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onRefresh={load} />

      {report && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile icon={Users} label="Contracts approved" value={`${report.totals.approved} of ${report.totals.submitted} submitted`} color="blue" />
            <StatTile icon={HandCoins} label="Commission earned" value={formatCurrency(report.totals.commissionEarnedMinor)} color="emerald" />
            <StatTile icon={Wallet} label="Cash agents still hold" value={formatCurrency(report.totals.agentOwesMinor)} color="amber" />
            <StatTile icon={AlertTriangle} label="Overdue on agents' contracts" value={formatCurrency(report.totals.overdueMinor)} color="red" />
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              {report.rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-gray-500">No agents.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Submitted</TableHead>
                      <TableHead className="text-right">Approved</TableHead>
                      <TableHead className="text-right">Hours to approve</TableHead>
                      <TableHead className="text-right">Sent back</TableHead>
                      <TableHead className="text-right">Cancelled</TableHead>
                      <TableHead className="text-right">Completed</TableHead>
                      <TableHead className="text-right">Cash collected</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Holding now</TableHead>
                      <TableHead className="text-right">Owed to agent</TableHead>
                      <TableHead className="text-right">In arrears</TableHead>
                      <TableHead className="text-right">PAR30</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.rows.map((r) => (
                      <TableRow key={r.agentId}>
                        <TableCell>
                          <p className="font-medium text-gray-900">{r.name}{!r.isActive && <span className="ml-1.5 text-xs font-normal text-gray-400">(inactive)</span>}</p>
                          <p className="text-xs text-gray-500">{r.branchName ?? 'No branch'}{r.awaitingDecision > 0 && ` · ${r.awaitingDecision} awaiting a decision`}</p>
                        </TableCell>
                        <TableCell className="text-right">{r.submitted}</TableCell>
                        <TableCell className="text-right">{r.approved}</TableCell>
                        <TableCell className="text-right">{r.avgHoursToApproval ?? '—'}</TableCell>
                        <TableCell className="text-right">{r.sentBack}</TableCell>
                        <TableCell className="text-right">{r.cancelled}</TableCell>
                        <TableCell className="text-right">{r.completed}</TableCell>
                        <TableCell className="text-right">{formatCurrency(r.cashCollectedMinor)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(r.commissionEarnedMinor)}</TableCell>
                        <TableCell className={cn('text-right', r.longestHeldDays !== null && r.longestHeldDays >= AGENT_CASH_HOLD_ALERT_DAYS && 'text-red-600 font-semibold')}>
                          {formatCurrency(r.agentOwesMinor)}
                          {r.longestHeldDays !== null && <span className="block text-xs font-normal">up to {r.longestHeldDays} day{r.longestHeldDays === 1 ? '' : 's'}</span>}
                        </TableCell>
                        <TableCell className="text-right">{formatCurrency(r.owedToAgentMinor)}</TableCell>
                        <TableCell className="text-right">
                          {r.contractsInArrears} of {r.liveContracts}
                          {r.overdueMinor > 0 && <span className="block text-xs text-red-600">{formatCurrency(r.overdueMinor)}</span>}
                        </TableCell>
                        <TableCell className={cn('text-right', r.par30Percent > 0 && 'text-red-600')}>{r.par30Percent}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <p className="text-xs text-gray-500">
            Submitted, approved, hours to approve, sent back, cancelled, completed, cash collected and commission are for the dates chosen.
            Holding now, owed to the agent, arrears and PAR30 (share of what customers owe that is over 30 days behind) are as of today. Cash held {AGENT_CASH_HOLD_ALERT_DAYS} days or more is shown in red.
          </p>
        </>
      )}
    </div>
  );
}
