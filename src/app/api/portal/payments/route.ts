import { NextRequest, NextResponse } from 'next/server';
import { requireCustomer } from '@/lib/auth/customerAuth';
import { portalPayments } from '@/lib/services/customerPortalService';

export async function GET(req: NextRequest) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;
  return NextResponse.json({ payments: await portalPayments(auth.customer.id) });
}
