import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { issuePortalPassword } from '@/lib/services/customerPortalService';
import { clearLoginFailures } from '@/lib/auth/loginThrottle';
import { normalizeGhanaPhone } from '@/lib/constants/customers';
import { allPhones } from '@/lib/services/customerService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Issues a customer a new one-time portal password — for one who never had
 * one, or has forgotten theirs. Shown to staff once to read out or write
 * down; the customer replaces it at their next sign-in.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.create', 'customer.update');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, customer.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, customer.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const portalPassword = await issuePortalPassword(customer.id);
  for (const phone of allPhones(customer)) await clearLoginFailures(`portal:${normalizeGhanaPhone(phone) ?? phone.trim()}`);
  await logAudit({ userId: auth.user.id, action: 'CUSTOMER_PORTAL_PASSWORD_ISSUE', entityType: 'Customer', entityId: customer.id });
  return NextResponse.json({ portalPassword });
}
