/** The names and icons phones show for the two installable apps. */
import { describe, it, expect } from 'vitest';
import { buildWebManifest } from '@/lib/services/webManifestService';
import { getAppIconSource } from '@/lib/services/orgSettingsService';

describe('Installable apps', () => {
  it('names both apps after the company under their icons, never "My Account"', async () => {
    const { companyName } = await getAppIconSource();
    const staff = await buildWebManifest('staff');
    const portal = await buildWebManifest('portal');
    expect(staff.short_name).toBe(companyName);
    expect(portal.short_name).toBe(companyName);
    expect(portal.name).toBe(`${companyName} Customer Portal`);
    expect(portal).toMatchObject({ id: '/portal', scope: '/portal/', start_url: '/portal/dashboard' });
    for (const m of [staff, portal]) {
      expect(m.icons?.map((i) => i.sizes)).toEqual(['192x192', '512x512', '512x512']);
      expect(m.icons?.some((i) => i.purpose === 'maskable')).toBe(true);
    }
  });
});
