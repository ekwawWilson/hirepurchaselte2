'use client';

import { create } from 'zustand';

export interface PortalCustomer {
  id: string;
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  mustChangePassword: boolean;
}

interface PortalAuthState {
  customer: PortalCustomer | null;
  token: string | null;
  isHydrated: boolean;
  setAuth: (customer: PortalCustomer, token: string) => void;
  setCustomer: (customer: PortalCustomer) => void;
  clearAuth: () => void;
  hydrate: () => void;
}

// Deliberately a different key from the staff app's 'hplite.auth': a shared
// browser can hold both sessions, and neither token works on the other's
// routes anyway (auth/jwt.ts).
const STORAGE_KEY = 'hplite.portal';

export const useCustomerAuthStore = create<PortalAuthState>((set, get) => ({
  customer: null,
  token: null,
  isHydrated: false,

  setAuth: (customer, token) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ customer, token }));
    } catch {
      // localStorage unavailable — the session still works in this tab.
    }
    set({ customer, token });
  },

  setCustomer: (customer) => {
    const { token } = get();
    try {
      if (token) localStorage.setItem(STORAGE_KEY, JSON.stringify({ customer, token }));
    } catch {
      // ignore
    }
    set({ customer });
  },

  clearAuth: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    set({ customer: null, token: null });
  },

  hydrate: () => {
    if (get().isHydrated) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { customer, token } = JSON.parse(raw);
        set({ customer, token });
      }
    } catch {
      // ignore corrupted/unavailable storage
    }
    set({ isHydrated: true });
  },
}));
