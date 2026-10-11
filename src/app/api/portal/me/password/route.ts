import { NextRequest, NextResponse } from 'next/server';
import { requireCustomer } from '@/lib/auth/customerAuth';
import { setCustomerPassword, PortalError } from '@/lib/services/customerPortalService';
import { logAudit } from '@/lib/services/auditService';
import { signCustomerToken } from '@/lib/auth/jwt';

export async function POST(req: NextRequest) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  const { currentPassword, newPassword } = (await req.json().catch(() => ({}))) as {
    currentPassword?: string; newPassword?: string;
  };
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Both your current and new password are required' }, { status: 400 });
  }

  try {
    await setCustomerPassword({ customerId: auth.customer.id, currentPassword, newPassword });
    await logAudit({ userId: null, action: 'CUSTOMER_PASSWORD_CHANGE', entityType: 'Customer', entityId: auth.customer.id });
    // The change signs out every earlier session (customerAuth.ts); this one
    // carries on with a fresh token.
    return NextResponse.json({ ok: true, token: signCustomerToken(auth.customer.id) });
  } catch (e) {
    if (e instanceof PortalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
