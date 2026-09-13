import { renderAppIcon } from '@/lib/services/appIconService';

// The iPhone/iPad home-screen icon. iOS ignores the manifest's icons and
// rounds the corners itself, so this one is square-cornered (flat).
export const dynamic = 'force-dynamic';
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return renderAppIcon({ size: size.width, flat: true });
}
