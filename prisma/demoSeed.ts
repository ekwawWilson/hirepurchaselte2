/**
 * Business demo data: product categories, products priced across all three
 * contract types, customers, inventory, one contract of each type per a
 * couple of customers, and a few posted payments so reports/dashboards have
 * something real to show. Requires `npm run db:seed` to have already run
 * (needs the MAIN branch and the seeded admin user as the acting party).
 *
 * Goes through the same service-layer functions the app itself uses
 * (createContract, postPayment, createPriceChartEntry, receiveInventoryItem)
 * rather than raw prisma.create calls, so generated data — contract numbers,
 * instalment schedules, ledger totals — is exactly as correct as data a real
 * user would have produced through the UI. Reasonably safe to re-run: products
 * and customers are skipped if a same-named/same-phone one already exists,
 * and contracts are skipped per customer+product pair already covered.
 *
 * Never run against a real production database — see prisma/seed.ts's own
 * warning; this creates business records against the seeded demo users, the
 * same reasoning that keeps that script dev/CI/staging-only.
 */
import { PrismaClient } from '@prisma/client';
import { createContract } from '../src/lib/services/contractService';
import { postPayment } from '../src/lib/services/paymentService';
import { createPriceChartEntry } from '../src/lib/services/priceChartService';
import { receiveInventoryItem } from '../src/lib/services/inventoryService';
import { generateProductSku, generateMembershipId } from '../src/lib/utils/idGenerators';

const prisma = new PrismaClient();

const CATEGORIES = ['Smartphones', 'Laptops'];

const PRODUCTS = [
  { name: 'iPhone 13', category: 'Smartphones', cashPriceMinor: 350000, brand: 'Apple', model: 'A2482' },
  { name: 'Samsung Galaxy A54', category: 'Smartphones', cashPriceMinor: 220000, brand: 'Samsung', model: 'SM-A546' },
  { name: 'HP Laptop 15', category: 'Laptops', cashPriceMinor: 450000, brand: 'HP', model: '15-fd0000' },
];

const CUSTOMERS = [
  { firstName: 'Ama', lastName: 'Owusu', phone: '0200000001' },
  { firstName: 'Kwame', lastName: 'Mensah', phone: '0200000002' },
  { firstName: 'Efua', lastName: 'Asante', phone: '0200000003' },
  { firstName: 'Kofi', lastName: 'Boateng', phone: '0200000004' },
  { firstName: 'Akosua', lastName: 'Darko', phone: '0200000005' },
  { firstName: 'Yaw', lastName: 'Appiah', phone: '0200000006' },
];

async function main() {
  const branch = await prisma.branch.findUnique({ where: { code: 'MAIN' } });
  if (!branch) throw new Error('MAIN branch not found — run `npm run db:seed` first');
  const admin = await prisma.user.findUnique({ where: { email: 'admin@zple.test' } });
  if (!admin) throw new Error('Seeded admin user not found — run `npm run db:seed` first');

  const categoryByName = new Map<string, string>();
  for (const name of CATEGORIES) {
    const category = await prisma.productCategory.upsert({ where: { name }, update: {}, create: { name } });
    categoryByName.set(name, category.id);
  }

  const products: Array<{ id: string; name: string }> = [];
  for (const p of PRODUCTS) {
    let product = await prisma.product.findFirst({ where: { name: p.name } });
    if (!product) {
      product = await prisma.product.create({
        data: {
          sku: await generateProductSku(),
          name: p.name,
          brand: p.brand,
          model: p.model,
          cashPriceMinor: p.cashPriceMinor,
          categoryId: categoryByName.get(p.category) ?? null,
        },
      });
      // One 6-month tier across all three contract types — enough for a
      // contract of each type to actually price and create successfully.
      await createPriceChartEntry({
        productId: product.id, contractType: 'SAVE_TO_OWN', termMonths: 6, paymentFrequency: 'MONTHLY',
        depositAmountMinor: 0, totalPayableMinor: Math.round(p.cashPriceMinor * 1.15), createdById: admin.id,
      });
      await createPriceChartEntry({
        productId: product.id, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, paymentFrequency: 'MONTHLY',
        depositAmountMinor: Math.round(p.cashPriceMinor * 0.2), totalPayableMinor: Math.round(p.cashPriceMinor * 1.15),
        createdById: admin.id,
      });
      await createPriceChartEntry({
        productId: product.id, contractType: 'DEVICE_LOAN', termMonths: 6, paymentFrequency: 'MONTHLY',
        depositAmountMinor: 0, totalPayableMinor: Math.round(p.cashPriceMinor * 1.24), interestRateBps: 2400,
        createdById: admin.id,
      });
    }
    products.push({ id: product.id, name: product.name });
  }

  const customers: Array<{ id: string; name: string }> = [];
  for (const c of CUSTOMERS) {
    let customer = await prisma.customer.findUnique({ where: { phone: c.phone } });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          membershipId: await generateMembershipId(branch.code),
          firstName: c.firstName, lastName: c.lastName, phone: c.phone,
          branchId: branch.id, createdById: admin.id,
        },
      });
    }
    customers.push({ id: customer.id, name: `${c.firstName} ${c.lastName}` });
  }

  // One contract of each type per the first two customers, against the first
  // two (store-carried) products — DEVICE_LOAN disburses cash, no unit
  // reserved, so it's the one type that doesn't need an inventory item.
  const contractPlans: Array<{ contractType: 'SAVE_TO_OWN' | 'DEPOSIT_INSTALMENT' | 'DEVICE_LOAN'; customerIdx: number; productIdx: number }> = [
    { contractType: 'SAVE_TO_OWN', customerIdx: 0, productIdx: 0 },
    { contractType: 'SAVE_TO_OWN', customerIdx: 1, productIdx: 1 },
    { contractType: 'DEPOSIT_INSTALMENT', customerIdx: 2, productIdx: 0 },
    { contractType: 'DEPOSIT_INSTALMENT', customerIdx: 3, productIdx: 1 },
    { contractType: 'DEVICE_LOAN', customerIdx: 4, productIdx: 2 },
    { contractType: 'DEVICE_LOAN', customerIdx: 5, productIdx: 2 },
  ];

  let contractsCreated = 0;
  let paymentsPosted = 0;
  for (const [i, plan] of contractPlans.entries()) {
    const customer = customers[plan.customerIdx];
    const product = products[plan.productIdx];

    const existing = await prisma.contract.findFirst({
      where: { customerId: customer.id, productId: product.id, contractType: plan.contractType },
    });
    if (existing) continue;

    let inventoryItemId: string | undefined;
    if (plan.contractType !== 'DEVICE_LOAN') {
      const item = await receiveInventoryItem({
        productId: product.id, branchId: branch.id, serialNumber: `DEMO-${product.id.slice(0, 8)}-${i}`, createdById: admin.id,
      });
      inventoryItemId = item.id;
    }

    const contract = await createContract({
      contractType: plan.contractType,
      customerId: customer.id,
      inventoryItemId,
      productId: plan.contractType === 'DEVICE_LOAN' ? product.id : undefined,
      termMonths: 6,
      branchId: branch.id,
      createdById: admin.id,
    });
    contractsCreated += 1;

    // Give most contracts a bit of payment history — leave one of each pair
    // untouched (PENDING_DEPOSIT / freshly ACTIVE) so statuses look realistic
    // rather than everything being mid-payment.
    if (i % 2 === 0) {
      const entryType = plan.contractType === 'DEPOSIT_INSTALMENT' ? 'DEPOSIT' : 'INSTALMENT_PAYMENT';
      const amountMinor = plan.contractType === 'DEPOSIT_INSTALMENT'
        ? contract.depositAmountMinor
        : Math.round(contract.totalPayableMinor * 0.3);
      if (amountMinor > 0) {
        await postPayment({ contractId: contract.id, amountMinor, entryType, channel: 'CASH', createdById: admin.id });
        paymentsPosted += 1;
      }
    }
  }

  console.log(`\nSeeded ${categoryByName.size} categories, ${products.length} products (each priced for all 3 contract types),`);
  console.log(`${customers.length} customers, ${contractsCreated} new contract(s), ${paymentsPosted} payment(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
