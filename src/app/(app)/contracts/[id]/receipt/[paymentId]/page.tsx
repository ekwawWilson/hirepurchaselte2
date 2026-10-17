'use client';

import { use } from 'react';
import { useContractDocument } from '@/lib/useContractDocument';
import { ReceiptDocument } from '@/components/documents/ReceiptDocument';

export default function PaymentReceiptPage({ params }: { params: Promise<{ id: string; paymentId: string }> }) {
  const { id, paymentId } = use(params);
  const { contract, error, companyName } = useContractDocument(id);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!contract) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  return <ReceiptDocument contract={contract} paymentId={paymentId} companyName={companyName} backHref={`/contracts/${contract.id}`} share />;
}
