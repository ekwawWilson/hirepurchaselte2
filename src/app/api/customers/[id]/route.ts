import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import {
  validateAtLeastOnePhone, assertPhonesNotTaken, validateCustomerPhoto, CUSTOMER_DETAIL_SELECT,
} from '@/lib/services/customerService';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.view');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const customer = await prisma.customer.findUnique({ where: { id }, select: CUSTOMER_DETAIL_SELECT });
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, customer.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, customer.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json({ customer });
}

/**
 * Partial update. Registration now takes a single number, but customers
 * registered earlier may still hold a second or third (phone2/phone3), which
 * USSD and the portal keep matching — so those columns are still accepted
 * here and still count toward the "at least one number" rule.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.update');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, existing.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const {
    firstName, lastName, phone, phone2, phone3, email, address, occupation, workAddress, nationalId, dateOfBirth,
    photoUrl, guarantorName, guarantorPhone,
  } = (await req.json()) as Record<string, string | undefined>;

  // Validate against the EFFECTIVE post-update phone set, not just whatever fields
  // this particular PATCH happens to touch — a partial update must never leave the
  // customer with zero phone numbers.
  const effective = {
    phone: phone !== undefined ? phone : existing.phone,
    phone2: phone2 !== undefined ? phone2 : existing.phone2,
    phone3: phone3 !== undefined ? phone3 : existing.phone3,
  };
  const phoneError = validateAtLeastOnePhone(effective);
  if (phoneError) return NextResponse.json({ error: phoneError }, { status: 400 });
  const clashError = await assertPhonesNotTaken(effective, existing.id);
  if (clashError) return NextResponse.json({ error: clashError }, { status: 409 });

  if (photoUrl) {
    const photoError = validateCustomerPhoto(photoUrl);
    if (photoError) return NextResponse.json({ error: photoError }, { status: 400 });
  }

  const customer = await prisma.customer.update({
    where: { id: existing.id },
    data: {
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(phone !== undefined && { phone: phone || null }),
      ...(phone2 !== undefined && { phone2: phone2 || null }),
      ...(phone3 !== undefined && { phone3: phone3 || null }),
      ...(email !== undefined && { email: email || null }),
      ...(address !== undefined && { address: address || null }),
      ...(occupation !== undefined && { occupation: occupation || null }),
      ...(workAddress !== undefined && { workAddress: workAddress || null }),
      ...(nationalId !== undefined && { nationalId: nationalId || null }),
      ...(dateOfBirth !== undefined && { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null }),
      ...(photoUrl !== undefined && { photoUrl: photoUrl || null }),
      ...(guarantorName !== undefined && { guarantorName: guarantorName || null }),
      ...(guarantorPhone !== undefined && { guarantorPhone: guarantorPhone || null }),
      updatedById: auth.user.id,
    },
    select: CUSTOMER_DETAIL_SELECT,
  });

  return NextResponse.json({ customer });
}
