import { NextRequest, NextResponse } from 'next/server';
import { requireCustomer } from '@/lib/auth/customerAuth';
import { portalContract } from '@/lib/services/customerPortalService';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  // Scoped to the signed-in customer: another customer's contract id reads as
  // "not found" rather than being refused, which would confirm it exists.
  const contract = await portalContract(auth.customer.id, (await params).id);
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  return NextResponse.json({ contract });
}
