# Instructions for Claude: temporary unlock and agent deposits

You are adding one or both of these features to a hire-purchase project:

1. **Temporary unlock.** A customer whose financed phone has locked pays part of what is overdue, and the phone opens for a set time.
2. **Agent deposits on the short code.** An agent pays in the customers' cash they hold by mobile money, using a personal payment PIN.

You cannot see the project these were first built in. This file is the full specification. Names below come from that project: use the target project's names where they differ, and keep the behaviour exact.

## 1. Before writing code

1. Read the project's own instructions (`CLAUDE.md`, `AGENTS.md`) and follow them. Check its framework docs, not your memory.
2. Find each of these in the project and note where it lives:

| You need | Temporary unlock | Agent deposits |
| --- | --- | --- |
| Contracts with an instalment schedule, and a way to post a payment | Yes | Yes |
| A payment reversal that marks the original payment reversed | Yes | No |
| Mobile money charges with a client reference, a success callback and a sweep for stuck charges | Yes | Yes |
| A USSD menu kept as a state machine with stored session context | Yes | Yes |
| Device locking driven by a lock date (a function that decides the next lock date for a contract) | Yes | No |
| Settings for device locking, and a page to edit them | Yes | No |
| An agent ledger per sale: cash collected, commission, remitted, commission paid | Read only | Yes |
| An `AGENT` role, a staff dashboard, a page for creating staff | No | Yes |
| Customer API or mobile app | Optional | No |
| Outgoing SMS and an audit log | Yes | Yes |

3. If something marked Yes is missing, stop and tell the user what is missing. Do not build a substitute without their agreement.
4. If the lock provider differs from PayTrigger, check that its lock date can be moved forward and that the device enforces that date while offline. If it can't, stop and ask.
5. Ask the user only what the project can't answer:
   - Which feature or features to add.
   - Whether the defaults in this file suit them: the tiers, the use cap, whether defaulted contracts may use it, and whether office staff may take cash for it.
   - Whether the customer app is in scope.
6. Build the features in the order above if adding both. Each works alone.

## 2. Rules for both features

- **Money** is integer minor units. Follow the project's own currency formatting.
- **Tie the purpose to the charge before making the charge.** Save a row keyed on the client reference first. A payment can settle before the request returns.
- **Claim before acting.** Move a row out of its waiting status with a conditional update (`updateMany` where status is still waiting) and act only if a row changed. A callback and the sweep can arrive together.
- **Never tell a payer a charge failed when the money may have been taken.**
- **A USSD screen is at most 160 characters.** Test the longest case.
- **Re-read amounts on the server** at each step. Never trust an amount from the client or an earlier screen.
- Honour the project's closed-day rule for payments.
- Write audit entries in the project's existing style.
- Run migrations and tests only against a non-production database. Never print or commit API keys or other secrets.
- Match the surrounding code's naming, comments and idiom. Commit and deploy only as the user or the project's instructions say.

## 3. Temporary unlock

### Behaviour

- It is off until switched on in settings.
- Settings hold 4 to 6 tiers of `{ percent, hours }`. Each tier needs a higher percentage and more hours than the one before. Percent is a whole number from 1 to 99. Hours run from 1 to the maximum unlock horizon in hours. Defaults: 25% for 24 hours, 50% for 72, 75% for 120, 90% for 168. A USSD screen holds at most 6.
- Each tier can also carry a fixed charge, from GHS 0 to GHS 1,000, default 0. The customer pays the tier's share plus its charge. The charge never reduces what they owe.
- A use cap is editable from 1 to 20, default 2.
- Overdue means unpaid instalment amounts due before today. Late charges never count.
- It applies only to a device-financing contract, status active or defaulted, with an active enrolled device.
- The phone opens only once the money has come in. When the window ends it locks again, unless all that is overdue has been paid, which puts it back on its normal schedule.
- The device must lock itself at the end of the window while offline, so **only the lock date moves**. Do not use a provider's separate temporary-unlock call (PayTrigger's needs activating per account).
- A window already running can only be lengthened, never shortened.
- A reversed payment takes its unlock with it and gives the use back. Nothing needs changing at reversal: whether an unlock counts is read from its payment.
- Only clearing the arrears starts the use count afresh. Paying off the oldest overdue instalment while a later one is still overdue does not.
- An agent deposit not yet paid in outranks any window: the phone stays shut, and the customer is told so before they pay.
- Agents can't take cash for it, because cash they hold keeps the phone locked until it is paid in.

### Data

Add to the device-lock settings row, and a new table:

```prisma
// On the settings model
temporaryUnlockEnabled Boolean @default(false)
temporaryUnlockMaxUses Int     @default(2)
temporaryUnlockTiers   Json    @default("[{\"percent\":25,\"hours\":24},{\"percent\":50,\"hours\":72},{\"percent\":75,\"hours\":120},{\"percent\":90,\"hours\":168}]")
lockScreenAppLink      Boolean @default(false)

model TemporaryUnlock {
  id              String    @id @default(uuid())
  contractId      String
  percent         Int
  hours           Int
  overdueMinor    Int
  amountMinor     Int
  channel         String    // USSD | APP | STAFF
  status          String    @default("PENDING") // PENDING | APPLIED
  clientReference String    @unique
  paymentId       String?
  requestedById   String?
  activatedAt     DateTime?
  expiresAt       DateTime?
  createdAt       DateTime  @default(now())

  @@index([contractId, status])
}
```

### Service

**`paidUnlocks(contractId)`**: rows with status `APPLIED` whose payment is still successful and not reversed.

**`temporaryUnlockUntil(contractId, now)`**: the latest `expiresAt` after `now` among paid unlocks, or null.

**`getTemporaryUnlockOffer(contractId, now)`** returns null when there is nothing to say, otherwise `{ available, message, overdueMinor, options, activeUntil, usesLeft }`. In order:

1. Return null if the feature is off, the contract or its status doesn't qualify, or the device isn't active.
2. Take instalments with a due date before the start of today and not fully paid. Return null if the overdue total is 0.
3. `lockedSince` = the lock moment for the oldest overdue due date, using the same function the lock decision uses (in the original project, 23:59 at the end of the due day plus any extra days in settings, with no grace period). Return null if the contract isn't defaulted, `lockedSince` is in the future, and no window is running.
4. Find the last moment nothing was overdue: the latest instalment `paidAt` after which every instalment due before that day had been paid. `used` = paid unlocks activated after that moment, or all of them if there is no such moment. `usesLeft` = cap minus `used`, not below 0.
5. If the contract was sold by an agent, the deposit-hold setting is on, and the agent's balance is unknown or above 0: closed, "Your phone is held until your agent finishes registering your payment. Please contact your agent."
6. If `usesLeft` is 0: closed, "You have used all your temporary unlocks. Pay the full overdue amount of {amount} to open your phone."
7. Each tier's share is `ceil(overdue × percent / 100)`. Keep options whose share is at or above the minimum payment and strictly below the overdue total. What the customer pays is the share plus the tier's charge. With none left: closed, "Pay the full overdue amount of {amount} to open your phone."

"Closed" means `available: false`, the message, and no options.

**`requestTemporaryUnlock({ contractId, percent, channel, clientReference?, requestedById?, expectedAmountMinor? })`**: recompute the offer and throw a domain error if it is unavailable. Find the option by percent. Refuse if `expectedAmountMinor` differs ("The amount overdue has changed. Please start again."). Run the project's payment amount check. Upsert on `clientReference` with an empty update, so one session confirming twice is one request. Move no money here.

**`applyTemporaryUnlock(clientReference, paymentId)`**: called for every settled charge, most of which aren't unlocks. It must never throw, because the payment is already recorded. Return unless a `PENDING` row exists. `expiresAt` is the later of the running window and now plus `hours`. Claim on `PENDING`, setting status, payment, `activatedAt` and `expiresAt`. Then audit, ask the device reconcile to run for this contract, and text the customer:

> Hi {first name}, your phone is open until {date and time}. Pay the remaining {amount} overdue before then or it will lock again. {company}

**`takeCashForTemporaryUnlock({ contractId, percent, userId })`**: request with channel `STAFF`, post a cash instalment payment using the same reference, then apply.

### Connect it

- **Lock decision.** Pass `temporaryUnlockUntil` in. Treat a window as live only if it ends beyond the "lock now" margin. On a defaulted contract, a live window returns an extend to the window's end. On other contracts, check after the agent-deposit hold, and extend to the window's end only if that is later than the normal schedule. A window must never shorten a schedule that runs later, and never override the deposit hold.
- **Settings validation.** Validate tiers against the horizon being saved, else the current one. No tier may promise longer than the device can be opened ahead.
- **Successful charge.** After the payment is posted and linked, call `applyTemporaryUnlock` with the charge's reference. Accept an optional `clientReference` on the charge function.

### Channels

**USSD.** After the contract is identified, for a qualifying contract with an available offer, go to the new state `UNLOCK_CHOICE`. Everyone else continues exactly as before.

| State | Screen | Input |
| --- | --- | --- |
| `UNLOCK_CHOICE` | `{greeting}{Phone locked or Open until dd/mm hh:mm}. Overdue GHS{x}` then `1. Open phone (pay part)` and `2. Pay any amount` | 1 goes to tiers. 2 goes to the normal amount screen. Anything else: "Not an option." and repeat |
| `UNLOCK_TIER` | `Open phone:` then `1. GHS{x} - {period}` for each option, then `0. Back` | Recompute the offer first. 0 goes back. An unlisted choice: "Not on the list." and repeat |
| existing confirm | `Pay GHS{x} to open phone for {period}? It locks after that unless all overdue is paid.` then `1. Confirm` and `2. Cancel` | Store the percent in the session context |

On confirm, request the unlock with `expectedAmountMinor` before charging. The reference is the session id when the gateway's checkout takes the payment, else a new reference passed to the charge. If the offer has gone, end the session showing its message. This also works for someone paying for another person's locked phone.

**Customer API.** Include `temporaryUnlock` (the offer, or null) on device-financing contracts. Add a POST taking contract, percent, network and number. It must load the contract by the signed-in customer, check the closed day, request the unlock, run the project's usual mobile money checks, then charge with that reference.

**Staff.** On the contract page, a card showing the offer and tiers. GET returns the offer and POST takes the percent. Require the cash-recording permission and branch access, and refuse the `AGENT` role.

**Customer app, if in scope.** A banner on Home and the contract page: locked, open until a time, or closed with the reason. A screen to choose a tier, number and network, then wait for confirmation. An optional deep link on the lock screen, sent with the lock command only when `lockScreenAppLink` is on. It needs the app installed on the phones and its package whitelisted with the provider.

**Settings page.** Enable toggle, use cap, editable tiers, app-link toggle.

### Tests to write

- Offer: nothing while off; nothing before the lock date; tiers priced from instalments, leaving late charges out.
- Tier validation: count, ordering, horizon.
- Each channel opens the phone for the tier, and texts when it locks.
- USSD screens fit 160 characters, and other callers' screens are unchanged.
- Nothing opens before the money arrives.
- The cap stops it, then only the full amount opens the phone.
- A running window is lengthened, never shortened.
- A reversal removes the unlock and returns the use.
- Paying everything overdue ends the offer.
- Works on a defaulted contract.
- Closed while an agent's deposit is unpaid, and that hold outranks a window.
- The lock decision: opens to the window's end, locks once it has passed, never cuts a later schedule short.
- Cash at the office works; an agent is refused.

## 4. Agent deposits on the short code

### Behaviour

- The main menu shows `3. Agent deposits` to every caller.
- Choosing 3 asks: `Enter your agent payment PIN, or 0 to go back:`
- The PIN identifies the agent, so they can pay from any phone. The money comes from the phone that dialled.
- One sale owed goes straight to the amount, and part payment is allowed. Several sales show a list. Pay all takes the oldest first.
- The ledger is credited when the money arrives, with no one confirming it.
- It is **not a customer payment**: write no `Payment` row and leave the contract's totals alone.
- A failed charge credits nothing and the amount becomes payable again. A success that arrives late still lands, once, unless the agent has paid that amount in again by then. It then goes to the staff review queue instead of being credited twice.
- A checkout the agent abandons may never be answered, and the gateway's status check may refuse to look it up. After 30 minutes with no answer, the charge is marked failed and the amount becomes payable again.

### The PIN

- Six digits with no leading zero, from a secure random source (`crypto.randomInt(100000, 1000000)`), unique to the agent. Retry on a unique-constraint clash.
- Issue it when an agent is created, and when someone is moved into the role. Issue it from the dashboard endpoint if an agent somehow has none. Issuing is safe to repeat and must not change an existing PIN.
- Give every existing agent one in the migration.
- It is shown to the agent, so it is stored readable. Only that endpoint may return it. Keep it out of staff lists and audit entries.
- **Search the project for anything that sends a whole user record to the browser**, such as `include: { createdBy: true }` in a report. Change those to select only the fields used. The original project's Payments Register was sending password hashes this way.
- Only active users in the `AGENT` role match. Anything not exactly six digits is a wrong PIN.
- Five wrong PINs from one phone within an hour stops that phone from this option for an hour, even with the right PIN: `Too many wrong PINs from this phone. Please try again in an hour.` End the session. Check before showing the prompt and before testing a PIN. A correct PIN clears that phone's count.

### Data

```prisma
// On User
paymentPin String? @unique

model AgentPinFailure {
  id        String   @id @default(uuid())
  msisdn    String
  createdAt DateTime @default(now())

  @@index([msisdn, createdAt])
}
```

`AgentRemittance` gains two status values, `AWAITING_PAYMENT` and `PAYMENT_FAILED`. Add a migration only if the column is an enum. `HubtelTransaction` (or the project's charge table) gains the channel value `AGENT_DEPOSIT`.

Backfill inside the migration, adapting table names:

```sql
DO $$
DECLARE agent RECORD; pin TEXT;
BEGIN
  FOR agent IN SELECT u."id" FROM "users" u JOIN "roles" r ON r."id" = u."roleId" WHERE r."name" = 'AGENT' LOOP
    LOOP
      pin := (100000 + floor(random() * 900000))::int::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "users" WHERE "paymentPin" = pin);
    END LOOP;
    UPDATE "users" SET "paymentPin" = pin WHERE "id" = agent."id";
  END LOOP;
END $$;
```

### Ledger service

A sale's balance is cash collected minus commission minus remitted plus commission paid. Treat `PENDING` and `AWAITING_PAYMENT` remittances as in flight, and count them wherever the project works out what can still be remitted, so a claim filed by hand and a charge can't cover the same money.

- **`agentDepositsToPay(agentId)`**: unsettled sales, oldest first, each with `payableMinor` = balance minus in-flight remittances. Keep those above 0.
- **`openUssdRemittance({ agentId, amountMinor, clientReference, ledgerId? })`**: split the amount across one sale or all of them, oldest first. Throw "That is more than you owe. Please dial again." if it doesn't fit. Create `AWAITING_PAYMENT` rows with method mobile money and the reference. Return the first sale's contract, for the charge record.
- **`failUssdRemittance(clientReference)`**: `AWAITING_PAYMENT` becomes `PAYMENT_FAILED`.
- **`settleUssdRemittance(clientReference)`**: in one transaction, claim each row in `AWAITING_PAYMENT` or `PAYMENT_FAILED` to `CONFIRMED`, and credit the ledger the same way a staff confirmation does. Return false only if the reference has no confirmed rows at all. After the transaction: tell the device reconcile each deposit was paid in (a held phone can open), write an audit entry, and text the receipt without letting a text failure break anything.
- Receipt: `Hi {first name}, we have received your deposit payment of {amount}. You still have {amount} to pay in.`, or `You have nothing more to pay in.`, then the company name. Send to the agent's number on record, else the number charged.

### Charges

- The charge function takes optional `channel` and payer `{ name, description }`, so the gateway record names the agent and "Agent deposit". The checkout function takes optional `channel` and `itemName`.
- A non-successful callback on the agent channel calls `failUssdRemittance`.
- In the success path, return early if the charge is already resolved. For the agent channel, call `settleUssdRemittance`. If it returns false, raise the error that sends a charge to the staff review queue. Set a resolved timestamp and post no payment.
- The sweep that retries unposted charges must skip resolved ones, or it will try to post a customer payment.
- When staff resolve an agent charge by hand as failed, fail its remittance rows too.

### USSD

| State | Screen | Input |
| --- | --- | --- |
| `AGENT_PIN` | The PIN prompt, with `Wrong PIN.` above it after a miss | 0 returns to the menu. Follow the lockout rules. A right PIN stores the agent id and continues |
| `AGENT_CHOOSE` | `You owe GHS{total} on {n} sales`, `1. Pay all`, then 3 sales a page as `2. {first name, 8 letters} {initial} #{contract number digits} GHS{x}`, `9. More` when another page follows, `0. Back` | Re-read the sales first. 9 shows the next page; 0 goes to the previous page, or the main menu from the first. A notice such as "Not on the list." replaces the heading line so the screen fits |
| `AGENT_AMOUNT` | `You owe GHS{x} for {name}.` then `Enter amount to pay:` | Refuse non-numbers, below the minimum, above the amount owed, and ask again |
| `AGENT_CONFIRM` | `Pay in GHS{x} of your deposits?` then `1. Confirm` and `2. Cancel` | Check the closed day, open the remittance, then charge |

With nothing owed, end the session: `You have nothing to pay in right now. Any payment you have just approved is still being processed.`

The reference is the session id for gateway checkout, otherwise a new one. If starting the charge fails, call `failUssdRemittance` and show the gateway's message.

### Pages

- **Agent dashboard:** a card visible only to the `AGENT` role. "Your payment PIN", the number in large type, and "To pay in your deposits, dial the short code, choose 3. Agent deposits and enter this PIN. Keep it to yourself." Serve it from an endpoint that returns only the signed-in agent's PIN and gives 403 to everyone else.
- **Agent's deposits page:** labels `WAITING FOR PAYMENT` and `NOT PAID` for the new statuses, and count waiting amounts as outstanding.
- **Staff page:** an optional unique mobile number, validated and audited, used for the receipt.
- **Mobile money page:** show the agent's name and how many sales the charge covered, with the channel labelled "Agent deposit".
- **Agent ledger page:** a list of what has been paid in, newest first, showing the agent, amount, sale, reference and whether it came through the short code.

### Tests to write

- The option shows for every caller. Strangers can't get past it; an agent's PIN works from any phone; a deactivated agent's PIN fails.
- Lockout: four misses still prompt, a right PIN clears them, a fifth blocks even the right PIN, and it lifts after the hour.
- A PIN holder with nothing owed is told so. The receipt goes to the paying phone if no number is on record.
- A new agent and a move into the role both get a unique PIN. The staff list never contains it. Only its owner can read it.
- Money arriving credits the ledger with no second customer payment and no change to contract totals.
- Part payment; refusing more than owed or a bad amount; pay all oldest first; paying one chosen sale.
- A failed charge credits nothing and is payable again. In flight, it can't be paid twice or claimed by hand. A late success lands once, and the sweep leaves it alone.
- The gateway checkout path names the charge correctly and settles it.
- The list screen fits 160 characters.

## 5. Finishing

1. Run the type check, the linter on changed files, and the full test suite. Fix anything you caused.
2. Update any existing tests that assert the exact main menu text.
3. Run the app and look at each new page or card.
4. Tell the user plainly:
   - what was added and how it was tested;
   - what wasn't tried with real money or a real device;
   - what is still off and how to turn it on;
   - anything you changed from this file because the project differs.
5. Suggest the first live test: one small agent payment, and one locked phone on the lowest tier.
