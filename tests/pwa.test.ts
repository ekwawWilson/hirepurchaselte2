/**
 * The installable apps: the uploaded app icon, and the staff and customer
 * portal manifests built from Settings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as settingsGET } from '@/app/api/settings/route';
import { PATCH as appIconPATCH } from '@/app/api/settings/app-icon/route';
import { GET as portalManifestGET } from '@/app/portal/manifest.webmanifest/route';
import staffManifest from '@/app/manifest';

const PASSWORD = 'Passw0rd!123';
const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`;

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('App icon and manifests', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
  });

  afterAll(async () => {
    await prisma.orgSettings.updateMany({ data: { appIconUrl: null } });
  });

  it('only a settings manager can set the app icon, and only to a real PNG or JPEG', async () => {
    const byCashier = await appIconPATCH(makeRequest('PATCH', '/api/settings/app-icon', { token: cashier, body: { appIconUrl: PNG } }));
    expect(byCashier.status).toBe(403);

    const fake = `data:image/png;base64,${Buffer.from('not really an image').toString('base64')}`;
    const notImage = await appIconPATCH(makeRequest('PATCH', '/api/settings/app-icon', { token: admin, body: { appIconUrl: fake } }));
    expect(notImage.status).toBe(400);

    const ok = await appIconPATCH(makeRequest('PATCH', '/api/settings/app-icon', { token: admin, body: { appIconUrl: PNG } }));
    expect(ok.status).toBe(200);
    expect((await prisma.orgSettings.findUniqueOrThrow({ where: { id: 'singleton' } })).appIconUrl).toBe(PNG);
  });

  it('keeps the app icon out of the public settings every page loads', async () => {
    const { settings } = await (await settingsGET()).json();
    expect(settings).not.toHaveProperty('appIconUrl');
  });

  it('versions icon URLs so a new icon replaces a cached one', async () => {
    const before = (await staffManifest()).icons![0].src;
    await appIconPATCH(makeRequest('PATCH', '/api/settings/app-icon', { token: admin, body: { appIconUrl: null } }));
    const after = (await staffManifest()).icons![0].src;
    expect(before).toMatch(/^\/app-icon\/icon-192\.png\?v=/);
    expect(after).not.toBe(before);
  });

  it('gives the customer portal its own app: identity, scope and start page', async () => {
    const staff = await staffManifest();
    const res = await portalManifestGET();
    expect(res.headers.get('Content-Type')).toBe('application/manifest+json');
    const portal = await res.json();

    expect(staff.id).toBe('/');
    expect(portal.id).toBe('/portal');
    expect(portal.scope).toBe('/portal/');
    expect(portal.start_url).toBe('/portal/dashboard');
    expect(portal.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
  });
});
