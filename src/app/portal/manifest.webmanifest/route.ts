import { buildWebManifest } from '@/lib/services/webManifestService';

// The customer portal's own manifest. Next only supports the manifest file
// convention at the root of app/, so the portal's is a plain route, linked
// from portal/layout.tsx.
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(JSON.stringify(await buildWebManifest('portal')), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=300' },
  });
}
