/**
 * Coverage for org settings (company name/address/phone/email/logo) — a
 * single-tenant "who is this business" record shown in the browser tab
 * title, top navbar/sidebar, and on reports. GET is deliberately public
 * (needed pre-login for branding); PATCH is gated behind settings.manage
 * (SUPER_ADMIN/ADMIN only, per src/lib/constants/rbac.ts).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest } from './helpers';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as settingsGET, PATCH as settingsPATCH } from '@/app/api/settings/route';

const PASSWORD = 'Passw0rd!123';

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('Org settings', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@hplite.test');
    cashier = await login('cashier@hplite.test');
  });

  it('GET requires no auth at all — needed for pre-login branding', async () => {
    const res = await settingsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toHaveProperty('companyName');
  });

  it('rejects a PATCH from a role without settings.manage (CASHIER)', async () => {
    const res = await settingsPATCH(makeRequest('PATCH', '/api/settings', {
      token: cashier, body: { companyName: 'Cashier Should Not Be Able To Set This' },
    }));
    expect(res.status).toBe(403);
  });

  it('rejects an empty companyName', async () => {
    const res = await settingsPATCH(makeRequest('PATCH', '/api/settings', {
      token: admin, body: { companyName: '   ' },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/companyName is required/i);
  });

  it('ADMIN can update company details, and GET reflects the change afterwards', async () => {
    const patchRes = await settingsPATCH(makeRequest('PATCH', '/api/settings', {
      token: admin,
      body: { companyName: 'Accra Mobile Finance', address: '12 Ring Road, Accra', phone: '0244000000', email: 'ops@amf.test', logoUrl: '' },
    }));
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()).settings;
    expect(patched.companyName).toBe('Accra Mobile Finance');
    expect(patched.address).toBe('12 Ring Road, Accra');
    expect(patched.logoUrl).toBeNull(); // blank string normalizes to null, not ""

    const getRes = await settingsGET();
    const { settings } = await getRes.json();
    expect(settings.companyName).toBe('Accra Mobile Finance');
    expect(settings.email).toBe('ops@amf.test');
  });
});
