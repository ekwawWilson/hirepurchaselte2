'use client';

import { useEffect } from 'react';

/**
 * Registers public/sw.js. Browsers only allow service workers on a secure
 * page (HTTPS or localhost), and in development a service worker would get
 * in the way of hot reloading, so both cases are skipped.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((e) => {
      console.error('[pwa] service worker registration failed:', e);
    });
  }, []);
  return null;
}
