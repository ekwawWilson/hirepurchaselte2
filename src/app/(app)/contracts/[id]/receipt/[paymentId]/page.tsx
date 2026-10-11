'use client';

import { use } from 'react';
import { formatCurrency, formatDateTime, contractTypeLabel } from '@/lib/utils';
import { PrintDocument, Field } from '@/components/PrintDocument';
import { useContractDocument } from '@/lib/useContractDocument';
import { CHANNEL_LABELS, ENTRY_LABELS, customerPhone } from '@/lib/contractDocuments';

/** A receipt for one payment — for cash and for mobile money alike, whether or not a receipt number was issued. */
export default function PaymentReceiptPage({ params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const { id, paymentId } = use(params);
  const { contract: c, error, companyName } = useContractDocument(id);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!c) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;

  const p = c.payments.find((x) => x.id === paymentId);
  if (!p || p.status !== 'SUCCESS' || p.reversesPaymentId) return <p className="text-sm text-red-600">No receipt can be issued for this payment.</p>;

  const reference = p.receiptNumber ?? p.transactionRef;
  const when = formatDateTime(p.receivedAt ?? p.createdAt);
  const owedNow = c.contractType === 'DEVICE_LOAN' ? c.deviceLoanState?.totalOwedMinor ?? null : c.balanceMinor;
  const paidOut = p.entryType === 'WITHDRAWAL';
  const shareText = [
    `${companyName} — receipt ${reference}`,
    `${paidOut ? 'Paid out' : 'Received'}: ${formatCurrency(p.amountMinor)} on ${when}`,
    `Contract ${c.contractNumber}`,
    ...(owedNow !== null ? [`Balance now: ${formatCurrency(owedNow)}`] : []),
    'Thank you.',
  ].join('\n');

  return (
    <PrintDocument
      backHref={`/contracts/${c.id}`} title={paidOut ? 'Withdrawal receipt' : 'Payment receipt'} subtitle={`No. ${reference}`}
      share={{ phone: customerPhone(c.customer), text: shareText }}
    >
      {p.reversedById && (
        <p className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
          This payment was later reversed. This receipt is no longer valid.
        </p>
      )}

      <div className="rounded-xl border border-gray-200 px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-wide text-gray-500">{paidOut ? 'Amount paid out' : 'Amount received'}</p>
        <p className="mt-1 text-3xl font-bold">{formatCurrency(p.amountMinor)}</p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4">
        <Field label="Date">{when}</Field>
        <Field label={paidOut ? 'Paid to' : 'Received from'}>{c.customer.firstName} {c.customer.lastName}</Field>
        <Field label="Membership ID">{c.customer.membershipId}</Field>
        <Field label="Contract">{c.contractNumber} · {contractTypeLabel(c.contractType)}</Field>
        <Field label="For">{ENTRY_LABELS[p.entryType] ?? p.entryType}</Field>
        <Field label="Paid by">{CHANNEL_LABELS[p.channel] ?? p.channel}{p.mobileMoneyNetwork ? ` (${p.mobileMoneyNetwork})` : ''}</Field>
        <Field label="Reference">{p.transactionRef}</Field>
        <Field label={paidOut ? 'Paid out by' : 'Received by'}>{p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : 'Paid by the customer directly'}</Field>
        {p.notes && <Field label="Note">{p.notes}</Field>}
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 border-t border-gray-200 pt-4">
        <Field label="Paid on this contract so far">{formatCurrency(c.totalPaidMinor)}</Field>
        {owedNow !== null && <Field label={c.contractType === 'DEVICE_LOAN' ? 'Owed as of today' : 'Balance as of today'}>{formatCurrency(owedNow)}</Field>}
      </div>

      <p className="mt-8 text-xs text-gray-500">
        Thank you. Please keep this receipt{c.branch?.phone ? ` — questions to ${c.branch.phone}` : ''}.
      </p>
    </PrintDocument>
  );
}
