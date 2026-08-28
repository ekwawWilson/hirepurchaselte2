import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { verifyMobileMoneyNumber } from '@/lib/services/hubtelVerificationService';
import { DIRECT_DEBIT_NETWORKS } from '@/lib/constants/contracts';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.create', 'customer.update', 'customer.view');
  if (!perm.authorized) return perm.error;

  const { phone, network } = (await req.json()) as { phone?: string; network?: string };
  if (!phone) return NextResponse.json({ error: 'phone is required' }, { status: 400 });
  if (!network || !(DIRECT_DEBIT_NETWORKS as readonly string[]).includes(network)) {
    return NextResponse.json({ error: `network must be one of: ${DIRECT_DEBIT_NETWORKS.join(', ')}` }, { status: 400 });
  }

  const result = await verifyMobileMoneyNumber({ msisdn: phone, network, requestedById: auth.user.id });
  return NextResponse.json(result);
}
