import type { PayTriggerSettings } from '@prisma/client';
import { prisma } from '../db/prisma';

/** Always exactly one row (Settings > PayTrigger), read through a 60-second cache. */
const SINGLETON_ID = 'singleton';
const CACHE_MS = 60_000;
let cached: { value: PayTriggerSettings; at: number } | null = null;

export async function getPayTriggerSettings(): Promise<PayTriggerSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await prisma.payTriggerSettings.upsert({ where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID }, update: {} });
  cached = { value, at: Date.now() };
  return value;
}

export function clearPayTriggerSettingsCache() {
  cached = null;
}

/** What a lock-screen message may name; anything else in braces is refused when saving. */
export const MESSAGE_PLACEHOLDERS = [
  'customerName', 'firstName', 'amount', 'dueDate', 'balance', 'contractNumber', 'agentName', 'agentPhone', 'companyName', 'supportPhone',
] as const;

/** PayTrigger's own limits: a lock-screen title of 80 characters, its text 400. */
export const LOCK_TITLE_MAX = 80;
export const LOCK_TIPS_MAX = 400;

const EDITABLE = {
  lockAfterOverdueDays: 'int', lockOnUnpaidAgentDeposit: 'bool', maxUnlockHorizonDays: 'int', releaseHoldHours: 'int',
  extendBreakerPercent: 'int', defaultRuleNum: 'int',
  lockTitle: 'title', lockTips: 'tips', depositHoldTitle: 'title', depositHoldTips: 'tips', unlinkedTitle: 'title', unlinkedTips: 'tips',
} as const;
export type EditablePayTriggerSettings = Partial<Pick<PayTriggerSettings, keyof typeof EDITABLE>>;

const RANGES: Partial<Record<keyof typeof EDITABLE, [number, number]>> = {
  lockAfterOverdueDays: [0, 30], maxUnlockHorizonDays: [7, 180], releaseHoldHours: [0, 720], extendBreakerPercent: [1, 100], defaultRuleNum: [0, 5],
};

/** Null if the body is a valid change, else why not. Unknown fields are ignored. */
export function validatePayTriggerSettings(body: Record<string, unknown>): string | null {
  for (const [field, kind] of Object.entries(EDITABLE) as Array<[keyof typeof EDITABLE, string]>) {
    const value = body[field];
    if (value === undefined) continue;
    if (kind === 'bool' && typeof value !== 'boolean') return `${field} must be true or false`;
    if (kind === 'int') {
      const [min, max] = RANGES[field]!;
      if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) return `${field} must be a whole number from ${min} to ${max}`;
    }
    if (kind === 'title' || kind === 'tips') {
      if (typeof value !== 'string' || !value.trim()) return `${field} cannot be empty`;
      const limit = kind === 'title' ? LOCK_TITLE_MAX : LOCK_TIPS_MAX;
      if (value.length > limit) return `${field} must be at most ${limit} characters`;
      const unknown = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((p) => !(MESSAGE_PLACEHOLDERS as readonly string[]).includes(p));
      if (unknown.length) return `${field} uses ${unknown.map((p) => `{${p}}`).join(', ')}, which is not one of: ${MESSAGE_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`;
    }
  }
  return null;
}

export async function updatePayTriggerSettings(changes: Record<string, unknown>, updatedById: string): Promise<PayTriggerSettings> {
  const data: Record<string, unknown> = { updatedById };
  for (const field of Object.keys(EDITABLE)) {
    if (changes[field] !== undefined) data[field] = typeof changes[field] === 'string' ? (changes[field] as string).trim() : changes[field];
  }
  const value = await prisma.payTriggerSettings.upsert({ where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID, ...data }, update: data });
  cached = { value, at: Date.now() };
  return value;
}

/** A template filled in; a value not given leaves an empty gap rather than the placeholder. */
export function fillTemplate(template: string, values: Partial<Record<(typeof MESSAGE_PLACEHOLDERS)[number], string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key as keyof typeof values] ?? '').replace(/\s+/g, ' ').trim();
}
