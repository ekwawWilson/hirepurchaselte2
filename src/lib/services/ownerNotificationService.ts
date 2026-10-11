import { prisma } from '../db/prisma';
import { getControlSettings } from './controlSettingsService';
import { deliverQueuedSms } from './smsService';

/**
 * Texts the owner's number (Settings > Controls). Goes through the same
 * SmsMessage record and provider as every customer message, so it shows in
 * the same history and fails the same visible way. A no-op, returning false,
 * until an owner number is set.
 */
export async function sendOwnerSms(templateKey: 'owner.alert' | 'owner.daily_summary', body: string): Promise<boolean> {
  const { ownerPhone } = await getControlSettings();
  if (!ownerPhone) return false;
  const sms = await prisma.smsMessage.create({ data: { recipient: ownerPhone, templateKey, body, status: 'QUEUED' } });
  await deliverQueuedSms(sms.id);
  return true;
}
