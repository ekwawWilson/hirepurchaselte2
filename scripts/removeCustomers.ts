/**
 * One-off cleanup: permanently removes a named list of customers and every
 * record financially/operationally linked to them — contracts, instalments,
 * payments (+ allocations), penalties, Hubtel transactions/preapprovals, and
 * related SMS messages. Nothing here is soft-deleted; this is a real, hard
 * removal, unlike the rest of the app's "reverse, never delete" ledger rule
 * (paymentService.ts) — that rule is for correcting a mistaken transaction on
 * a customer who stays in the system, not for erasing the customer entirely.
 *
 * Any inventory unit that was RESERVED/ISSUED against one of the deleted
 * contracts is reset to AVAILABLE — otherwise it would be stuck showing as
 * unavailable with no contract left to explain why.
 *
 * AuditLog rows are deliberately left alone (entityId is a plain string, not
 * a foreign key) — an audit trail is meant to survive the entity it
 * describes, the same reasoning stock exchanges/banks keep deletion logs.
 *
 * Dry-run by default: prints exactly what it found and would delete. Pass
 * --confirm to actually perform the deletion.
 *
 * Usage:
 *   npx tsx scripts/removeCustomers.ts            # dry run
 *   npx tsx scripts/removeCustomers.ts --confirm   # actually deletes
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FULL_NAMES = [
  'Prince Quartey',
  'Ekow Beecham',
  'Isaac Appiah',
  'Emmanuel Zple',
  'Winfred Quarty',
  'Kofi Mensah',
  'Kofi Boateng',
  'Kwame Mensah',
  'Efua Asante',
  'Ama Owusu',
  'Yaw Appiah',
  'Akosua Darko',
];

async function main() {
  const confirm = process.argv.includes('--confirm');

  const namePairs = FULL_NAMES.map((full) => {
    const [firstName, ...rest] = full.trim().split(/\s+/);
    return { firstName, lastName: rest.join(' ') };
  });

  const customers = await prisma.customer.findMany({
    where: {
      OR: namePairs.map((n) => ({
        firstName: { equals: n.firstName, mode: 'insensitive' as const },
        lastName: { equals: n.lastName, mode: 'insensitive' as const },
      })),
    },
  });

  const foundNames = new Set(customers.map((c) => `${c.firstName} ${c.lastName}`.toLowerCase()));
  const notFound = FULL_NAMES.filter((n) => !foundNames.has(n.toLowerCase()));

  console.log(`Matched ${customers.length} of ${FULL_NAMES.length} names:`);
  for (const c of customers) {
    console.log(`  - ${c.firstName} ${c.lastName}  (${c.membershipId}, id=${c.id}, phone=${c.phone ?? c.phone2 ?? c.phone3 ?? '—'})`);
  }
  if (notFound.length > 0) {
    console.log(`\nNo match found for: ${notFound.join(', ')}`);
  }

  if (customers.length === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  const customerIds = customers.map((c) => c.id);
  const contracts = await prisma.contract.findMany({ where: { customerId: { in: customerIds } } });
  const contractIds = contracts.map((c) => c.id);
  const payments = await prisma.payment.findMany({ where: { contractId: { in: contractIds } } });
  const paymentIds = payments.map((p) => p.id);
  const inventoryItemIds = [...new Set(contracts.map((c) => c.inventoryItemId).filter((id): id is string => !!id))];

  const [instalmentCount, penaltyCount, hubtelTxnCount, preapprovalCount, smsCount, allocationCount] = await Promise.all([
    prisma.instalment.count({ where: { contractId: { in: contractIds } } }),
    prisma.penalty.count({ where: { contractId: { in: contractIds } } }),
    prisma.hubtelTransaction.count({ where: { contractId: { in: contractIds } } }),
    prisma.hubtelPreapproval.count({ where: { customerId: { in: customerIds } } }),
    prisma.smsMessage.count({ where: { OR: [{ relatedContractId: { in: contractIds } }, { relatedCustomerId: { in: customerIds } }, { relatedPaymentId: { in: paymentIds } }] } }),
    prisma.paymentAllocation.count({ where: { paymentId: { in: paymentIds } } }),
  ]);

  console.log(`\nWill delete:`);
  console.log(`  ${customers.length} customer(s)`);
  console.log(`  ${contracts.length} contract(s)`);
  console.log(`  ${payments.length} payment(s), ${allocationCount} payment allocation(s)`);
  console.log(`  ${instalmentCount} instalment(s), ${penaltyCount} penalty(ies)`);
  console.log(`  ${hubtelTxnCount} Hubtel transaction(s), ${preapprovalCount} Hubtel preapproval(s)`);
  console.log(`  ${smsCount} SMS message(s)`);
  console.log(`  Will reset ${inventoryItemIds.length} inventory item(s) still RESERVED/ISSUED back to AVAILABLE`);

  if (!confirm) {
    console.log('\nDry run only — nothing was deleted. Re-run with --confirm to actually delete.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await tx.smsMessage.deleteMany({ where: { OR: [{ relatedContractId: { in: contractIds } }, { relatedCustomerId: { in: customerIds } }, { relatedPaymentId: { in: paymentIds } }] } });
    await tx.hubtelTransaction.deleteMany({ where: { contractId: { in: contractIds } } });
    await tx.penalty.deleteMany({ where: { contractId: { in: contractIds } } });
    await tx.instalment.deleteMany({ where: { contractId: { in: contractIds } } });
    await tx.payment.deleteMany({ where: { contractId: { in: contractIds } } });
    await tx.ussdSession.deleteMany({ where: { contractId: { in: contractIds } } });
    await tx.contract.deleteMany({ where: { id: { in: contractIds } } });
    await tx.hubtelPreapproval.deleteMany({ where: { customerId: { in: customerIds } } });
    await tx.customer.deleteMany({ where: { id: { in: customerIds } } });

    if (inventoryItemIds.length > 0) {
      await tx.inventoryItem.updateMany({
        where: { id: { in: inventoryItemIds }, status: { in: ['RESERVED', 'ISSUED'] } },
        data: { status: 'AVAILABLE' },
      });
    }
  });

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
