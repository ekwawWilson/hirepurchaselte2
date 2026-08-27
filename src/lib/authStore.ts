'use client';

import { create } from 'zustand';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  branchId: string | null;
  role: string;
  permissions: string[];
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isHydrated: boolean;
  setAuth: (user: AuthUser, token: string) => void;
  clearAuth: () => void;
  hydrate: () => void;
  hasPermission: (...perms: string[]) => boolean;
}

const STORAGE_KEY = 'hplite.auth';

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  isHydrated: false,

  setAuth: (user, token) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token }));
    } catch {
      // localStorage unavailable — auth still works for this tab via in-memory state.
    }
    set({ user, token });
  },

  clearAuth: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    set({ user: null, token: null });
  },

  hydrate: () => {
    if (get().isHydrated) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { user, token } = JSON.parse(raw);
        set({ user, token });
      }
    } catch {
      // ignore corrupted/unavailable storage
    }
    set({ isHydrated: true });
  },

  hasPermission: (...perms: string[]) => {
    const user = get().user;
    if (!user) return false;
    if (user.role === 'SUPER_ADMIN') return true;
    return perms.some((p) => user.permissions.includes(p));
  },
}));
