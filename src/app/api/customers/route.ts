import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { generateMembershipId } from '@/lib/utils/idGenerators';
import { logAudit } from '@/lib/services/auditService';
import { validateAtLeastOnePhone, assertPhonesNotTaken } from '@/lib/services/customerService';

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

  const customers = await prisma.customer.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  return NextResponse.json({ customers });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.create');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const {
    firstName, lastName, phone, phone2, phone3, email, address, nationalId, dateOfBirth,
    photoUrl, guarantorName, guarantorPhone, branchId: branchIdInput,
  } = (await req.json()) as Record<string, string | undefined>;

  if (!firstName || !lastName) {
    return NextResponse.json({ error: 'firstName and lastName are required' }, { status: 400 });
  }
  const phoneError = validateAtLeastOnePhone({ phone, phone2, phone3 });
  if (phoneError) return NextResponse.json({ error: phoneError }, { status: 400 });

  const branchId = user.branchId ?? branchIdInput;
  if (!branchId) return NextResponse.json({ error: 'branchId is required for an all-branch user' }, { status: 400 });

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) return NextResponse.json({ error: 'Unknown branchId' }, { status: 400 });

  const clashError = await assertPhonesNotTaken({ phone, phone2, phone3 });
  if (clashError) return NextResponse.json({ error: clashError }, { status: 409 });

  const membershipId = await generateMembershipId(branch.code);

  const customer = await prisma.customer.create({
    data: {
      membershipId,
      firstName,
      lastName,
      phone: phone || null,
      phone2: phone2 || null,
      phone3: phone3 || null,
      email: email || null,
      address: address || null,
      nationalId: nationalId || null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      photoUrl: photoUrl || null,
      guarantorName: guarantorName || null,
      guarantorPhone: guarantorPhone || null,
      branchId,
      createdById: user.id,
    },
  });

  await logAudit({ userId: user.id, action: 'CUSTOMER_CREATE', entityType: 'Customer', entityId: customer.id, newValues: customer });
  return NextResponse.json({ customer }, { status: 201 });
}
