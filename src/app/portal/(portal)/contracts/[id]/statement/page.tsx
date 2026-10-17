'use client';

import { use } from 'react';
import { usePortalContractDocument } from '@/lib/usePortalContractDocument';
import { StatementDocument } from '@/components/documents/StatementDocument';

/** The customer's own statement of account, to print or save as PDF. */
export default function PortalStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { contract, error, companyName } = usePortalContractDocument(id);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!contract) return <div className="flex justify-center py-16"><div className="h-8 w-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin" /></div>;
  return <StatementDocument contract={contract} companyName={companyName} backHref={`/portal/contracts/${contract.id}`} />;
}
