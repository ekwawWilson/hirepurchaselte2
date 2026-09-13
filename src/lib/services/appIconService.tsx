import { ImageResponse } from 'next/og';
import { getOrgSettings, parseLogoDataUrl, detectImageType } from './orgSettingsService';
import { APP_THEME_COLOR } from '../constants/branding';
import { companyInitials } from '../utils';

const REMOTE_LOGO_TIMEOUT_MS = 3000;
const MAX_REMOTE_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * The logo as a data URL the icon renderer can embed, or null to fall back to
 * initials. An uploaded logo is used as stored; a linked one is fetched
 * server-side (PNG/JPEG only, size- and time-capped).
 */
async function loadLogo(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  if (logoUrl.startsWith('data:')) return parseLogoDataUrl(logoUrl) ? logoUrl : null;
  if (!/^https?:\/\//i.test(logoUrl)) return null;
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(REMOTE_LOGO_TIMEOUT_MS) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_REMOTE_LOGO_BYTES) return null;
    // Trust the file signature, not the server's content-type header.
    const contentType = detectImageType(bytes);
    if (!contentType) return null;
    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

function iconElement(params: { size: number; maskable: boolean; logo: string | null; initials: string }) {
  const { size, maskable, logo, initials } = params;
  // A maskable icon is cropped to a circle-ish shape by the OS, so its content
  // stays inside the central 80% safe zone on a full-bleed background.
  const inner = Math.round(size * (maskable ? 0.8 : 1));
  const radius = maskable ? 0 : Math.round(size * 0.2);

  if (logo) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', borderRadius: radius }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={logo} width={inner} height={inner} style={{ objectFit: 'contain' }} />
      </div>
    );
  }
  return (
    <div
      style={{
        width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: APP_THEME_COLOR, borderRadius: radius, color: '#ffffff',
        fontSize: Math.round(inner * 0.42), fontWeight: 700, letterSpacing: -Math.round(size * 0.01),
      }}
    >
      {initials}
    </div>
  );
}

/**
 * Renders the favicon/install icon from Settings: the company logo when one
 * is set and loads, otherwise the company's initials on the brand colour.
 * Rendered eagerly so a logo that can't be decoded falls back to initials
 * instead of serving a broken image.
 */
export async function renderAppIcon(params: { size: number; maskable?: boolean }): Promise<Response> {
  const { companyName, logoUrl } = await getOrgSettings();
  const initials = companyInitials(companyName);
  const maskable = params.maskable ?? false;
  const options = { width: params.size, height: params.size };

  let png: ArrayBuffer | null = null;
  const logo = await loadLogo(logoUrl);
  if (logo) {
    try {
      png = await new ImageResponse(iconElement({ size: params.size, maskable, logo, initials }), options).arrayBuffer();
    } catch (e) {
      console.error('[app-icon] logo could not be rendered, using initials:', e);
    }
  }
  png ??= await new ImageResponse(iconElement({ size: params.size, maskable, logo: null, initials }), options).arrayBuffer();

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      // Short, so a logo changed in Settings shows up within minutes.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
