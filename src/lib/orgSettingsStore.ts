'use client';

import { create } from 'zustand';
import { api } from './apiClient';
import { APP_NAME } from './constants/branding';

export interface OrgSettings {
  companyName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
}

const DEFAULTS: OrgSettings = { companyName: APP_NAME, address: null, phone: null, email: null, logoUrl: null };

interface OrgSettingsState {
  settings: OrgSettings;
  loaded: boolean;
  load: () => Promise<void>;
  setSettings: (settings: OrgSettings) => void;
}

/**
 * Company branding (name/address/phone/email/logo) shown in the top
 * navbar/sidebar and the login screen — fetched once from the public
 * GET /api/settings endpoint (no auth required, see that route's comment)
 * and cached for the session. Falls back to the application's own default
 * branding (constants/branding.ts) on failure so a settings-endpoint hiccup
 * never blocks the rest of the app from rendering.
 */
export const useOrgSettingsStore = create<OrgSettingsState>((set, get) => ({
  settings: DEFAULTS,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const { settings } = await api.get<{ settings: OrgSettings }>('/settings');
      set({ settings, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  setSettings: (settings) => set({ settings }),
}));
