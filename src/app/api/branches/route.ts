import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requireSuperAdmin } from '@/lib/auth/rbac';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const branches = await prisma.branch.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ branches });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requireSuperAdmin(auth.user);
  if (!perm.authorized) return perm.error;

  const { name, code, address, phone } = (await req.json()) as {
    name?: string; code?: string; address?: string; phone?: string;
  };
  if (!name || !code) return NextResponse.json({ error: 'name and code are required' }, { status: 400 });

  const existing = await prisma.branch.findUnique({ where: { code } });
  if (existing) return NextResponse.json({ error: 'A branch with this code already exists' }, { status: 409 });

  const branch = await prisma.branch.create({ data: { name, code, address, phone } });
  return NextResponse.json({ branch }, { status: 201 });
}
