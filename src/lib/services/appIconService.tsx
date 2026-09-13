import { ImageResponse } from 'next/og';
import { getAppIconSource, parseLogoDataUrl } from './orgSettingsService';
import { detectImageType } from '../imageData';
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

type IconArt = { kind: 'icon'; src: string } | { kind: 'logo'; src: string } | { kind: 'initials'; initials: string };

function iconElement(params: { size: number; maskable: boolean; art: IconArt; flat?: boolean }) {
  const { size, maskable, art } = params;
  // A maskable icon is cropped to a circle-ish shape by the OS, so its content
  // stays inside the central 80% safe zone on a full-bleed background. A flat
  // icon (Apple's) gets square corners too: iOS rounds them itself.
  const inner = Math.round(size * (maskable ? 0.8 : 1));
  const radius = maskable || params.flat ? 0 : Math.round(size * 0.2);

  if (art.kind === 'icon') {
    // A dedicated app icon is already square: it fills the whole tile.
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', borderRadius: radius, overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={art.src} width={inner} height={inner} style={{ objectFit: 'cover' }} />
      </div>
    );
  }
  if (art.kind === 'logo') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', borderRadius: radius }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={art.src} width={inner} height={inner} style={{ objectFit: 'contain' }} />
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
      {art.initials}
    </div>
  );
}

/**
 * Renders the favicon / install / home-screen icon from Settings: the
 * uploaded app icon, else the company logo, else the company's initials on
 * the brand colour. Rendered eagerly so an image that can't be decoded falls
 * through to the next choice instead of serving a broken icon.
 */
export async function renderAppIcon(params: { size: number; maskable?: boolean; flat?: boolean }): Promise<Response> {
  const { companyName, logoUrl, appIconUrl } = await getAppIconSource();
  const maskable = params.maskable ?? false;
  const options = { width: params.size, height: params.size };

  const candidates: IconArt[] = [];
  if (appIconUrl && parseLogoDataUrl(appIconUrl)) candidates.push({ kind: 'icon', src: appIconUrl });
  const logo = await loadLogo(logoUrl);
  if (logo) candidates.push({ kind: 'logo', src: logo });

  let png: ArrayBuffer | null = null;
  for (const art of candidates) {
    try {
      png = await new ImageResponse(iconElement({ size: params.size, maskable, art, flat: params.flat }), options).arrayBuffer();
      break;
    } catch (e) {
      console.error(`[app-icon] ${art.kind} could not be rendered, trying the next choice:`, e);
    }
  }
  png ??= await new ImageResponse(
    iconElement({ size: params.size, maskable, art: { kind: 'initials', initials: companyInitials(companyName) }, flat: params.flat }),
    options,
  ).arrayBuffer();

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      // Short, so an icon changed in Settings shows up within minutes; URLs
      // in the manifest also carry a version that changes on every save.
      'Cache-Control': 'public, max-age=300',
    },
  });
}
