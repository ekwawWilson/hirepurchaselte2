import { NextRequest, NextResponse } from 'next/server';
import { authenticateCustomer } from '@/lib/services/customerPortalService';
import { signCustomerToken } from '@/lib/auth/jwt';
import { logAudit } from '@/lib/services/auditService';
import { loginLockout, recordLoginFailure, clearLoginFailures } from '@/lib/auth/loginThrottle';
import { normalizeGhanaPhone } from '@/lib/constants/customers';

/** Customer portal sign-in: a phone number and a password, never an email. */
export async function POST(req: NextRequest) {
  const { phone, password } = (await req.json().catch(() => ({}))) as { phone?: string; password?: string };
  if (!phone || !password) {
    return NextResponse.json({ error: 'Phone number and password are required' }, { status: 400 });
  }

  // One count per number however it is written, registered here or not.
  const account = `portal:${normalizeGhanaPhone(phone) ?? phone.trim()}`;
  const locked = await loginLockout(req, account);
  if (locked) return locked;

  const customer = await authenticateCustomer(phone, password);
  // One message for "no such number" and "wrong password" alike: which of the
  // two it is would tell a stranger whether a number is registered here.
  if (!customer) {
    await recordLoginFailure(req, account);
    return NextResponse.json({ error: 'Invalid phone number or password' }, { status: 401 });
  }
  await clearLoginFailures(account);

  await logAudit({ userId: null, action: 'CUSTOMER_PORTAL_LOGIN', entityType: 'Customer', entityId: customer.id });

  return NextResponse.json({
    token: signCustomerToken(customer.id),
    customer: {
      id: customer.id,
      membershipId: customer.membershipId,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone ?? customer.phone2 ?? customer.phone3,
      mustChangePassword: customer.mustChangePassword,
    },
  });
}
