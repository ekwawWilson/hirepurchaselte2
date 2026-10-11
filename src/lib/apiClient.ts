'use client';

import { useAuthStore } from './authStore';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401) useAuthStore.getState().clearAuth();
    // An administrator reset this account's password while it was signed in
    // here: show the "choose your own password" screen now (AppShell), rather
    // than a working-looking app whose every request is refused.
    if (res.status === 403 && data.code === 'PASSWORD_CHANGE_REQUIRED') {
      const { user, setAuth } = useAuthStore.getState();
      if (user && token && !user.mustChangePassword) setAuth({ ...user, mustChangePassword: true }, token);
    }
    throw new ApiError(res.status, data.error || `Request failed with status ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
