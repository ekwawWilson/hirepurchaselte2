import { createContext, use, useCallback, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { cacheCustomer, clearSession, getCachedCustomer, getToken, setToken } from './storage';
import type { Customer, OrgSettings } from './types';
import { APP_CONFIG } from '../constants/config';

/**
 * Who is signed in, and the company's public details. `isLoading` is true
 * only while the stored session is read at start-up (the splash stays up
 * meanwhile). A customer still on a temporary password from staff is held
 * on "Choose your password" until they set their own (mustChangePassword).
 */
interface SessionValue {
  customer: Customer | null;
  isLoading: boolean;
  org: OrgSettings;
  signIn: (phone: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshCustomer: () => Promise<void>;
  /** After a password change: the new token, and the customer no longer held. */
  passwordChanged: (token: string) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = use(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

const FALLBACK_ORG: OrgSettings = { companyName: APP_CONFIG.companyName, phone: null, address: null, email: null, logoUrl: null };

export function SessionProvider({ children }: PropsWithChildren) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [org, setOrg] = useState<OrgSettings>(FALLBACK_ORG);

  const signOut = useCallback(async () => {
    await clearSession();
    setCustomer(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => void signOut());
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  useEffect(() => {
    (async () => {
      const [token, cached] = await Promise.all([getToken(), getCachedCustomer()]);
      if (token && cached) setCustomer(cached);
      setIsLoading(false);
    })();
    api.orgSettings().then(setOrg).catch(() => undefined); // the fallback name serves until it loads
  }, []);

  const refreshCustomer = useCallback(async () => {
    const fresh = await api.me();
    await cacheCustomer(fresh);
    setCustomer(fresh);
  }, []);

  const value = useMemo<SessionValue>(() => ({
    customer,
    isLoading,
    org,
    signIn: async (phone, password) => {
      const { token, customer: signedIn } = await api.login(phone, password);
      await setToken(token);
      await cacheCustomer(signedIn);
      setCustomer(signedIn);
    },
    signOut,
    refreshCustomer,
    passwordChanged: async (token) => {
      await setToken(token);
      setCustomer((c) => {
        if (!c) return c;
        const next = { ...c, mustChangePassword: false };
        void cacheCustomer(next);
        return next;
      });
    },
  }), [customer, isLoading, org, signOut, refreshCustomer]);

  return <SessionContext value={value}>{children}</SessionContext>;
}
