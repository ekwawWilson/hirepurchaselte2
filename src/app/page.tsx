'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/authStore';

export default function Home() {
  const router = useRouter();
  const { user, hydrate, isHydrated } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isHydrated) return;
    router.replace(user ? '/dashboard' : '/login');
  }, [isHydrated, user, router]);

  return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>;
}
