import { NextRequest, NextResponse } from 'next/server';
import { requireCustomer } from '@/lib/auth/customerAuth';
import { portalContracts, portalUpcomingInstalments } from '@/lib/services/customerPortalService';

/** Every contract belonging to the signed-in customer, plus what is due next. */
export async function GET(req: NextRequest) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  const [contracts, upcoming] = await Promise.all([
    portalContracts(auth.customer.id),
    portalUpcomingInstalments(auth.customer.id),
  ]);
  return NextResponse.json({ contracts, upcoming });
}
