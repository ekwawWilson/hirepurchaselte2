'use client';

import { useAuthStore } from '@/lib/authStore';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';

export default function AccountPage() {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="space-y-5 max-w-xl">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My account</h1>
        <p className="text-sm text-gray-500 mt-0.5">{user?.firstName} {user?.lastName} &middot; {user?.email}</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Change password</CardTitle></CardHeader>
        <CardContent>
          <ChangePasswordForm />
          <p className="text-xs text-gray-400 mt-4">Changing your password signs you out on every other device.</p>
        </CardContent>
      </Card>
    </div>
  );
}
