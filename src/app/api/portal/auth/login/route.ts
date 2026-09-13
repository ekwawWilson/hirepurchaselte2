import { NextRequest, NextResponse } from 'next/server';
import { authenticateCustomer } from '@/lib/services/customerPortalService';
import { signCustomerToken } from '@/lib/auth/jwt';
import { logAudit } from '@/lib/services/auditService';

/** Customer portal sign-in: a phone number and a password, never an email. */
export async function POST(req: NextRequest) {
  const { phone, password } = (await req.json().catch(() => ({}))) as { phone?: string; password?: string };
  if (!phone || !password) {
    return NextResponse.json({ error: 'Phone number and password are required' }, { status: 400 });
  }

  const customer = await authenticateCustomer(phone, password);
  // One message for "no such number" and "wrong password" alike: which of the
  // two it is would tell a stranger whether a number is registered here.
  if (!customer) return NextResponse.json({ error: 'Invalid phone number or password' }, { status: 401 });

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
