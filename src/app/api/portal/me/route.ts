import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireCustomer } from '@/lib/auth/customerAuth';

/** The signed-in customer's own profile. */
export async function GET(req: NextRequest) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  const customer = await prisma.customer.findUniqueOrThrow({
    where: { id: auth.customer.id },
    select: {
      id: true, membershipId: true, firstName: true, lastName: true,
      phone: true, phone2: true, phone3: true, email: true, address: true,
      mustChangePassword: true, portalLastLoginAt: true, createdAt: true,
      branch: { select: { name: true, phone: true, address: true } },
    },
  });
  return NextResponse.json({ customer });
}
