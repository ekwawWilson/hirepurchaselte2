'use client';

import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { api } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';

export interface TodaysPayment {
  id: string;
  amountMinor: number;
  channel: string;
  entryType: string;
  receiptNumber: string | null;
  createdAt: string;
  contract: {
    id: string;
    contractNumber: string;
    customer: { firstName: string; lastName: string; membershipId: string };
  };
}

export interface TodaysPayments {
  date: string;
  count: number;
  /** Only present for staff who can view reports. */
  totalMinor?: number;
  payments: TodaysPayment[];
}

const POLL_MS = 30_000;

// One copy of the data shared by the bell and the banner, so they never
// disagree and only one of them polls.
const useStore = create<{ data: TodaysPayments | null; set: (d: TodaysPayments) => void }>((set) => ({
  data: null,
  set: (data) => set({ data }),
}));

let subscribers = 0;
let timer: number | undefined;

/**
 * Today's payments, refreshed every 30 seconds while the tab is visible and
 * straight away when it becomes visible again — the legacy app's
 * useDailyPayments behaviour. Staff without "View payments" get nothing.
 */
export function useTodaysPayments() {
  const canView = useAuthStore((s) => s.hasPermission('payment.view'));
  const data = useStore((s) => s.data);
  const setData = useStore((s) => s.set);

  const load = useCallback(async () => {
    try {
      setData(await api.get<TodaysPayments>('/dashboard/todays-payments'));
    } catch {
      // Non-critical: the bell simply keeps its last figures.
    }
  }, [setData]);

  useEffect(() => {
    if (!canView) return;
    subscribers += 1;
    if (subscribers === 1) {
      void load();
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void load();
      }, POLL_MS);
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      subscribers -= 1;
      if (subscribers === 0) window.clearInterval(timer);
    };
  }, [canView, load]);

  return { data: canView ? data : null, refresh: load };
}
