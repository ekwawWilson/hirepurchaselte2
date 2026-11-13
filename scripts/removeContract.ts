/**
 * One-off cleanup: permanently removes a contract entered by mistake or as a
 * test, and every record linked to it: payments (+ allocations), instalments,
 * late charges, Hubtel transactions, text messages, USSD sessions, agent
 * ledger rows (+ remittances and payouts), completion commission, approval
 * requests, collection notes and temporary unlocks. With --with-customer, the
 * customer goes too, if they have no other contract.
 *
 * Nothing here is soft-deleted, unlike the app's "reverse, never delete"
 * rule (paymentService.ts), which is for correcting a real customer's
 * account. Audit and PayTrigger action logs are kept: a log outlives what it
 * describes. Money the payments record is not refunded by this.
 *
 * The phone or unit goes back into stock as AVAILABLE. A PayTrigger phone
 * stays enrolled and is unlinked, ready for its next sale; until then it
 * locks at the lock date it holds, like any unsold phone.
 *
 * Dry run by default. Run ./backup.sh first, then add --confirm.
 *
 * Usage (inside the app container on the server):
 *   npx tsx scripts/removeContract.ts <contract number or IMEI> [--with-customer]            # dry run
 *   npx tsx scripts/removeContract.ts <contract number or IMEI> [--with-customer] --confirm  # deletes
 */
import { prisma } from '../src/lib/db/prisma';

const confirm = process.argv.includes('--confirm');
const withCustomer = process.argv.includes('--with-customer');
const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
const cedis = (minor: number) => `GHS ${(minor / 100).toFixed(2)}`;

async function main() {
  if (!target) throw new Error('Give a contract number or the IMEI of the unit sold on it');
  const item = await prisma.inventoryItem.findUnique({ where: { serialNumber: target } });
  const contracts = await prisma.contract.findMany({
    where: item ? { inventoryItemId: item.id, status: { not: 'CANCELLED' } } : { contractNumber: target },
    include: { customer: true },
  });
  if (contracts.length !== 1) throw new Error(`Expected one contract for ${target}, found ${contracts.length}`);
  const contract = contracts[0];
  const customer = contract.customer;

  const payments = await prisma.payment.findMany({ where: { contractId: contract.id }, select: { id: true, amountMinor: true, entryType: true, channel: true } });
  const paymentIds = payments.map((p) => p.id);
  const ledgers = await prisma.agentDepositLedger.findMany({ where: { contractId: contract.id }, select: { id: true } });
  const ledgerIds = ledgers.map((l) => l.id);
  const otherContracts = await prisma.contract.count({ where: { customerId: customer.id, id: { not: contract.id } } });
  const removeCustomer = withCustomer && otherContracts === 0;
  const smsWhere = { OR: [{ relatedContractId: contract.id }, { relatedPaymentId: { in: paymentIds } }, ...(removeCustomer ? [{ relatedCustomerId: customer.id }] : [])] };

  const counts = {
    payments: payments.length,
    allocations: await prisma.paymentAllocation.count({ where: { paymentId: { in: paymentIds } } }),
    instalments: await prisma.instalment.count({ where: { contractId: contract.id } }),
    lateCharges: await prisma.penalty.count({ where: { contractId: contract.id } }),
    hubtelTransactions: await prisma.hubtelTransaction.count({ where: { contractId: contract.id } }),
    textMessages: await prisma.smsMessage.count({ where: smsWhere }),
    ussdSessions: await prisma.ussdSession.count({ where: { contractId: contract.id } }),
    agentLedgerRows: ledgerIds.length,
    remittances: await prisma.agentRemittance.count({ where: { ledgerId: { in: ledgerIds } } }),
    commissionPayouts: await prisma.agentCommissionPayout.count({ where: { ledgerId: { in: ledgerIds } } }),
    completionCommissions: await prisma.agentCompletionCommission.count({ where: { contractId: contract.id } }),
    approvalRequests: await prisma.approvalRequest.count({ where: { contractId: contract.id } }),
    collectionNotes: await prisma.collectionNote.count({ where: { contractId: contract.id } }),
    temporaryUnlocks: await prisma.payTriggerTemporaryUnlock.count({ where: { contractId: contract.id } }),
  };
  // Recorded against the first super admin: this runs on the server, not as a signed-in user.
  const actor = await prisma.user.findFirstOrThrow({ where: { role: { name: 'SUPER_ADMIN' } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const device = contract.inventoryItemId ? await prisma.payTriggerDevice.findUnique({ where: { inventoryItemId: contract.inventoryItemId } }) : null;
  const unit = contract.inventoryItemId ? await prisma.inventoryItem.findUnique({ where: { id: contract.inventoryItemId } }) : null;

  console.log(`${confirm ? 'REMOVING' : 'DRY RUN: nothing is changed'}`);
  console.log(`${contract.contractNumber} ${contract.contractType} ${contract.status}, customer ${customer.firstName} ${customer.lastName} (${customer.membershipId}), paid ${cedis(contract.totalPaidMinor)}`);
  console.log(`  payments: ${payments.map((p) => `${p.entryType} ${p.channel} ${cedis(p.amountMinor)}`).join('; ') || 'none'}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
  console.log(`  customer: ${removeCustomer ? 'removed' : withCustomer ? `kept (${otherContracts} other contract(s))` : 'kept'}`);
  if (unit) console.log(`  unit ${unit.serialNumber}: ${unit.status} -> AVAILABLE`);
  if (device) console.log(`  PayTrigger phone: ${device.enrollmentStatus}, unlinked and left enrolled`);
  if (!confirm) return;

  await prisma.$transaction(async (tx) => {
    await tx.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await tx.payTriggerTemporaryUnlock.deleteMany({ where: { contractId: contract.id } });
    await tx.smsMessage.deleteMany({ where: smsWhere });
    await tx.hubtelTransaction.deleteMany({ where: { contractId: contract.id } });
    await tx.agentRemittance.deleteMany({ where: { ledgerId: { in: ledgerIds } } });
    await tx.agentCommissionPayout.deleteMany({ where: { ledgerId: { in: ledgerIds } } });
    await tx.agentDepositLedger.deleteMany({ where: { contractId: contract.id } });
    await tx.agentCompletionCommission.deleteMany({ where: { contractId: contract.id } });
    await tx.approvalRequest.deleteMany({ where: { contractId: contract.id } });
    await tx.collectionNote.deleteMany({ where: { contractId: contract.id } });
    await tx.penalty.deleteMany({ where: { contractId: contract.id } });
    await tx.instalment.deleteMany({ where: { contractId: contract.id } });
    // A reversal points at the payment it reverses: those go first.
    await tx.payment.deleteMany({ where: { contractId: contract.id, reversesPaymentId: { not: null } } });
    await tx.payment.deleteMany({ where: { contractId: contract.id } });
    await tx.ussdSession.deleteMany({ where: { contractId: contract.id } });
    if (device) await tx.payTriggerDevice.update({ where: { id: device.id }, data: { contractId: null, fingerprint: null, releaseAfter: null, releaseHeld: false, awaitingPinSince: null, scheduleExpiresAt: null } });
    await tx.contract.delete({ where: { id: contract.id } });
    if (removeCustomer) {
      await tx.customerPasswordReset.deleteMany({ where: { customerId: customer.id } });
      await tx.hubtelPreapproval.deleteMany({ where: { customerId: customer.id } });
      await tx.customer.delete({ where: { id: customer.id } });
    }
    if (unit && unit.status !== 'AVAILABLE') {
      await tx.inventoryItem.update({ where: { id: unit.id }, data: { status: 'AVAILABLE' } });
      await tx.stockMovement.create({
        data: { inventoryItemId: unit.id, productId: unit.productId, branchId: unit.branchId, type: 'ADJUSTMENT', reason: `Back to stock: contract ${contract.contractNumber} removed as entered in error`, createdById: actor.id },
      });
    }
    await tx.auditLog.create({
      data: {
        userId: actor.id, action: 'CONTRACT_REMOVED', entityType: 'Contract', entityId: contract.id,
        oldValues: JSON.stringify({ contractNumber: contract.contractNumber, customer: `${customer.firstName} ${customer.lastName}`, membershipId: customer.membershipId, totalPaidMinor: contract.totalPaidMinor, paymentRows: payments, ...counts, customerRemoved: removeCustomer }),
      },
    });
  }, { timeout: 60_000 });
  console.log('Done.');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
