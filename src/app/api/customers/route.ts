import { NextRequest, NextResponse } from 'next/server';
import { customerSearchWhere } from '@/lib/utils/search';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere, ownRecordsWhere } from '@/lib/auth/rbac';
import { generateMembershipId } from '@/lib/utils/idGenerators';
import { logAudit } from '@/lib/services/auditService';
import {
  assertPhonesNotTaken, validateRegistration, registrationBranch, cleanMobileNumber, cleanContactNumber,
  cleanNationalId, assertNationalIdNotTaken, CUSTOMER_SUMMARY_SELECT, CUSTOMER_DETAIL_SELECT,
} from '@/lib/services/customerService';
import { issuePortalPassword } from '@/lib/services/customerPortalService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.view');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') ?? undefined;
  const branchIdParam = searchParams.get('branchId') ?? undefined;

  const where: Record<string, unknown> = { ...branchScopeWhere(user), ...ownRecordsWhere(user) };
  if (!user.branchId && branchIdParam) where.branchId = branchIdParam;

  // The newest 100 that match. Not a cap on who can be found: searching
  // reaches every customer, however long ago they registered.
  if (q) where.AND = customerSearchWhere(q);

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({ where, select: CUSTOMER_SUMMARY_SELECT, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.customer.count({ where }),
  ]);
  return NextResponse.json({ customers, total });
}

/**
 * Registration takes one phone number (the network is read from its prefix
 * when it is verified), a passport photo, and residential address,
 * occupation and work address. The branch is never chosen: it is the
 * registering user's own (customerService.registrationBranch).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.create');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const body = (await req.json().catch(() => ({}))) as Record<string, string | undefined>;
  const invalid = validateRegistration(body);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const branch = await registrationBranch(user);
  if (!branch) {
    return NextResponse.json({
      error: 'Your account is not assigned to a branch. Assign yourself a branch under Users before registering customers.',
    }, { status: 400 });
  }

  const cleaned = cleanMobileNumber(body.phone!);
  if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 });
  const { phone } = cleaned;
  const guarantor = body.guarantorPhone?.trim() ? cleanContactNumber(body.guarantorPhone, "The guarantor's phone number") : null;
  if (guarantor && 'error' in guarantor) return NextResponse.json({ error: guarantor.error }, { status: 400 });

  const clashError = await assertPhonesNotTaken({ phone });
  if (clashError) return NextResponse.json({ error: clashError }, { status: 409 });
  const nationalId = body.nationalId?.trim() ? cleanNationalId(body.nationalId) : null;
  const idClash = nationalId && await assertNationalIdNotTaken(nationalId);
  if (idClash) return NextResponse.json({ error: idClash }, { status: 409 });

  const customer = await prisma.customer.create({
    data: {
      membershipId: await generateMembershipId(branch.code),
      firstName: body.firstName!.trim(),
      lastName: body.lastName!.trim(),
      phone,
      address: body.address!.trim(),
      occupation: body.occupation!.trim(),
      workAddress: body.workAddress!.trim(),
      photoUrl: body.photoUrl!,
      email: body.email?.trim() || null,
      nationalId,
      dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
      guarantorName: body.guarantorName?.trim() || null,
      guarantorPhone: guarantor?.phone ?? null,
      branchId: branch.id,
      createdById: user.id,
    },
    select: CUSTOMER_DETAIL_SELECT,
  });

  // The audit log records that a photo was taken, not the image itself.
  await logAudit({
    userId: user.id, action: 'CUSTOMER_CREATE', entityType: 'Customer', entityId: customer.id,
    newValues: { ...customer, photoUrl: '[photo]' },
  });
  // The customer's way into the portal: a one-time password, shown to the
  // person registering them this once and stored only as a hash.
  const portalPassword = await issuePortalPassword(customer.id);
  return NextResponse.json({ customer, portalPassword }, { status: 201 });
}
