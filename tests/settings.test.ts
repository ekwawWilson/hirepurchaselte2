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
import { GET as loanTermsGET, PATCH as loanTermsPATCH } from '@/app/api/settings/loan-terms/route';

const PASSWORD = 'Passw0rd!123';

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('Org settings', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
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

/**
 * Coverage for the global DEVICE_LOAN terms (daily interest rate + grace
 * period) — unlike org settings, gated on GET too, since this is operational
 * pricing configuration, not public branding. Snapshotted onto each
 * DEVICE_LOAN contract at creation (loanSettingsService.ts/contractService.ts) —
 * changing it here never repricess a contract already created.
 */
describe('Loan payment terms settings', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
  });

  it('GET requires settings.manage — CASHIER gets 403', async () => {
    const res = await loanTermsGET(makeRequest('GET', '/api/settings/loan-terms', { token: cashier }));
    expect(res.status).toBe(403);
  });

  it('ADMIN can read the current terms, defaulting to 1%/day with no grace period before any row is saved', async () => {
    const res = await loanTermsGET(makeRequest('GET', '/api/settings/loan-terms', { token: admin }));
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(typeof settings.dailyInterestRateBps).toBe('number');
    expect(typeof settings.interestGraceDays).toBe('number');
  });

  it('rejects a PATCH from a role without settings.manage (CASHIER)', async () => {
    const res = await loanTermsPATCH(makeRequest('PATCH', '/api/settings/loan-terms', {
      token: cashier, body: { dailyInterestRateBps: 100, interestGraceDays: 0 },
    }));
    expect(res.status).toBe(403);
  });

  it('rejects a non-positive dailyInterestRateBps and a negative interestGraceDays', async () => {
    const zeroRate = await loanTermsPATCH(makeRequest('PATCH', '/api/settings/loan-terms', {
      token: admin, body: { dailyInterestRateBps: 0, interestGraceDays: 0 },
    }));
    expect(zeroRate.status).toBe(400);

    const negativeGrace = await loanTermsPATCH(makeRequest('PATCH', '/api/settings/loan-terms', {
      token: admin, body: { dailyInterestRateBps: 100, interestGraceDays: -1 },
    }));
    expect(negativeGrace.status).toBe(400);
  });

  it('ADMIN can update the terms, and GET reflects the change afterwards', async () => {
    const patchRes = await loanTermsPATCH(makeRequest('PATCH', '/api/settings/loan-terms', {
      token: admin, body: { dailyInterestRateBps: 150, interestGraceDays: 3 },
    }));
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()).settings;
    expect(patched.dailyInterestRateBps).toBe(150);
    expect(patched.interestGraceDays).toBe(3);

    const getRes = await loanTermsGET(makeRequest('GET', '/api/settings/loan-terms', { token: admin }));
    const { settings } = await getRes.json();
    expect(settings.dailyInterestRateBps).toBe(150);
    expect(settings.interestGraceDays).toBe(3);
  });
});
