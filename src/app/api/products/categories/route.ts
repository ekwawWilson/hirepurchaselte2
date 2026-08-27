import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const categories = await prisma.productCategory.findMany({ orderBy: { name: 'asc' } });
  return NextResponse.json({ categories });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;

  const { name } = (await req.json()) as { name?: string };
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const category = await prisma.productCategory.upsert({ where: { name }, update: {}, create: { name } });
  return NextResponse.json({ category }, { status: 201 });
}
