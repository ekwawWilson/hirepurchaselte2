import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import {
  validateAtLeastOnePhone, assertPhonesNotTaken, validateCustomerPhoto, cleanMobileNumber, cleanContactNumber,
  cleanNationalId, assertNationalIdNotTaken, CUSTOMER_DETAIL_SELECT,
} from '@/lib/services/customerService';
import { logAudit } from '@/lib/services/auditService';

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

  const body = (await req.json()) as Record<string, string | undefined>;
  const { firstName, lastName, email, address, occupation, workAddress, dateOfBirth, photoUrl, guarantorName } = body;

  // Only a number this update actually changes is checked and normalised — a
  // number stored years ago in some other form must not block an unrelated edit.
  const numbers: Record<string, string | undefined> = {};
  for (const [key, label] of [['phone', 'The phone number'], ['phone2', 'The second phone number'], ['phone3', 'The third phone number']] as const) {
    const value = body[key];
    if (!value?.trim() || value === existing[key]) { numbers[key] = value === undefined ? undefined : value.trim(); continue; }
    const cleaned = cleanMobileNumber(value, label);
    if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 });
    numbers[key] = cleaned.phone;
  }
  const { phone, phone2, phone3 } = numbers;

  let guarantorPhone = body.guarantorPhone;
  if (guarantorPhone?.trim() && guarantorPhone !== existing.guarantorPhone) {
    const cleaned = cleanContactNumber(guarantorPhone, "The guarantor's phone number");
    if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 });
    guarantorPhone = cleaned.phone;
  }

  const nationalId = body.nationalId === undefined ? undefined : cleanNationalId(body.nationalId);
  if (nationalId && nationalId !== existing.nationalId) {
    const idClash = await assertNationalIdNotTaken(nationalId, existing.id);
    if (idClash) return NextResponse.json({ error: idClash }, { status: 409 });
  }

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
  await logAudit({
    userId: auth.user.id, action: 'CUSTOMER_UPDATE', entityType: 'Customer', entityId: customer.id,
    oldValues: { phone: existing.phone, phone2: existing.phone2, phone3: existing.phone3, nationalId: existing.nationalId },
    newValues: { ...customer, photoUrl: customer.photoUrl ? '[photo]' : null },
  });

  return NextResponse.json({ customer });
}
