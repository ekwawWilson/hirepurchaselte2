'use client';

import { use } from 'react';
import { formatCurrency, formatDate } from '@/lib/utils';
import { PrintDocument, Field } from '@/components/PrintDocument';
import { useContractDocument } from '@/lib/useContractDocument';
import { customerPhone } from '@/lib/contractDocuments';
import { AGREEMENT_TERMS, AGREEMENT_TITLES } from '@/lib/constants/agreementTerms';

/** Basis points as a percentage: 250 -> "2.5%". */
const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/**
 * The agreement the customer signs, filled in from the contract itself so
 * the figures on paper are the figures in the system. Printed and signed by
 * hand; the standard terms come from constants/agreementTerms.ts.
 */
export default function ContractAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { contract: c, error, companyName } = useContractDocument(id);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!c) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;

  const isInstalment = c.contractType === 'DEPOSIT_INSTALMENT';
  const isLoan = c.contractType === 'DEVICE_LOAN';
  const first = c.instalments[0];
  const last = c.instalments[c.instalments.length - 1];
  const frequency = c.paymentFrequency === 'DAILY' ? 'daily' : c.paymentFrequency === 'WEEKLY' ? 'weekly' : 'monthly';
  // "12 weekly of GHS 40" only when that is true of the schedule as it stands —
  // after a reschedule the instalments are no longer all one amount.
  const uniform = c.instalments.slice(0, -1).every((i) => i.amountDueMinor === first?.amountDueMinor);

  return (
    <PrintDocument backHref={`/contracts/${c.id}`} title={AGREEMENT_TITLES[c.contractType] ?? 'Agreement'} subtitle={`Contract ${c.contractNumber} · dated ${formatDate(c.startDate)}`}>
      <p className="text-sm leading-relaxed">
        This agreement is made between <strong>{companyName}</strong>{c.branch ? ` (${c.branch.name}${c.branch.address ? `, ${c.branch.address}` : ''})` : ''},
        called &ldquo;the Company&rdquo;, and the customer named below, called &ldquo;the Customer&rdquo;.
      </p>

      <h2 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">The Customer</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Field label="Full name">{c.customer.firstName} {c.customer.lastName}</Field>
        <Field label="Membership ID">{c.customer.membershipId}</Field>
        <Field label="Phone">{customerPhone(c.customer)}</Field>
        <Field label="National ID">{c.customer.nationalId}</Field>
        <Field label="Occupation">{c.customer.occupation}</Field>
        <Field label="Residential address">{c.customer.address}</Field>
        <Field label="Work address">{c.customer.workAddress}</Field>
        {!c.customer.guarantorName ? null : <Field label="Guarantor">{c.customer.guarantorName}{c.customer.guarantorPhone ? ` · ${c.customer.guarantorPhone}` : ''}</Field>}
      </div>

      <h2 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{isLoan ? 'The loan' : isInstalment ? 'The goods and the price' : 'The plan'}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 print-avoid-break">
        {c.product && <Field label="Goods">{c.product.name}</Field>}
        {c.inventoryItem && <Field label="Serial / IMEI">{c.inventoryItem.serialNumber}</Field>}
        {isInstalment && (
          <>
            <Field label="Total price">{formatCurrency(c.totalPayableMinor ?? 0)}</Field>
            <Field label="Deposit">{formatCurrency(c.depositAmountMinor)}</Field>
            <Field label="Balance by instalments">{formatCurrency((c.totalPayableMinor ?? 0) - c.depositAmountMinor)}</Field>
            <Field label="Instalments">{c.instalments.length} {frequency}{uniform && first ? ` of ${formatCurrency(first.amountDueMinor)}` : ', as set out in the schedule'}</Field>
            {first && <Field label="First instalment due">{formatDate(first.dueDate)}</Field>}
            {last && <Field label="Last instalment due">{formatDate(last.dueDate)}</Field>}
            <Field label="Grace period">{c.gracePeriodDays} day{c.gracePeriodDays === 1 ? '' : 's'}</Field>
            <Field label="Late-payment charge">{c.penaltyRateBps > 0 ? `${percent(c.penaltyRateBps)} of the late instalment, once` : 'None'}</Field>
            <Field label="How instalments are paid">{c.paymentMethod === 'CUSTOMER_INITIATED' ? 'By the Customer (cash or mobile money)' : c.paymentMethod === 'DIRECT_DEBIT' ? 'Direct debit from mobile money' : 'By the Customer; direct debit if overdue'}</Field>
          </>
        )}
        {isLoan && (
          <>
            <Field label="Loan amount">{formatCurrency(c.principalMinor ?? 0)}</Field>
            <Field label="Daily interest">{c.interestRateBps != null ? `${percent(c.interestRateBps)} of the loan amount per working day` : '—'}</Field>
            <Field label="Grace period before interest">{c.gracePeriodDays} day{c.gracePeriodDays === 1 ? '' : 's'}</Field>
          </>
        )}
        <Field label="Start date">{formatDate(c.startDate)}</Field>
      </div>

      {isInstalment && c.instalments.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Instalment schedule</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 text-sm">
            {c.instalments.map((i) => (
              <p key={i.id} className="flex justify-between border-b border-gray-100 py-1">
                <span className="text-gray-600">{i.instalmentNo}. {formatDate(i.dueDate)}</span>
                <span>{formatCurrency(i.amountDueMinor)}</span>
              </p>
            ))}
          </div>
        </>
      )}

      <h2 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Terms</h2>
      <ol className="list-decimal space-y-1.5 pl-7 text-sm leading-relaxed">
        {(AGREEMENT_TERMS[c.contractType] ?? []).map((term) => <li key={term}>{term}</li>)}
      </ol>

      <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-8 print-avoid-break">
        {['The Customer', ...(c.contractType === 'SAVE_TO_OWN' ? [] : ['The Guarantor']), `For ${companyName}`].map((party) => (
          <div key={party} className="text-sm">
            <div className="h-12 border-b border-gray-400" />
            <p className="mt-1.5 font-medium">{party}</p>
            <p className="text-xs text-gray-500">Name, signature and date</p>
          </div>
        ))}
      </div>
    </PrintDocument>
  );
}
