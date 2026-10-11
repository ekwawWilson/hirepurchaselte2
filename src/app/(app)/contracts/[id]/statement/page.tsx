'use client';

import { use, useMemo } from 'react';
import { formatCurrency, formatDate, contractTypeLabel } from '@/lib/utils';
import { PrintDocument, Field } from '@/components/PrintDocument';
import { useContractDocument } from '@/lib/useContractDocument';
import { CHANNEL_LABELS, ENTRY_LABELS, customerPhone, nextInstalment, overdueMinor, type DocContract } from '@/lib/contractDocuments';

/** The short text version of a statement that goes to the customer's WhatsApp. */
function summaryText(c: DocContract, companyName: string, today: string): string {
  const lines = [`${companyName} — statement for ${c.contractNumber} as at ${today}`, `Paid so far: ${formatCurrency(c.totalPaidMinor)}`];
  if (c.contractType === 'DEVICE_LOAN' && c.deviceLoanState) {
    lines.push(`Owed now: ${formatCurrency(c.deviceLoanState.totalOwedMinor)}`);
  } else if (c.balanceMinor !== null) {
    lines.push(`Balance: ${formatCurrency(c.balanceMinor)}`);
    const overdue = overdueMinor(c);
    if (overdue > 0) lines.push(`Overdue: ${formatCurrency(overdue)}`);
    const next = nextInstalment(c);
    if (next) lines.push(`Next payment: ${formatCurrency(next.amountDueMinor - next.amountPaidMinor)} due ${formatDate(next.dueDate)}`);
  }
  return lines.join('\n');
}

export default function ContractStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { contract: c, error, companyName } = useContractDocument(id);
  const today = useMemo(() => formatDate(new Date()), []);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!c) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;

  const overdue = overdueMinor(c);
  // Oldest first, as a statement reads; reversal rows shown as money going back out.
  const ledger = c.payments.filter((p) => p.status === 'SUCCESS').slice().reverse();

  return (
    <PrintDocument
      backHref={`/contracts/${c.id}`} title="Statement of account" subtitle={`As at ${today}`}
      share={{ phone: customerPhone(c.customer), text: summaryText(c, companyName, today) }}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Field label="Customer">{c.customer.firstName} {c.customer.lastName}</Field>
        <Field label="Membership ID">{c.customer.membershipId}</Field>
        <Field label="Phone">{customerPhone(c.customer)}</Field>
        <Field label="Contract">{c.contractNumber}</Field>
        <Field label="Type">{contractTypeLabel(c.contractType)}</Field>
        <Field label="Status">{c.status.replace(/_/g, ' ')}</Field>
        {c.product && <Field label="Item">{c.product.name}{c.inventoryItem ? ` (${c.inventoryItem.serialNumber})` : ''}</Field>}
        <Field label="Started">{formatDate(c.startDate)}</Field>
        {c.branch && <Field label="Branch">{c.branch.name}</Field>}
      </div>

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 print-avoid-break">
        {c.contractType === 'DEVICE_LOAN' && c.deviceLoanState ? (
          <>
            <Total label="Loan amount" value={c.deviceLoanState.principalMinor} />
            <Total label="Interest paid" value={c.deviceLoanState.interestPaidMinor} />
            <Total label="Interest owed" value={c.deviceLoanState.accruedInterestMinor} />
            <Total label="Total owed now" value={c.deviceLoanState.totalOwedMinor} strong />
          </>
        ) : c.totalPayableMinor === null ? (
          <Total label="Total saved" value={c.totalPaidMinor} strong />
        ) : (
          <>
            <Total label="Total price" value={c.totalPayableMinor} />
            <Total label="Paid so far" value={c.totalPaidMinor} />
            <Total label="Balance" value={c.balanceMinor ?? 0} strong />
            <Total label="Overdue" value={overdue} alert={overdue > 0} />
          </>
        )}
      </div>

      {c.instalments.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Instalment schedule</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
                <th className="py-1.5 pr-2 font-medium">No.</th><th className="py-1.5 pr-2 font-medium">Due</th>
                <th className="py-1.5 pr-2 font-medium text-right">Amount</th><th className="py-1.5 pr-2 font-medium text-right">Paid</th>
                <th className="py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {c.instalments.map((i) => (
                <tr key={i.id} className="border-b border-gray-100">
                  <td className="py-1.5 pr-2">{i.instalmentNo}</td>
                  <td className="py-1.5 pr-2">{formatDate(i.dueDate)}</td>
                  <td className="py-1.5 pr-2 text-right">{formatCurrency(i.amountDueMinor)}</td>
                  <td className="py-1.5 pr-2 text-right">{formatCurrency(i.amountPaidMinor)}</td>
                  <td className="py-1.5">{i.status.charAt(0) + i.status.slice(1).toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Payments</h2>
      {ledger.length === 0 ? (
        <p className="text-sm text-gray-500">No payments have been made on this contract.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
              <th className="py-1.5 pr-2 font-medium">Date</th><th className="py-1.5 pr-2 font-medium">For</th>
              <th className="py-1.5 pr-2 font-medium">Paid by</th><th className="py-1.5 pr-2 font-medium">Receipt</th>
              <th className="py-1.5 font-medium text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((p) => {
              const out = !!p.reversesPaymentId !== (p.entryType === 'WITHDRAWAL'); // a reversal, or a withdrawal — but not a reversed withdrawal
              return (
                <tr key={p.id} className="border-b border-gray-100">
                  <td className="py-1.5 pr-2">{formatDate(p.receivedAt ?? p.createdAt)}</td>
                  <td className="py-1.5 pr-2">{ENTRY_LABELS[p.entryType] ?? p.entryType}{p.reversesPaymentId ? ' — reversed' : ''}</td>
                  <td className="py-1.5 pr-2">{CHANNEL_LABELS[p.channel] ?? p.channel}</td>
                  <td className="py-1.5 pr-2 font-mono text-xs">{p.receiptNumber ?? '—'}</td>
                  <td className="py-1.5 text-right">{out ? '−' : ''}{formatCurrency(p.amountMinor)}</td>
                </tr>
              );
            })}
            <tr className="font-semibold">
              <td className="py-2 pr-2" colSpan={4}>Paid so far</td>
              <td className="py-2 text-right">{formatCurrency(c.totalPaidMinor)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <p className="mt-8 text-xs text-gray-500">
        This statement shows the account as recorded on {today}. If anything on it does not match your own records, please contact us
        {c.branch?.phone ? ` on ${c.branch.phone}` : ''}.
      </p>
    </PrintDocument>
  );
}

function Total({ label, value, strong, alert }: { label: string; value: number; strong?: boolean; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-gray-500 truncate">{label}</p>
      <p className={`truncate ${strong ? 'text-base font-bold' : 'text-sm font-semibold'} ${alert ? 'text-red-600' : 'text-gray-900'}`}>{formatCurrency(value)}</p>
    </div>
  );
}
