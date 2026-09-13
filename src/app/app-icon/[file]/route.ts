import { NextRequest, NextResponse } from 'next/server';
import { renderAppIcon } from '@/lib/services/appIconService';

/**
 * The install (PWA) icons listed in manifest.ts, drawn from Settings — the
 * company logo, or its initials. Public, like the manifest itself.
 */
const ICONS: Record<string, { size: number; maskable: boolean }> = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'icon-512-maskable.png': { size: 512, maskable: true },
};

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const icon = ICONS[file];
  if (!icon) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return renderAppIcon(icon);
}
