'use client';

import { useEffect, useState, Fragment } from 'react';
import { ShieldAlert, History } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { ReportDateFilter, today } from '@/components/ReportDateFilter';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatDateTime } from '@/lib/utils';

interface Entry {
  id: string; action: string; entityType: string; entityId: string | null; entityName: string | null;
  oldValues: string | null; newValues: string | null; createdAt: string;
  user: { firstName: string; lastName: string; email: string } | null;
}

function prettyJson(raw: string | null): string | null {
  if (!raw) return null;
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

export default function AuditTrailReportPage() {
  const canView = useAuthStore((s) => s.hasPermission('audit.view'));
  const { toast } = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.get<{ entries: Entry[] }>(`/reports/audit-trail?from=${from}&to=${to}`);
      setEntries(r.entries);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load report', variant: 'destructive' });
    }
  }

  useEffect(() => {
    if (canView) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  if (!canView) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">User Activity / Audit Trail</h1>
          <p className="text-sm text-gray-500 mt-0.5">Who did what, when</p>
        </div>
        <Card>
          <CardContent className="text-center py-12 px-4">
            <ShieldAlert className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">You don&apos;t have permission to view the audit trail.</p>
            <p className="text-xs text-gray-400 mt-1">This report requires the audit.view permission (Auditors and Super Admins).</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">User Activity / Audit Trail</h1>
        <p className="text-sm text-gray-500 mt-0.5">Every recorded action in range — capped at 500 rows, not branch-scoped</p>
      </div>

      <ReportDateFilter from={from} to={to} onFromChange={setFrom} onToChange={setTo} onRefresh={load} />

      {entries && (
        <>
          <StatTile icon={History} label="Entries in range" value={String(entries.length)} color="blue" />

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>Action</TableHead><TableHead>Entity</TableHead><TableHead /></TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((e) => (
                    <Fragment key={e.id}>
                      <TableRow className="cursor-pointer hover:bg-gray-50" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                        <TableCell className="text-gray-500">{formatDateTime(e.createdAt)}</TableCell>
                        <TableCell>{e.user ? `${e.user.firstName} ${e.user.lastName}` : 'System'}</TableCell>
                        <TableCell className="font-medium text-gray-900">{e.action}</TableCell>
                        <TableCell className="text-xs">
                          {e.entityName ? (
                            <>{e.entityType} · <span className="font-medium text-gray-900">{e.entityName}</span></>
                          ) : (
                            <span className="font-mono">{e.entityType}{e.entityId ? ` · ${e.entityId.slice(0, 8)}…` : ''}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-primary">{expanded === e.id ? 'Hide' : 'Details'}</TableCell>
                      </TableRow>
                      {expanded === e.id && (e.oldValues || e.newValues) && (
                        <TableRow>
                          <TableCell colSpan={5} className="bg-gray-50">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 py-2">
                              {e.oldValues && (
                                <div>
                                  <p className="text-xs font-semibold text-gray-500 mb-1">Before</p>
                                  <pre className="text-xs bg-white ring-1 ring-black/5 rounded-lg p-2 overflow-x-auto">{prettyJson(e.oldValues)}</pre>
                                </div>
                              )}
                              {e.newValues && (
                                <div>
                                  <p className="text-xs font-semibold text-gray-500 mb-1">After</p>
                                  <pre className="text-xs bg-white ring-1 ring-black/5 rounded-lg p-2 overflow-x-auto">{prettyJson(e.newValues)}</pre>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                  {entries.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-gray-400">No activity in this range.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
