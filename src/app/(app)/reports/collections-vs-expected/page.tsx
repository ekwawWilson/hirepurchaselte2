'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Scale } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { ReportDateFilter, today } from '@/components/ReportDateFilter';
import { StatTile } from '@/components/StatTile';
import { formatCurrency } from '@/lib/utils';

interface Report {
  range: { start: string; end: string };
  expectedMinor: number;
  collectedMinor: number;
  varianceMinor: number;
}

export default function CollectionsVsExpectedReportPage() {
  const { toast } = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [report, setReport] = useState<Report | null>(null);

  async function load() {
    try {
      setReport(await api.get<Report>(`/reports/collections-vs-expected?from=${from}&to=${to}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shortfall = report && report.varianceMinor < 0;

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Collections vs Expected</h1>
        <p className="text-sm text-gray-500 mt-0.5">What was due against what was actually collected in the range</p>
      </div>

      <ReportDateFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onRefresh={load} />

      {report && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatTile icon={Scale} label="Expected" value={formatCurrency(report.expectedMinor)} color="blue" />
          <StatTile icon={TrendingUp} label="Collected" value={formatCurrency(report.collectedMinor)} color="emerald" />
          <StatTile
            icon={shortfall ? TrendingDown : TrendingUp}
            label="Variance"
            value={formatCurrency(report.varianceMinor)}
            color={shortfall ? 'red' : 'emerald'}
            caption={shortfall ? 'Shortfall' : 'At or above target'}
          />
        </div>
      )}
    </div>
  );
}
