import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';
import { verifyToken } from './jwt';

export interface AuthenticatedCustomer {
  id: string;
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  mustChangePassword: boolean;
}

/**
 * The customer portal's counterpart to rbac.ts's requireAuth: verifies a
 * portal token and loads the customer fresh on every request. A staff token
 * is rejected here, exactly as a customer token is rejected there.
 */
export async function requireCustomer(req: NextRequest): Promise<{ customer: AuthenticatedCustomer } | { error: NextResponse }> {
  const header = req.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return { error: NextResponse.json({ error: 'Missing or invalid Authorization header' }, { status: 401 }) };
  }

  try {
    const payload = verifyToken(header.slice('Bearer '.length));
    if (payload.typ !== 'customer') {
      return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) };
    }

    const customer = await prisma.customer.findUnique({ where: { id: payload.sub } });
    if (!customer) return { error: NextResponse.json({ error: 'Account not found' }, { status: 401 }) };

    return {
      customer: {
        id: customer.id,
        membershipId: customer.membershipId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone ?? customer.phone2 ?? customer.phone3,
        mustChangePassword: customer.mustChangePassword,
      },
    };
  } catch {
    return { error: NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 }) };
  }
}
