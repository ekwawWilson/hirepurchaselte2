import { API_URL } from '../constants/config';
import { getToken } from './storage';
import type { Contract, ContractDetail, Customer, OrgSettings, Payment } from './types';

/**
 * Every call to the server goes through `request`: the customer's token is
 * added, a 30-second timeout applied, and an error body turned into an Error
 * whose message a screen can show as it is. A 401 means the session is over
 * (expired, or the password was changed elsewhere): the handler set by the
 * session (lib/session.tsx) signs the customer out, so no screen stays
 * signed in on a dead token.
 */

const TIMEOUT_MS = 30_000;
const OFFLINE_MESSAGE = 'Unable to connect to the server. Please check your internet connection.';

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false) {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(OFFLINE_MESSAGE, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) onUnauthorized?.();
    throw new ApiError(data?.error || data?.message || 'Something went wrong. Please try again.', res.status);
  }
  return data as T;
}

/** A list from the server, however it is wrapped; anything not a list reads as empty. */
const listOf = <T>(data: unknown, key: string): T[] => {
  const value = (data && typeof data === 'object' && key in data) ? (data as Record<string, unknown>)[key] : data;
  return Array.isArray(value) ? (value as T[]) : [];
};

export const api = {
  /** The company's public details (name, support phone, logo), before anyone signs in. */
  orgSettings: async () => (await request<{ settings: OrgSettings }>('GET', '/settings', undefined, { auth: false })).settings,

  login: (phone: string, password: string) =>
    request<{ token: string; customer: Customer }>('POST', '/portal/auth/login', { phone, password }, { auth: false }),
  requestReset: (phone: string) =>
    request<{ message: string }>('POST', '/portal/auth/password-reset/request', { phone }, { auth: false }),
  resetPassword: (phone: string, code: string, newPassword: string) =>
    request<{ message: string }>('POST', '/portal/auth/password-reset/reset', { phone, code, newPassword }, { auth: false }),

  me: async () => (await request<{ customer: Customer }>('GET', '/portal/me')).customer,
  /** Returns a fresh token: changing the password signs out every other session. */
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ token: string }>('POST', '/portal/me/password', { currentPassword, newPassword }),

  contracts: async () => listOf<Contract>(await request('GET', '/portal/contracts'), 'contracts'),
  contract: async (id: string) => (await request<{ contract: ContractDetail }>('GET', `/portal/contracts/${encodeURIComponent(id)}`)).contract,
  payments: async () => listOf<Payment>(await request('GET', '/portal/payments'), 'payments'),

  startPayment: (params: { contractId: string; amountMinor: number; network: string; msisdn: string }) =>
    request<{ reference: string; status: string }>('POST', '/portal/pay', params),
  paymentStatus: (reference: string) =>
    request<{ reference: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'NEEDS_REVIEW'; amountMinor: number; recorded: boolean }>('GET', `/portal/pay/${encodeURIComponent(reference)}`),
};
