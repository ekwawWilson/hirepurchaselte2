import { renderAppIcon } from '@/lib/services/appIconService';

// The browser-tab favicon, drawn from Settings (logo or company initials).
// force-dynamic: it reads the database, so it must not be frozen at build time.
export const dynamic = 'force-dynamic';
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return renderAppIcon({ size: size.width });
}
