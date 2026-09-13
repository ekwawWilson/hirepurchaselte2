'use client';

import { ApiError } from './apiClient';
import { useCustomerAuthStore } from './customerAuthStore';

/**
 * The portal's counterpart to apiClient.ts — same shape, but it sends the
 * customer's own token and talks to /api/portal, which is the only part of
 * the API a customer token can reach.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = useCustomerAuthStore.getState().token;
  const res = await fetch(`/api/portal${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) useCustomerAuthStore.getState().clearAuth();
    throw new ApiError(res.status, data.error || `Request failed with status ${res.status}`);
  }
  return data as T;
}

export const portalApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};

export { ApiError };
