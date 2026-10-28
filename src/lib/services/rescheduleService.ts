import { prisma } from '../db/prisma';
import { ContractError } from './contractService';
import { resettleContract } from './paymentService';
import { generateStraightLineSchedule } from './scheduleService';
import { getWorkingDays } from './operatingSettingsService';
import { notifyPayTrigger } from '../paytrigger/notify';
import {
  DEPOSIT_INSTALMENT_FREQUENCIES, DEPOSIT_INSTALMENT_MIN_TERM_WEEKS, DEPOSIT_INSTALMENT_MAX_TERM_WEEKS,
  type PaymentFrequencyName, isInstalmentSale,
} from '../constants/contracts';

/** What of a contract's instalments is still to be paid — the amount a reschedule spreads out again. */
export async function outstandingOnSchedule(contractId: string): Promise<number> {
  const instalments = await prisma.instalment.findMany({ where: { contractId } });
  return instalments.reduce((sum, i) => sum + Math.max(0, i.amountDueMinor - i.amountPaidMinor), 0);
}

/**
 * Gives a customer who has fallen behind a new plan for what they still owe,
 * instead of leaving them in arrears on dates that have already gone.
 *
 * Nothing already paid is touched: a fully paid instalment stays; a part-paid
 * one is closed at what was paid on it; instalments nothing was paid on are
 * removed. What was still owed across all of them is then spread evenly over
 * the new term, from the new start date. The total the customer owes does
 * not change — only when it falls due. Late fees already charged stay owed.
 */
export async function rescheduleContract(params: {
  contractId: string; termWeeks: number; paymentFrequency: PaymentFrequencyName; startDate?: Date; reason: string; userId: string;
}) {
  if (!Number.isInteger(params.termWeeks) || params.termWeeks < DEPOSIT_INSTALMENT_MIN_TERM_WEEKS || params.termWeeks > DEPOSIT_INSTALMENT_MAX_TERM_WEEKS) {
    throw new ContractError(`The new term must be between ${DEPOSIT_INSTALMENT_MIN_TERM_WEEKS} and ${DEPOSIT_INSTALMENT_MAX_TERM_WEEKS} weeks`);
  }
  if (!(DEPOSIT_INSTALMENT_FREQUENCIES as readonly string[]).includes(params.paymentFrequency)) {
    throw new ContractError(`paymentFrequency must be one of: ${DEPOSIT_INSTALMENT_FREQUENCIES.join(', ')}`);
  }
  const startDate = params.startDate ?? new Date();
  if (Number.isNaN(startDate.getTime())) throw new ContractError('The start date is not a valid date');

  const rescheduled = await prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });
    if (!isInstalmentSale(contract.contractType)) throw new ContractError('Only a deposit and instalment contract has a schedule to change');
    if (!['ACTIVE', 'DEFAULTED'].includes(contract.status)) {
      throw new ContractError(`Cannot reschedule a contract in status ${contract.status}`);
    }

    const instalments = await tx.instalment.findMany({ where: { contractId: contract.id }, orderBy: { instalmentNo: 'asc' } });
    const unpaid = instalments.filter((i) => i.amountPaidMinor < i.amountDueMinor);
    const outstandingMinor = unpaid.reduce((sum, i) => sum + (i.amountDueMinor - i.amountPaidMinor), 0);
    if (outstandingMinor <= 0) throw new ContractError('Nothing is left to pay on this schedule');

    const before = unpaid.map((i) => ({ instalmentNo: i.instalmentNo, dueDate: i.dueDate, amountDueMinor: i.amountDueMinor, amountPaidMinor: i.amountPaidMinor }));

    const untouched = unpaid.filter((i) => i.amountPaidMinor === 0).map((i) => i.id);
    // A late fee stays owed on the contract after the instalment it was charged on is gone.
    await tx.penalty.updateMany({ where: { instalmentId: { in: untouched } }, data: { instalmentId: null } });
    await tx.instalment.deleteMany({ where: { id: { in: untouched } } });
    for (const partPaid of unpaid.filter((i) => i.amountPaidMinor > 0)) {
      await tx.instalment.update({
        where: { id: partPaid.id },
        data: { amountDueMinor: partPaid.amountPaidMinor, principalPortionMinor: partPaid.amountPaidMinor, status: 'PAID', paidAt: partPaid.paidAt ?? new Date() },
      });
    }

    const kept = instalments.filter((i) => !untouched.includes(i.id));
    const lastNo = kept.reduce((max, i) => Math.max(max, i.instalmentNo), 0);
    const count = params.paymentFrequency === 'DAILY' ? params.termWeeks * 7 : params.termWeeks;
    const schedule = generateStraightLineSchedule(outstandingMinor, 1, startDate, params.paymentFrequency, count, await getWorkingDays(tx));
    await tx.instalment.createMany({
      data: schedule.map((s) => ({
        contractId: contract.id,
        instalmentNo: lastNo + s.instalmentNo,
        dueDate: s.dueDate,
        amountDueMinor: s.amountDueMinor,
        principalPortionMinor: s.principalPortionMinor,
        interestPortionMinor: s.interestPortionMinor,
      })),
    });

    await tx.contract.update({
      where: { id: contract.id },
      data: { paymentFrequency: params.paymentFrequency, instalmentAmountMinor: schedule[0].amountDueMinor, updatedById: params.userId },
    });
    // Nothing is overdue on the new dates, so a defaulted contract is live again.
    await resettleContract(tx, contract.id);

    return {
      contract: await tx.contract.findUniqueOrThrow({ where: { id: contract.id } }),
      outstandingMinor,
      before,
      schedule: schedule.map((s) => ({ instalmentNo: lastNo + s.instalmentNo, dueDate: s.dueDate, amountDueMinor: s.amountDueMinor })),
    };
  });
  notifyPayTrigger(rescheduled.contract.id, 'CONTRACT_CHANGED', rescheduled.contract.contractType);
  return rescheduled;
}
