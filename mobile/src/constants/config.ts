/**
 * Everything about this build that is not secret. The app holds no keys: only
 * the public API address and, once signed in, the customer's own token.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://flezy.flezeypay.com/api';

export const APP_CONFIG = {
  appName: 'FlezePay Customer',
  /** Used until the company's own name loads from the server (GET /settings). */
  companyName: 'FlezePay',
  developer: { name: 'EYO Solutions', url: 'https://www.eyosolutions.com' },
  version: '1.0.0', // keep in step with app.json and package.json
};

export const PAYMENT_CONFIG = {
  // Exactly the values the server accepts (MOBILE_MONEY_NETWORKS there).
  networks: [
    { value: 'MTN', label: 'MTN MoMo', short: 'MTN' },
    { value: 'TELECEL', label: 'Telecel Cash', short: 'Telecel' },
    { value: 'AIRTELTIGO', label: 'AirtelTigo Money', short: 'AT' },
  ],
  pollIntervalMs: 2000,
  pollMaxAttempts: 60, // two minutes, then "still waiting"
  /** The server's own limits (paymentLimitsService): the smallest payment, and one savings payment's largest. */
  minPaymentMinor: 100,
  maxSavingsPaymentMinor: 2_000_000,
};
