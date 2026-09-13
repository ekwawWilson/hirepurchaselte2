import type { MetadataRoute } from 'next';
import { buildWebManifest } from '@/lib/services/webManifestService';

// force-dynamic: the name and icons come from Settings, so the manifest must
// not be frozen into the build.
export const dynamic = 'force-dynamic';

export default function manifest(): Promise<MetadataRoute.Manifest> {
  return buildWebManifest('staff');
}
