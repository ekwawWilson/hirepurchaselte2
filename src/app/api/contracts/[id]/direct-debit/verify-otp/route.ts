import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { submitPreapprovalOtp, PreapprovalError } from '@/lib/services/hubtelPreapprovalService';
import { logAudit } from '@/lib/services/auditService';

/** Submits the OTP Hubtel texted the customer for a mandate stuck on verificationType 'OTP'. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.reschedule');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { otpCode } = (await req.json()) as { otpCode?: string };
  if (!otpCode) return NextResponse.json({ error: 'otpCode is required' }, { status: 400 });

  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!contract.hubtelPreapprovalId) return NextResponse.json({ error: 'This contract has no direct-debit mandate' }, { status: 400 });

  try {
    const preapproval = await submitPreapprovalOtp({ preapprovalId: contract.hubtelPreapprovalId, otpCode });
    await logAudit({ userId: auth.user.id, action: 'DIRECT_DEBIT_OTP_VERIFY', entityType: 'Contract', entityId: id });
    return NextResponse.json({ preapproval });
  } catch (e) {
    if (e instanceof PreapprovalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
