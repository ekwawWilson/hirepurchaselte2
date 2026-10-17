'use client';

import { use } from 'react';
import { useContractDocument } from '@/lib/useContractDocument';
import { StatementDocument } from '@/components/documents/StatementDocument';

export default function ContractStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { contract, error, companyName } = useContractDocument(id);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!contract) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  return <StatementDocument contract={contract} companyName={companyName} backHref={`/contracts/${contract.id}`} share />;
}
