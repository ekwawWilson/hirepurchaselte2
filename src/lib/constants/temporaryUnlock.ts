/**
 * Device Financing temporary unlock: tiers of "pay this share of what is
 * overdue, the phone opens for this long". Shared by the server and the pages.
 */

export interface TemporaryUnlockTier {
  /** Share of the overdue amount, in percent. */
  percent: number;
  /** How long the phone opens for. */
  hours: number;
}

export const MIN_UNLOCK_TIERS = 4;
/** Six lines is what a USSD screen holds. */
export const MAX_UNLOCK_TIERS = 6;

/** "12 hours", "1 day", "3 days". */
export function unlockPeriodLabel(hours: number): string {
  if (hours % 24 !== 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Why these tiers cannot be saved, or null: 4 to 6, each paying more and opening longer than the last. */
export function unlockTiersProblem(value: unknown, maxHours: number): string | null {
  if (!Array.isArray(value) || value.length < MIN_UNLOCK_TIERS || value.length > MAX_UNLOCK_TIERS) {
    return `Set between ${MIN_UNLOCK_TIERS} and ${MAX_UNLOCK_TIERS} tiers`;
  }
  let previous: TemporaryUnlockTier | null = null;
  for (const [i, tier] of (value as Array<Partial<TemporaryUnlockTier>>).entries()) {
    const { percent, hours } = tier ?? {};
    if (!Number.isInteger(percent) || percent! < 1 || percent! > 99) return `Tier ${i + 1}: the percentage must be a whole number from 1 to 99`;
    if (!Number.isInteger(hours) || hours! < 1 || hours! > maxHours) return `Tier ${i + 1}: the hours must be a whole number from 1 to ${maxHours}`;
    if (previous && (percent! <= previous.percent || hours! <= previous.hours)) {
      return `Tier ${i + 1} must take a higher percentage and open for longer than tier ${i}`;
    }
    previous = { percent: percent!, hours: hours! };
  }
  return null;
}
