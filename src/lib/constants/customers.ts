import type { MobileMoneyNetwork } from './contracts';

/**
 * Customer photo: a passport-proportioned (35 x 45 mm, 7:9) JPEG, resized in
 * the browser before upload so a full-resolution phone photo (several MB)
 * never leaves the device. At this size and quality a photo is roughly
 * 10-25 KB.
 */
export const CUSTOMER_PHOTO_WIDTH = 210;
export const CUSTOMER_PHOTO_HEIGHT = 270;
export const CUSTOMER_PHOTO_JPEG_QUALITY = 0.72;
/** Server-side ceiling, well above what the resize produces. */
export const MAX_CUSTOMER_PHOTO_BYTES = 80 * 1024;

/**
 * Ghana mobile number prefixes by network (national numbering plan, with
 * Vodafone Ghana now trading as Telecel). Registration asks for the number
 * only; the network is read from it.
 */
const NETWORK_PREFIXES: Record<MobileMoneyNetwork, string[]> = {
  MTN: ['024', '025', '053', '054', '055', '059'],
  TELECEL: ['020', '050'],
  AIRTELTIGO: ['026', '027', '056', '057'],
};

/**
 * The network Hubtel's USSD gateway says a dialling line is on (its request's
 * `Operator`: mtn, vodafone, tigo, airtel…), or null if absent or not one
 * that carries mobile money here. Better than the prefix when present — a
 * ported number keeps its old prefix on its new network.
 */
export function networkForOperator(operator: string | null | undefined): MobileMoneyNetwork | null {
  const name = (operator ?? '').trim().toLowerCase();
  if (name.startsWith('mtn')) return 'MTN';
  if (name.startsWith('vodafone') || name.startsWith('telecel')) return 'TELECEL';
  if (name.startsWith('tigo') || name.startsWith('airtel') || name === 'at') return 'AIRTELTIGO';
  return null;
}

/**
 * A Ghana phone number as this app stores it — ten digits starting with 0 —
 * from any of the ways it gets typed (024 123 4567, +233 24 123 4567,
 * 233241234567, 24-123-4567). Null if it is not a ten-digit Ghana number.
 */
export function normalizeGhanaPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  const local = digits.startsWith('233') && digits.length === 12 ? '0' + digits.slice(3) : digits.length === 9 && !digits.startsWith('0') ? '0' + digits : digits;
  return /^0\d{9}$/.test(local) ? local : null;
}

export const INVALID_MOBILE_NUMBER = 'is not a valid Ghana mobile number. Enter ten digits on MTN, Telecel or AirtelTigo, e.g. 0241234567';

/** The network a Ghana mobile number belongs to, or null if the prefix is unknown. */
export function networkForPhone(phone: string): MobileMoneyNetwork | null {
  const digits = phone.replace(/[\s-]/g, '').replace(/^\+/, '');
  const local = digits.startsWith('233') ? '0' + digits.slice(3) : digits.startsWith('0') ? digits : '0' + digits;
  const prefix = local.slice(0, 3);
  for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES) as [MobileMoneyNetwork, string[]][]) {
    if (prefixes.includes(prefix)) return network;
  }
  return null;
}
