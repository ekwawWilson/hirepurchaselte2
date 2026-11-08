import type { PayTriggerSettings } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ledgerBalance } from '../services/agentLedgerService';
import { getOrgSettings } from '../services/orgSettingsService';
import { formatMoney } from '../utils/money';
import { payTriggerAction, PAYTRIGGER_PATHS } from './client';
import { logAction } from './reconcile';
import { fillTemplate } from './settings';

const DAY_MS = 24 * 60 * 60 * 1000;
const POPUP = 1;

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * A pop-up on the phone on the set days before its next instalment, at most
 * one a day per phone (PayTrigger allows three). Not for a phone that is
 * locked or held for an agent's deposit, where it could only mislead. Returns
 * how many went.
 */
export async function sendPaymentReminders(settings: PayTriggerSettings, now: Date = new Date()): Promise<number> {
  if (!settings.reminderEnabled) return 0;
  const daysBefore = new Set(settings.reminderDaysBefore.split(',').map((d) => parseInt(d, 10)));
  const today = startOfDay(now);
  const { companyName, phone } = await getOrgSettings();

  const devices = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: 'ACTIVE', contractId: { not: null }, committedState: { not: 'LOCKED' } } });
  let sent = 0;
  for (const device of devices) {
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: device.contractId! },
      select: {
        id: true, status: true, contractType: true, contractNumber: true, paymentFrequency: true, balanceMinor: true,
        customer: { select: { firstName: true, lastName: true } },
        createdBy: { select: { firstName: true, lastName: true, phone: true, role: { select: { name: true } } } },
        agentDepositLedger: { select: { amountOwedMinor: true, amountRemittedMinor: true, commissionPaidMinor: true } },
        instalments: { where: { status: { not: 'PAID' } }, orderBy: { instalmentNo: 'asc' }, take: 1, select: { dueDate: true, amountDueMinor: true, amountPaidMinor: true } },
      },
    });
    const next = contract.instalments[0];
    if (contract.status !== 'ACTIVE' || !next) continue;
    if (contract.paymentFrequency === 'DAILY' && !settings.reminderIncludeDaily) continue;
    if (!daysBefore.has(Math.round((startOfDay(next.dueDate).getTime() - today.getTime()) / DAY_MS))) continue;
    if (settings.lockOnUnpaidAgentDeposit && contract.createdBy.role.name === 'AGENT') {
      const owed = contract.agentDepositLedger ? ledgerBalance(contract.agentDepositLedger) : null;
      if (owed === null || owed > 0) continue;
    }
    if (await prisma.payTriggerActionLog.count({ where: { deviceId: device.id, action: 'REMIND', success: true, createdAt: { gte: today } } }) > 0) continue;

    const values = {
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      firstName: contract.customer.firstName,
      amount: `GHS ${formatMoney(next.amountDueMinor - next.amountPaidMinor)}`,
      dueDate: next.dueDate.toISOString().slice(0, 10),
      balance: `GHS ${formatMoney(contract.balanceMinor ?? 0)}`,
      contractNumber: contract.contractNumber,
      agentName: `${contract.createdBy.firstName} ${contract.createdBy.lastName}`,
      agentPhone: contract.createdBy.phone ?? phone ?? '',
      companyName,
      supportPhone: phone ?? '',
    };
    const result = await payTriggerAction(PAYTRIGGER_PATHS.sendPush, {
      imei: device.imei, deviceTag: device.deviceTag ?? undefined, title: fillTemplate(settings.reminderTitle, values), content: fillTemplate(settings.reminderText, values), pushType: POPUP,
    });
    await logAction({ deviceId: device.id, contractId: contract.id, action: 'REMIND', result });
    if (result.success) sent += 1;
  }
  return sent;
}
