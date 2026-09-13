import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { generateMembershipId } from '@/lib/utils/idGenerators';
import { logAudit } from '@/lib/services/auditService';
import {
  assertPhonesNotTaken, validateRegistration, registrationBranch,
  CUSTOMER_SUMMARY_SELECT, CUSTOMER_DETAIL_SELECT,
} from '@/lib/services/customerService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.view');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') ?? undefined;
  const branchIdParam = searchParams.get('branchId') ?? undefined;

  const where: Record<string, unknown> = { ...branchScopeWhere(user) };
  if (!user.branchId && branchIdParam) where.branchId = branchIdParam;

  if (q) {
    where.OR = [
      { firstName: { contains: q } },
      { lastName: { contains: q } },
      { phone: { contains: q } },
      { phone2: { contains: q } },
      { phone3: { contains: q } },
      { membershipId: { contains: q } },
    ];
  }

  const customers = await prisma.customer.findMany({ where, select: CUSTOMER_SUMMARY_SELECT, orderBy: { createdAt: 'desc' }, take: 100 });
  return NextResponse.json({ customers });
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

  const phone = body.phone!.trim();
  const clashError = await assertPhonesNotTaken({ phone });
  if (clashError) return NextResponse.json({ error: clashError }, { status: 409 });

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
      nationalId: body.nationalId?.trim() || null,
      dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
      guarantorName: body.guarantorName?.trim() || null,
      guarantorPhone: body.guarantorPhone?.trim() || null,
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
  return NextResponse.json({ customer }, { status: 201 });
}
