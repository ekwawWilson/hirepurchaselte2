import { prisma } from '../db/prisma';
import { formatMoney } from '../utils/money';
import { initiateHubtelPayment } from './hubtelPaymentService';
import { getOrgSettings } from './orgSettingsService';
import { contractTypeLabel, formatDate } from '../utils';
import { phoneVariants } from './hubtelClient';

const SESSION_TTL_MINUTES = 5;

interface UssdContext {
  contractIds?: string[];
  contractId?: string;
  amountMinor?: number;
}

/**
 * `label`/`fieldType` exist only to satisfy Hubtel's Programmable Services
 * response contract (Label and FieldType are Mandatory fields there — see
 * the API docs' Response Parameters table); `dataType` itself isn't carried
 * here because it's always derivable 1:1 from continueSession at the route
 * layer ("input" while the session continues, "display" once it ends).
 */
export interface UssdResult {
  message: string;
  continueSession: boolean;
  label: string;
  fieldType?: 'text' | 'number' | 'decimal' | 'phone';
}

const ALT_PHONE_PROMPT = 'Enter a registered phone number to continue, or 0 to cancel:';

// A customer can dial in from any of their three registered numbers, not just
// whichever one happens to be stored in the "main" slot (customerService.ts) —
// and, via ENTER_ALT_PHONE below, from a number that isn't registered at all
// (a shared/agent phone) as long as they can type in one that is.
// Hubtel's real dial-in "Mobile" always arrives 233-prefixed; a customer's
// number is stored exactly as typed at registration (0-prefixed, 233-prefixed
// or +233-prefixed, all seen in practice) — so every equivalent form has to be
// tried, or a real dial-in from a correctly-registered customer never matches.
function findCustomerByPhone(msisdn: string) {
  const variants = phoneVariants(msisdn);
  return prisma.customer.findFirst({
    where: { OR: variants.flatMap((v) => [{ phone: v }, { phone2: v }, { phone3: v }]) },
  });
}

/**
 * Shared by beginForCustomer and the SELECT_CONTRACT handler so the two never
 * drift. Content differs by contract type since SAVE_TO_OWN has no due
 * schedule to report against (contractService.ts) — it's free-form savings,
 * so all there is to show is the running total paid in. DEPOSIT_INSTALMENT
 * and DEVICE_LOAN both have one, so they get paid/remaining plus whatever's
 * next: the upcoming instalment normally, or — when the customer has fallen
 * behind — the overdue amount they actually owe right now *and* what follows
 * it, rather than silently quoting a future date as if nothing were wrong.
 *
 * Opens with "{companyName}\nHi {full name}" — the tenant's own configured
 * company name (Settings page, same source startSession's no-account-found
 * message uses), not the application's default branding, since this is a
 * customer-facing screen. The customer should see who they're paying and
 * their own name the moment they dial in, not an account/contract number.
 *
 * Kept deliberately terse otherwise (abbreviated labels, no contract-type
 * name here) to stay well inside a USSD screen's character budget — this app
 * has no confirmed figure from Hubtel for this build, but industry-standard
 * gateways commonly cap a single screen around 182 characters, and the worst
 * case here (overdue, six-figure amounts, an unusually long company/customer
 * name) still lands well under that.
 */
async function contractPrompt(contract: {
  id: string;
  contractType: string;
  balanceMinor: number;
  totalPaidMinor: number;
}, customerName: string): Promise<string> {
  const { companyName } = await getOrgSettings();
  const greeting = `${companyName}\nHi ${customerName}\n`;
  if (contract.contractType === 'SAVE_TO_OWN') {
    return `${greeting}Total paid: GHS${formatMoney(contract.totalPaidMinor)}\nEnter amount to pay:`;
  }

  const [due, upcoming] = await prisma.instalment.findMany({
    where: { contractId: contract.id, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
    orderBy: { instalmentNo: 'asc' },
    take: 2,
  });

  const paidLine = `Paid GHS${formatMoney(contract.totalPaidMinor)}  Bal GHS${formatMoney(contract.balanceMinor)}`;
  let dueLine = '';
  if (due) {
    const dueAmount = due.amountDueMinor - due.amountPaidMinor;
    dueLine = due.status === 'OVERDUE'
      ? `OVERDUE GHS${formatMoney(dueAmount)} (due ${formatDate(due.dueDate)})` +
        (upcoming ? `\nNext GHS${formatMoney(upcoming.amountDueMinor - upcoming.amountPaidMinor)} on ${formatDate(upcoming.dueDate)}` : '')
      : `Due GHS${formatMoney(dueAmount)} on ${formatDate(due.dueDate)}`;
  }

  return `${greeting}${paidLine}${dueLine ? `\n${dueLine}` : ''}\nEnter amount to pay:`;
}

/**
 * Looks up this customer's payable contracts and writes/advances the session
 * to whichever next state applies — shared by the normal dial-in path and by
 * ENTER_ALT_PHONE once a typed-in number resolves to an account, via upsert
 * since only the latter has an existing session row to update. `dialedMsisdn`
 * is always the phone actually dialed in (what a payment gets billed to) —
 * never an alternate number typed in purely to *find* the account.
 */
async function beginForCustomer(sessionId: string, dialedMsisdn: string, customerId: string, customerName: string): Promise<UssdResult> {
  // DEFAULTED is deliberately included: it isn't a terminal status (see
  // overdueService.markDefaultedContracts / paymentService.advanceContractStatus) —
  // a customer catching up their own arrears via USSD is exactly the self-service
  // path that cures a default, so hiding it here would strand them on cash-only.
  const contracts = await prisma.contract.findMany({
    where: { customerId, balanceMinor: { gt: 0 }, status: { in: ['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (contracts.length === 0) {
    await prisma.ussdSession.deleteMany({ where: { sessionId } }); // no-op if no row exists yet (fresh dial-in)
    return { message: 'You have no contracts with an outstanding balance.', continueSession: false, label: 'Nothing due' };
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);

  if (contracts.length > 1) {
    const context: UssdContext = { contractIds: contracts.map((c) => c.id) };
    await prisma.ussdSession.upsert({
      where: { sessionId },
      create: { sessionId, msisdn: dialedMsisdn, state: 'SELECT_CONTRACT', context: JSON.stringify(context), expiresAt },
      update: { state: 'SELECT_CONTRACT', contractId: null, context: JSON.stringify(context), expiresAt },
    });
    const lines = contracts.map((c, i) => `${i + 1}. ${c.contractNumber} (${contractTypeLabel(c.contractType)}) Bal GHS${formatMoney(c.balanceMinor)}`);
    const { companyName } = await getOrgSettings();
    return { message: `${companyName}\nHi ${customerName}\nSelect a contract:\n${lines.join('\n')}`, continueSession: true, label: 'Select contract', fieldType: 'number' };
  }

  const contract = contracts[0];
  const context: UssdContext = { contractId: contract.id };
  await prisma.ussdSession.upsert({
    where: { sessionId },
    create: { sessionId, msisdn: dialedMsisdn, state: 'ENTER_AMOUNT', contractId: contract.id, context: JSON.stringify(context), expiresAt },
    update: { state: 'ENTER_AMOUNT', contractId: contract.id, context: JSON.stringify(context), expiresAt },
  });
  return { message: await contractPrompt(contract, customerName), continueSession: true, label: 'Enter amount', fieldType: 'decimal' };
}

async function startSession(sessionId: string, msisdn: string): Promise<UssdResult> {
  const customer = await findCustomerByPhone(msisdn);
  if (customer) return beginForCustomer(sessionId, msisdn, customer.id, `${customer.firstName} ${customer.lastName}`);

  // Unrecognized dial-in number (e.g. a shared or agent phone) — let them
  // identify their account by typing in a registered number instead of
  // dead-ending the session outright. The tenant's own configured company
  // name (Settings page), not the application's default branding — this is
  // a customer-facing message, so it should read as coming from the
  // business, not the product.
  const { companyName } = await getOrgSettings();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);
  await prisma.ussdSession.create({
    data: { sessionId, msisdn, state: 'ENTER_ALT_PHONE', expiresAt },
  });
  return {
    message: `No ${companyName} account found for this number.\n${ALT_PHONE_PROMPT}`,
    continueSession: true,
    label: 'Enter phone number',
    fieldType: 'phone',
  };
}

async function endSession(sessionId: string) {
  await prisma.ussdSession.delete({ where: { id: sessionId } }).catch(() => undefined);
}

/**
 * Advances the USSD menu state machine by one hop. Called once per USSD
 * request/response round-trip — Hubtel (or the mock simulator) re-sends the
 * sessionId and the customer's latest keypad input each time. Session state
 * is a DB-backed row with a TTL rather than an opaque round-tripped token
 * (mission §8.2 asks for persisted sessions with TTL — see docs/00-legacy-study.md §8
 * for why the legacy app's token-based approach isn't what's used here).
 */
export async function handleUssdInput(params: {
  sessionId: string;
  msisdn: string;
  input: string;
  isNewSession: boolean;
  isTimeout?: boolean;
}): Promise<UssdResult> {
  const existing = params.isNewSession
    ? null
    : await prisma.ussdSession.findUnique({ where: { sessionId: params.sessionId } });

  // The carrier/customer ended the session (e.g. hung up) — Hubtel notifies us
  // after the fact, purely informational. Clean up immediately rather than
  // leaving the row for the TTL sweep to catch later, and skip the state
  // machine entirely: there's no more input to act on.
  if (params.isTimeout) {
    if (existing) await endSession(existing.id);
    return { message: 'Session ended.', continueSession: false, label: 'Session ended' };
  }

  if (!existing || existing.expiresAt < new Date()) {
    if (existing) await endSession(existing.id);
    return startSession(params.sessionId, params.msisdn);
  }

  const context: UssdContext = existing.context ? JSON.parse(existing.context) : {};

  switch (existing.state) {
    case 'ENTER_ALT_PHONE': {
      if (params.input.trim() === '0') {
        await endSession(existing.id);
        return { message: 'Cancelled.', continueSession: false, label: 'Cancelled' };
      }
      const altPhone = params.input.trim();
      const customer = await findCustomerByPhone(altPhone);
      if (!customer) {
        return {
          message: `No account found for ${altPhone}.\n${ALT_PHONE_PROMPT}`,
          continueSession: true,
          label: 'Enter phone number',
          fieldType: 'phone',
        };
      }
      // params.msisdn (the phone actually dialed in) stays what gets billed —
      // altPhone was only used to identify the account.
      return beginForCustomer(params.sessionId, params.msisdn, customer.id, `${customer.firstName} ${customer.lastName}`);
    }

    case 'SELECT_CONTRACT': {
      const idx = parseInt(params.input, 10) - 1;
      const contractIds = context.contractIds ?? [];
      if (Number.isNaN(idx) || idx < 0 || idx >= contractIds.length) {
        await endSession(existing.id);
        return { message: 'Invalid selection. Session ended.', continueSession: false, label: 'Invalid selection' };
      }
      const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractIds[idx] }, include: { customer: true } });
      await prisma.ussdSession.update({
        where: { id: existing.id },
        data: { state: 'ENTER_AMOUNT', contractId: contract.id, context: JSON.stringify({ contractId: contract.id }) },
      });
      return { message: await contractPrompt(contract, `${contract.customer.firstName} ${contract.customer.lastName}`), continueSession: true, label: 'Enter amount', fieldType: 'decimal' };
    }

    case 'ENTER_AMOUNT': {
      const amountGhs = parseFloat(params.input);
      if (Number.isNaN(amountGhs) || amountGhs <= 0) {
        return { message: 'Invalid amount. Enter amount to pay:', continueSession: true, label: 'Enter amount', fieldType: 'decimal' };
      }
      const amountMinor = Math.round(amountGhs * 100);
      const contractId = context.contractId as string;
      await prisma.ussdSession.update({
        where: { id: existing.id },
        data: { state: 'CONFIRM', context: JSON.stringify({ contractId, amountMinor }) },
      });
      return {
        message: `Confirm payment of GHS${formatMoney(amountMinor)}?\n1. Confirm\n2. Cancel`,
        continueSession: true,
        label: 'Confirm payment',
        fieldType: 'number',
      };
    }

    case 'CONFIRM': {
      if (params.input === '2') {
        await endSession(existing.id);
        return { message: 'Payment cancelled.', continueSession: false, label: 'Payment cancelled' };
      }
      if (params.input !== '1') {
        return { message: 'Invalid option.\n1. Confirm\n2. Cancel', continueSession: true, label: 'Confirm payment', fieldType: 'number' };
      }
      const { contractId, amountMinor } = context;
      await endSession(existing.id);
      if (!contractId || !amountMinor) {
        return { message: 'Session error. Please try again.', continueSession: false, label: 'Session error' };
      }
      const txn = await initiateHubtelPayment({ contractId, msisdn: params.msisdn, amountMinor });
      return txn.status === 'SUCCESS'
        ? { message: 'Payment successful! You will receive an SMS confirmation shortly.', continueSession: false, label: 'Payment successful' }
        : { message: 'Payment failed. Please try again later.', continueSession: false, label: 'Payment failed' };
    }

    default:
      await endSession(existing.id);
      return { message: 'Session error. Please try again.', continueSession: false, label: 'Session error' };
  }
}

/** Clears expired USSD sessions — run periodically alongside the Hubtel reconciliation sweep. */
export async function pruneExpiredUssdSessions() {
  const result = await prisma.ussdSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
