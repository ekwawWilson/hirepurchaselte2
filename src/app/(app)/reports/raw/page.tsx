'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { ReportLetterhead } from '@/components/ReportLetterhead';

/** Generic authenticated JSON viewer for report endpoints that don't have a dedicated page yet. */
export default function RawReportPage() {
  const searchParams = useSearchParams();
  const path = searchParams.get('path') ?? '';
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return;
    api.get(path).then(setData).catch((e) => setError(e instanceof ApiError ? e.message : 'Failed to load report'));
  }, [path]);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Report</h1>
        <p className="text-sm text-gray-500 mt-0.5 font-mono">{path}</p>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <Card>
        <CardContent className="p-4">
          <pre className="overflow-x-auto text-xs text-gray-700">{data ? JSON.stringify(data, null, 2) : 'Loading…'}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
