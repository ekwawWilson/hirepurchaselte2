'use client';

import { useEffect, useState } from 'react';
import { portalApi, ApiError } from '@/lib/portalApi';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import type { DocContract } from '@/lib/contractDocuments';

/** The portal's counterpart to useContractDocument: one of the signed-in customer's own contracts, for a printable page. */
export function usePortalContractDocument(id: string) {
  const [contract, setContract] = useState<DocContract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);
  const companyName = useOrgSettingsStore((s) => s.settings.companyName);

  useEffect(() => {
    void loadOrgSettings();
    portalApi.get<{ contract: DocContract }>(`/contracts/${id}`)
      .then((r) => setContract(r.contract))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this contract'));
  }, [id, loadOrgSettings]);

  return { contract, error, companyName };
}
