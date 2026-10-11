'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import type { DocContract } from '@/lib/contractDocuments';

/** Loads one contract for a printable page, with the company details its letterhead needs. */
export function useContractDocument(id: string) {
  const [contract, setContract] = useState<DocContract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);
  const companyName = useOrgSettingsStore((s) => s.settings.companyName);

  useEffect(() => {
    void loadOrgSettings();
    api.get<{ contract: DocContract }>(`/contracts/${id}`)
      .then((r) => setContract(r.contract))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this contract'));
  }, [id, loadOrgSettings]);

  return { contract, error, companyName };
}
