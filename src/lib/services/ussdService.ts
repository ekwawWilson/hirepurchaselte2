import { prisma } from '../db/prisma';
import { formatMoney } from '../utils/money';
import { initiateHubtelPayment, HubtelError } from './hubtelPaymentService';
import { networkForOperator } from '../constants/customers';
import { getOrgSettings } from './orgSettingsService';
import { getDeviceLoanState } from './paymentService';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from './operatingSettingsService';
import { contractTypeLabel, formatDate } from '../utils';
import { phoneVariants } from './hubtelClient';
import { beginUssdCheckout, ussdUsesHubtelCheckout } from './ussdCheckoutService';
import { parseCedis, paymentAmountProblem, waitingPromptProblem } from './paymentLimitsService';
import { MONEY_OUT_ENTRY_TYPES } from '../constants/contracts';

const SESSION_TTL_MINUTES = 5;

interface UssdContext {
  contractIds?: string[];
  /** Which page of the contract list is showing (a long list is split to fit a screen). */
  page?: number;
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
  /**
   * Set when the session ends by handing the customer to Hubtel's checkout
   * (the gateway answers `AddToCart` with this as its Item) rather than by
   * simply releasing them.
   */
  checkout?: { itemName: string; amountMinor: number };
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
 * Whether a DEVICE_LOAN contract's prompt should route into DEVICE_LOAN_CHOOSE
 * (pick one of up to two exact amounts) instead of ENTER_AMOUNT (type any
 * amount) — shared by beginForCustomer and the SELECT_CONTRACT handler.
 */
function nextStateFor(contractType: string): 'DEVICE_LOAN_CHOOSE' | 'ENTER_AMOUNT' {
  return contractType === 'DEVICE_LOAN' ? 'DEVICE_LOAN_CHOOSE' : 'ENTER_AMOUNT';
}

/**
 * Shared by beginForCustomer and the SELECT_CONTRACT handler so the two never
 * drift. Content differs by contract type:
 *  - SAVE_TO_OWN has no due schedule at all (contractService.ts) — free-form
 *    savings, so all there is to show is the running total paid in.
 *  - DEPOSIT_INSTALMENT has a real schedule — paid/remaining plus whatever's
 *    next: the upcoming instalment normally, or — when the customer has
 *    fallen behind — the overdue amount they actually owe right now *and*
 *    what follows it, rather than silently quoting a future date as if
 *    nothing were wrong.
 *  - DEVICE_LOAN has neither a schedule nor a free amount to type — it's a
 *    daily-simple-interest loan the customer pays down via exactly one of two
 *    choices (paymentService.getDeviceLoanState/postDeviceLoanPayment): the
 *    accrued interest owed so far, or the full loan amount. Whichever of the
 *    two is currently owed is shown; a fully-paid-off option isn't offered.
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
/**
 * What fits on one USSD screen. Networks cut a screen at about 160-182
 * characters; staying within 160 leaves no screen at risk of being cut off
 * or rejected.
 */
export const USSD_SCREEN_LIMIT = 160;

/** The opening lines of every screen: who is asking, kept short whatever the names are. */
async function greeting(customerName: string): Promise<string> {
  const { companyName } = await getOrgSettings();
  const company = companyName.length > 22 ? `${companyName.slice(0, 21).trimEnd()}.` : companyName;
  const firstName = customerName.trim().split(/\s+/)[0].slice(0, 15);
  return `${company}\nHi ${firstName}\n`;
}

/** dd/mm — the year is never in doubt on a screen about what is due now. */
const shortDate = (d: Date) => formatDate(d).slice(0, 5);

async function contractPrompt(contract: {
  id: string;
  contractType: string;
  balanceMinor: number | null;
  totalPaidMinor: number;
}, customerName: string): Promise<string> {
  const hello = await greeting(customerName);

  if (contract.contractType === 'SAVE_TO_OWN') {
    return `${hello}Saved GHS${formatMoney(contract.totalPaidMinor)}\n0. Last payments\nEnter amount to pay:`;
  }

  if (contract.contractType === 'DEVICE_LOAN') {
    const state = await getDeviceLoanState(contract.id);
    const options: string[] = [];
    if (state.accruedInterestMinor > 0) options.push(`1. Pay interest GHS${formatMoney(state.accruedInterestMinor)}`);
    if (state.principalOutstanding) options.push(`2. Pay full loan GHS${formatMoney(state.principalMinor)}`);
    return `${hello}${options.join('\n')}\n0. Last payments\nReply with option:`;
  }

  const [due, upcoming] = await prisma.instalment.findMany({
    where: { contractId: contract.id, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
    orderBy: { instalmentNo: 'asc' },
    take: 2,
  });

  // Never actually null here — DEVICE_LOAN/SAVE_TO_OWN both return above —
  // but the type is shared, so this stays defensive rather than asserted.
  const paidLine = `Paid GHS${formatMoney(contract.totalPaidMinor)} Bal GHS${formatMoney(contract.balanceMinor ?? 0)}`;
  let dueLine = '';
  if (due) {
    const dueAmount = due.amountDueMinor - due.amountPaidMinor;
    dueLine = due.status === 'OVERDUE'
      ? `OVERDUE GHS${formatMoney(dueAmount)} since ${shortDate(due.dueDate)}` +
        (upcoming ? `\nNext GHS${formatMoney(upcoming.amountDueMinor - upcoming.amountPaidMinor)} on ${shortDate(upcoming.dueDate)}` : '')
      : `Due GHS${formatMoney(dueAmount)} on ${shortDate(due.dueDate)}`;
  }

  return `${hello}${paidLine}${dueLine ? `\n${dueLine}` : ''}\n0. Last payments\nEnter amount to pay:`;
}

type ListedContract = { id: string; contractType: string; totalPaidMinor: number; balanceMinor: number | null; product: { name: string } | null };

/**
 * The "which contract?" screen. Each line names what the customer knows —
 * the phone they are paying for, or their savings or loan — not a contract
 * number. A list too long for one screen is split, with 0 for the next part;
 * the numbers stay the same on every part, so a choice means one thing.
 */
async function contractListScreen(contracts: ListedContract[], customerName: string, page: number, notice = ''): Promise<{ message: string; page: number }> {
  const lines = await Promise.all(contracts.map(async (c, i) => {
    const what = (c.product?.name ?? (c.contractType === 'SAVE_TO_OWN' ? 'Savings' : c.contractType === 'DEVICE_LOAN' ? 'Loan' : contractTypeLabel(c.contractType))).slice(0, 16);
    const amount = c.contractType === 'SAVE_TO_OWN'
      ? `saved GHS${formatMoney(c.totalPaidMinor)}`
      : c.contractType === 'DEVICE_LOAN'
        ? `owe GHS${formatMoney((await getDeviceLoanState(c.id)).totalOwedMinor)}`
        : `bal GHS${formatMoney(c.balanceMinor ?? 0)}`;
    return `${i + 1}. ${what} ${amount}`;
  }));
  const head = `${notice}${await greeting(customerName)}Choose:`;
  const more = '0. More';
  const pages: string[][] = [[]];
  for (const line of lines) {
    const current = pages[pages.length - 1];
    const candidate = [head, ...current, line, more].join('\n');
    if (current.length > 0 && candidate.length > USSD_SCREEN_LIMIT) pages.push([line]);
    else current.push(line);
  }
  const shown = ((page % pages.length) + pages.length) % pages.length;
  const body = [head, ...pages[shown], ...(pages.length > 1 ? [more] : [])].join('\n');
  return { message: body, page: shown };
}

const listedContractSelect = { id: true, contractType: true, totalPaidMinor: true, balanceMinor: true, product: { select: { name: true } } } as const;

/**
 * The customer's last few payments and what they owe — the "check my
 * balance" a customer gets by replying 0, without paying anything. Ends the
 * session.
 */
async function lastPaymentsScreen(contractId: string): Promise<UssdResult> {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, select: { contractType: true, totalPaidMinor: true, balanceMinor: true, id: true } });
  const payments = await prisma.payment.findMany({
    where: { contractId, status: 'SUCCESS', reversesPaymentId: null, reversedById: null, entryType: { notIn: MONEY_OUT_ENTRY_TYPES } },
    orderBy: { createdAt: 'desc' }, take: 3, select: { amountMinor: true, receivedAt: true, createdAt: true },
  });
  const lines = payments.map((p) => `${shortDate(p.receivedAt ?? p.createdAt)} GHS${formatMoney(p.amountMinor)}`);
  const standing = contract.contractType === 'SAVE_TO_OWN'
    ? `Saved GHS${formatMoney(contract.totalPaidMinor)}`
    : contract.contractType === 'DEVICE_LOAN'
      ? `Owed GHS${formatMoney((await getDeviceLoanState(contract.id)).totalOwedMinor)}`
      : `Paid GHS${formatMoney(contract.totalPaidMinor)} Bal GHS${formatMoney(contract.balanceMinor ?? 0)}`;
  return {
    message: `${payments.length ? `Last payments:\n${lines.join('\n')}` : 'No payments yet.'}\n${standing}`,
    continueSession: false,
    label: 'Last payments',
  };
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
  // SAVE_TO_OWN and DEVICE_LOAN have no balanceMinor at all (open-ended — see
  // paymentService.recomputeContract) — both are always payable while ACTIVE,
  // so the balanceMinor > 0 gate only applies to DEPOSIT_INSTALMENT.
  const contracts = await prisma.contract.findMany({
    where: {
      customerId,
      status: { in: ['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'] },
      OR: [{ contractType: { in: ['SAVE_TO_OWN', 'DEVICE_LOAN'] } }, { balanceMinor: { gt: 0 } }],
    },
    orderBy: { createdAt: 'asc' },
    select: listedContractSelect,
  });
  if (contracts.length === 0) {
    await prisma.ussdSession.deleteMany({ where: { sessionId } }); // no-op if no row exists yet (fresh dial-in)
    return { message: 'You have no contracts with an outstanding balance.', continueSession: false, label: 'Nothing due' };
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);

  if (contracts.length > 1) {
    const screen = await contractListScreen(contracts, customerName, 0);
    const context: UssdContext = { contractIds: contracts.map((c) => c.id), page: screen.page };
    await prisma.ussdSession.upsert({
      where: { sessionId },
      create: { sessionId, msisdn: dialedMsisdn, state: 'SELECT_CONTRACT', context: JSON.stringify(context), expiresAt },
      update: { state: 'SELECT_CONTRACT', contractId: null, context: JSON.stringify(context), expiresAt },
    });
    return { message: screen.message, continueSession: true, label: 'Select contract', fieldType: 'number' };
  }

  const contract = contracts[0];
  const context: UssdContext = { contractId: contract.id };
  const nextState = nextStateFor(contract.contractType);
  await prisma.ussdSession.upsert({
    where: { sessionId },
    create: { sessionId, msisdn: dialedMsisdn, state: nextState, contractId: contract.id, context: JSON.stringify(context), expiresAt },
    update: { state: nextState, contractId: contract.id, context: JSON.stringify(context), expiresAt },
  });
  return {
    message: await contractPrompt(contract, customerName),
    continueSession: true,
    label: nextState === 'DEVICE_LOAN_CHOOSE' ? 'Choose option' : 'Enter amount',
    fieldType: nextState === 'DEVICE_LOAN_CHOOSE' ? 'number' : 'decimal',
  };
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
  /** The dialling line's network as Hubtel's gateway reports it, when it does. */
  operator?: string;
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
      const contractIds = context.contractIds ?? [];
      const choice = params.input.trim();
      const idx = /^\d+$/.test(choice) ? parseInt(choice, 10) - 1 : NaN;
      if (choice === '0' || Number.isNaN(idx) || idx < 0 || idx >= contractIds.length) {
        // 0 shows the next part of a long list; anything else that is not on
        // the list is asked again, not the end of the session.
        const listed = await prisma.contract.findMany({ where: { id: { in: contractIds } }, select: { ...listedContractSelect, customer: { select: { firstName: true, lastName: true } } } });
        const ordered = contractIds.map((id) => listed.find((c) => c.id === id)!).filter(Boolean);
        const name = ordered[0] ? `${ordered[0].customer.firstName} ${ordered[0].customer.lastName}` : '';
        const screen = await contractListScreen(ordered, name, choice === '0' ? (context.page ?? 0) + 1 : context.page ?? 0, choice === '0' ? '' : 'Not on the list.\n');
        await prisma.ussdSession.update({ where: { id: existing.id }, data: { context: JSON.stringify({ ...context, page: screen.page }) } });
        return { message: screen.message, continueSession: true, label: 'Select contract', fieldType: 'number' };
      }
      const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractIds[idx] }, include: { customer: true } });
      const nextState = nextStateFor(contract.contractType);
      await prisma.ussdSession.update({
        where: { id: existing.id },
        data: { state: nextState, contractId: contract.id, context: JSON.stringify({ contractId: contract.id }) },
      });
      return {
        message: await contractPrompt(contract, `${contract.customer.firstName} ${contract.customer.lastName}`),
        continueSession: true,
        label: nextState === 'DEVICE_LOAN_CHOOSE' ? 'Choose option' : 'Enter amount',
        fieldType: nextState === 'DEVICE_LOAN_CHOOSE' ? 'number' : 'decimal',
      };
    }

    case 'DEVICE_LOAN_CHOOSE': {
      const contractId = context.contractId as string;
      // Recomputed fresh, never trusted from the earlier prompt — a day's
      // interest could have accrued (or the loan could have been paid off
      // some other way) in the time it took the customer to reply.
      const choice = params.input.trim();
      if (choice === '0') {
        await endSession(existing.id);
        return lastPaymentsScreen(contractId);
      }
      const state = await getDeviceLoanState(contractId);
      let amountMinor = 0;
      if (choice === '1' && state.accruedInterestMinor > 0) {
        amountMinor = state.accruedInterestMinor;
      } else if (choice === '2' && state.principalOutstanding) {
        amountMinor = state.principalMinor;
      } else {
        return { message: 'Not an option. Reply 1, 2, or 0 for your last payments:', continueSession: true, label: 'Choose option', fieldType: 'number' };
      }
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

    case 'ENTER_AMOUNT': {
      const contractId = context.contractId as string;
      if (params.input.trim() === '0') {
        await endSession(existing.id);
        return lastPaymentsScreen(contractId);
      }
      // Plainly a number in cedis, at least the minimum and no more than is
      // owed — anything else is explained and asked again (paymentLimitsService).
      const amountMinor = parseCedis(params.input);
      if (amountMinor === null) {
        return { message: 'Enter the amount in cedis, e.g. 50 or 50.50:', continueSession: true, label: 'Enter amount', fieldType: 'decimal' };
      }
      const problem = await paymentAmountProblem(contractId, amountMinor);
      if (problem) {
        return { message: `${problem}.\nEnter amount to pay:`, continueSession: true, label: 'Enter amount', fieldType: 'decimal' };
      }
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
      // Checked here, before Hubtel is asked for anything — once a charge is
      // initiated the money is gone from the customer's wallet and the
      // callback must be free to record it (operatingSettingsService.ts).
      try {
        await assertPaymentsAcceptedToday();
      } catch (e) {
        if (e instanceof PaymentsClosedError) {
          return { message: 'We are closed today and cannot take payments. Please try again on a working day.', continueSession: false, label: 'Closed today' };
        }
        throw e;
      }
      // A prompt this phone has not answered yet: a second one could be approved too.
      const waiting = await waitingPromptProblem(contractId, params.msisdn);
      if (waiting) return { message: 'A payment request is already waiting on your phone. Approve or decline it first, or try again in a few minutes.', continueSession: false, label: 'Request already waiting' };

      if (ussdUsesHubtelCheckout()) {
        // Hubtel's own checkout takes the money from here (ussdCheckoutService.ts):
        // nothing is charged by this server, and the payment is posted when
        // Hubtel reports it to the Service Fulfilment URL.
        try {
          const checkout = await beginUssdCheckout({ sessionId: params.sessionId, contractId, msisdn: params.msisdn, amountMinor });
          return {
            message: 'Your request has been submitted. Please wait for the payment prompt and approve it with your mobile money PIN.',
            continueSession: false, label: 'Approve the payment prompt', checkout,
          };
        } catch (e) {
          if (!(e instanceof HubtelError)) throw e;
          return { message: e.message.slice(0, 160), continueSession: false, label: 'Payment failed' };
        }
      }

      let txn;
      try {
        txn = await initiateHubtelPayment({
          contractId, msisdn: params.msisdn, amountMinor, network: networkForOperator(params.operator) ?? undefined,
        });
      } catch (e) {
        if (!(e instanceof HubtelError)) throw e;
        // Hubtel refused it (or the network could not be told): nothing was
        // charged. Its reason is cut to what a USSD screen holds.
        return { message: e.message.slice(0, 160), continueSession: false, label: 'Payment failed' };
      }
      if (txn.status === 'PENDING') {
        // Live mode: Hubtel has accepted the request and is prompting the
        // customer's handset for their PIN; the callback records the payment.
        return {
          message: 'Payment request sent. Approve the prompt on your phone with your mobile money PIN to complete it.',
          continueSession: false, label: 'Approve on your phone',
        };
      }
      if (txn.status === 'SUCCESS') {
        return { message: 'Payment successful! You will receive an SMS confirmation shortly.', continueSession: false, label: 'Payment successful' };
      }
      if (txn.status === 'NEEDS_REVIEW') {
        // The money was taken but couldn't be applied automatically — never
        // tell the customer it failed, or they may pay a second time.
        return { message: 'Payment received. Our staff will apply it to your account shortly.', continueSession: false, label: 'Payment received' };
      }
      return { message: 'Payment failed. Please try again later.', continueSession: false, label: 'Payment failed' };
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
