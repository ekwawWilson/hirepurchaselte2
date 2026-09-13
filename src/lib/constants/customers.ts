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
