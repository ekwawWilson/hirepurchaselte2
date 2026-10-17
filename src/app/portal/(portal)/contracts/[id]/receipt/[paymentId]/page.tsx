'use client';

import { use } from 'react';
import { usePortalContractDocument } from '@/lib/usePortalContractDocument';
import { ReceiptDocument } from '@/components/documents/ReceiptDocument';

/** A receipt for one of the customer's own payments, to print or save as PDF. */
export default function PortalReceiptPage({ params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const { id, paymentId } = use(params);
  const { contract, error, companyName } = usePortalContractDocument(id);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!contract) return <div className="flex justify-center py-16"><div className="h-8 w-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin" /></div>;
  return <ReceiptDocument contract={contract} paymentId={paymentId} companyName={companyName} backHref={`/portal/contracts/${contract.id}`} />;
}
