# 01 — Plan

Builds on `docs/00-legacy-study.md`. This is the working plan for HP-Lite: schema, modules, milestones, and the explicit resolutions to the mission's open ambiguities (§15). Loan math for Type C gets its own doc: `docs/02-loan-maths.md`.

---

## 1. Stack (confirmed)

**Revised mid-build**: HP-Lite is one fullstack Next.js app — pages and API routes in a single project, no separate Express backend — matching the pattern of this workspace's other apps (e.g. `market-inventory`: `app/<feature>` pages, `app/api/<feature>/route.ts` handlers, `lib/<domain>` business logic, Prisma, Tailwind). The initial build used a separate Express API + Next.js frontend; everything was ported over (business logic is framework-agnostic — schedule generation, payment allocation, and RBAC rules are identical either way) once that direction was set. Route handlers live under `src/app/api/**/route.ts`; business logic lives under `src/lib/{services,auth,constants,utils,db}`; auth is bearer-JWT (not NextAuth) checked per-route via `src/lib/auth/rbac.ts` helpers, kept deliberately simple since this app has one login type (staff) and no OAuth providers.

Stack: Next.js 16 (App Router, Turbopack) + React 19 + TypeScript + Prisma + Tailwind + Radix UI + Zustand + `react-hook-form` + `zod` + `axios`. DB: **PostgreSQL** — matches the legacy app's own database (originally SQLite for the first stretch of the build, since this machine had no server/Docker/sudo; reversed once asked to match legacy's DB type — see study doc §1 for the full history). `@id` fields default to `uuid()`, matching legacy's own ID convention. Package manager: npm throughout.

Money: integer **minor units** (pesewas) in every DB column and every internal calculation — `amount_minor: Int`. Formatted to GHS at the edges (API response layer / UI) only. Currency code stored in a single `settings` row / env var (`CURRENCY_CODE=GHS`), not hardcoded into business logic.

---

## 2. Contract modeling decision

**One `contracts` table with a `contract_type` discriminator column**, not three tables. Justification: the legacy system ran a single contract shape at production scale for years with no discriminator at all — a single table with type-specific nullable columns (loan fields only populated for `DEVICE_LOAN`) is proven to be enough structural flexibility, and it lets shared code (payment posting, balance recompute, SMS triggers, reporting) work against one shape instead of three, which matters more here than type purity given the mission's "keep it lean" instruction. Type-specific columns are grouped and commented in the Prisma schema so it's obvious which fields apply to which type. Every report and the payment pipeline query one table.

---

## 3. Schema (entity outline)

Authoritative version lives in `prisma/schema.prisma` once scaffolded; this is the planning-level outline.

```
branches            id, name, code, address, phone, is_active

roles               id, name, description
permissions         id, name (dot.notation), description
role_permissions    role_id, permission_id

users               id, email, phone, password_hash, first_name, last_name,
                     role_id, branch_id (null = all-branch scope, e.g. SUPER_ADMIN/AUDITOR),
                     is_active, created_at, updated_at

customers            id, membership_id, first_name, last_name, phone (unique),
                     email, address, national_id, date_of_birth, photo_url,
                     guarantor_name, guarantor_phone, branch_id, is_activated,
                     created_by_user_id, updated_by_user_id, created_at, updated_at

product_categories   id, name
products             id, sku, name, category_id, brand, model, cash_price_minor,
                     is_active, image_url, created_at

inventory_items      id, product_id, branch_id, serial_number (unique),
                     status: AVAILABLE | RESERVED | ISSUED | RETURNED | WRITTEN_OFF,
                     contract_id (nullable, unique), created_at

stock_movements      id, inventory_item_id, product_id, branch_id,
                     type: RECEIPT | RESERVE | ISSUE | RETURN | TRANSFER | ADJUSTMENT,
                     from_branch_id, to_branch_id, reference_type, reference_id,
                     reason, created_by_user_id, created_at

price_chart_entries  id, product_id, contract_type, term_months, deposit_percentage,
                     total_payable_minor, instalment_amount_minor,
                     interest_rate_bps (nullable, DEVICE_LOAN only),
                     effective_from, effective_to (nullable),
                     created_by_user_id, created_at

contracts            id, contract_number (unique), contract_type: SAVE_TO_OWN |
                     DEPOSIT_INSTALMENT | DEVICE_LOAN,
                     customer_id, product_id, inventory_item_id (nullable until allocated),
                     branch_id, price_chart_entry_id (nullable — manual override contracts),
                     -- snapshotted pricing (never re-read from price_chart_entries after creation) --
                     total_price_minor, deposit_amount_minor, deposit_percentage,
                     term_months, payment_frequency, instalment_amount_minor,
                     -- DEVICE_LOAN only --
                     principal_minor, interest_rate_bps, rate_basis: FLAT,
                     -- lifecycle --
                     status (see §5 per-type state machines below),
                     total_payable_minor, total_paid_minor, balance_minor,
                     start_date, activated_at, completed_at, released_at,
                     cancelled_at, defaulted_at, written_off_at,
                     cancel_reason, write_off_reason,
                     created_by_user_id, updated_by_user_id, created_at, updated_at

instalments          id, contract_id, instalment_no, due_date,
                     amount_due_minor, principal_portion_minor, interest_portion_minor,
                     amount_paid_minor, status: PENDING | PARTIAL | PAID | OVERDUE,
                     paid_at

payments             id, contract_id, entry_type: DEPOSIT | INSTALMENT_PAYMENT | CREDIT,
                     amount_minor, channel: CASH | USSD, mobile_money_network (nullable),
                     transaction_ref (unique — idempotency key), external_ref (gateway ref),
                     status: PENDING | SUCCESS | FAILED,
                     receipt_number, notes, raw_gateway_payload (JSON, nullable),
                     created_by_user_id, initiated_by_customer_id (nullable),
                     reverses_payment_id (nullable, self-FK), reversal_reason,
                     received_at, created_at

payment_allocations  id, payment_id, target_type: PENALTY | INSTALMENT,
                     instalment_id (nullable), penalty_id (nullable), amount_minor

penalties            id, contract_id, instalment_id (nullable), amount_minor, reason,
                     applied_date, is_paid, paid_at

hubtel_transactions  id, client_reference (unique), contract_id, msisdn, amount_minor,
                     status: PENDING | SUCCESS | FAILED, raw_callback_payload (JSON),
                     payment_id (nullable, set once posted to ledger), created_at, updated_at

ussd_sessions        id, session_id (unique), msisdn, state, contract_id (nullable),
                     context (JSON), expires_at, created_at, updated_at

sms_templates        id, key (unique), name, body_template, is_active
sms_messages         id, recipient, template_key, body, related_payment_id,
                     related_contract_id, status: QUEUED | SENT | FAILED,
                     provider_ref, attempts, last_attempt_at, created_at

audit_logs           id, user_id, action, entity_type, entity_id,
                     old_values (JSON), new_values (JSON), created_at
```

**Deposit lesson applied** (study doc §6): a `DEPOSIT_INSTALMENT` or `SAVE_TO_OWN` contract's deposit is created as an explicit `payments` row with `entry_type = DEPOSIT` in the same transaction as the contract itself — never a bare number folded into `total_paid`. `total_paid_minor` is *always* `SUM(payments.amount_minor WHERE status = 'SUCCESS')` for that contract, recomputed on every posted payment, never incremented. This is the single most important carried-over lesson from the legacy postmortems.

**Reversal, not hard delete** (mission rule #6): a reversal is a new `payments` row with `entry_type` matching what it reverses but negative-effect semantics handled via `reverses_payment_id` pointing at the original (original row's `status` stays `SUCCESS`, unaffected — the reversal is what gets excluded/included in the recompute sum, not a mutation of history). Exact sign/exclusion convention finalized during implementation; the invariant is: original rows are immutable, corrections are additive new rows with an owning user and a reason.

---

## 4. Modules (mapped to legacy reuse)

| # | Module | Legacy reuse | Net-new |
|---|---|---|---|
| 1 | Auth + RBAC | JWT/bcrypt pattern, role→permission (not per-user), OR-semantics checks, SUPER_ADMIN bypass, fail-closed scoping default | Branch-scoped queries (legacy has none), mission's 7-role list, dot-notation permission strings |
| 2 | Customers | Field set, phone-unique, guarantor as plain fields, membership ID pattern | branch_id, created/updated_by_user_id |
| 3 | Products | Direct port of Product/ProductCategory shape | — |
| 4 | Inventory | serial_number identity, status field pattern | **Stock movements ledger** (legacy has none — status-field-only was a gap, matching the §6 lesson) |
| 5 | Price chart | `ProductPricing` (product × term) is the direct ancestor | contract_type dimension, deposit_percentage, effective_from/to versioning, contract-time snapshotting |
| 6 | Contracts | Schedule-precomputed-at-creation pattern, rounding rule (last instalment absorbs remainder), single-table-no-approval-branch structure | 3-type discriminator, Type A device-withholding, Type C interest engine, reversal-based corrections |
| 7 | Cash payments | Manual-payment shape (amount, receipt, notes, cashier) | Reversal permission + reason (not hard delete) |
| 8 | Hubtel USSD payments | Regular-charge + preapproval flow shapes, USSD token-based menu state machine, callback duplicate/mismatch defenses, reconciliation job pattern | DB-backed session table w/ TTL (mission requirement), fail-closed callback verification (legacy fails open when secret unset — a bug we fix, not copy), net-of-Hubtel-charges posting |
| 9 | SMS | Interface/settings-gate/delivery-log shape, async non-blocking pattern, combined-overdue-SMS-bundling pattern | Hubtel SMS provider instead of Nalo (mission §9 explicit), template editor with preview |
| 10 | Reports | Legacy's 8 report types map closely to mission §10's list | Arrears ageing buckets, loan book report (Type C is net-new so this report is too) |
| 11 | Audit | `AuditLog` shape (old/new JSON, actor, entity) | — |

Explicitly **not ported**: Knox, approval workflow, CSO/ticketing, agent commission ledger — see study doc §10 for exactly what's decoupled and how.

---

## 5. Contract state machines (per type, as implemented)

**SAVE_TO_OWN**: `ACTIVE → COMPLETED → RELEASED` (+ `CANCELLED`). Inventory item is `RESERVE`d (stock movement) at contract creation, held through `ACTIVE`/`COMPLETED`, and only gets an `ISSUE` movement (status → `ISSUED`) on the explicit release action once `balance_minor = 0`. No deposit concept for this type — customer pays toward the full price from zero. **Free-form savings, no fixed schedule**: unlike the other two types, `createContract` never generates `Instalment` rows for this type at all — the customer deposits any amount, any time, and `post_payment` skips allocation (nothing to allocate against). Progress is purely `total_paid_minor` vs `total_payable_minor`; there's no due date, no per-period amount, and therefore no `OVERDUE`/arrears/defaulting concept for `SAVE_TO_OWN` (`markOverdueInstalments`/`markDefaultedContracts` naturally never touch it, since there are no instalments to find). Completion is still purely balance-driven (`balance_minor <= 0`), so it's unaffected by having no schedule to check against.

**DEPOSIT_INSTALMENT**: `PENDING_DEPOSIT → ACTIVE → COMPLETED` (+ `DEFAULTED`, `CANCELLED`). Contract row is created in `PENDING_DEPOSIT`; the deposit payment (must meet the price-chart minimum for the chosen term) is posted through the same `post_payment` pipeline as any other payment — once a `SUCCESS` deposit payment exists, a single transition step flips the contract to `ACTIVE` and issues the inventory item (status → `ISSUED`, an `ISSUE` stock movement recorded) in the same DB transaction. This is **not** the legacy's human-approval gate — it's an automatic state transition driven by payment confirmation, matching the mission's "no maker-checker" requirement while still respecting the manual's real business rule that the device shouldn't go out before the deposit is actually in hand.

**DEVICE_LOAN**: `ACTIVE → COMPLETED` (+ `DEFAULTED`, `WRITTEN_OFF`). Device is issued unconditionally at disbursement (contract creation) — no down-payment gate. This matches the legacy pattern of "device now" in the one shape it actually supports (study doc §3), and resolves mission ambiguity §15.3 (legacy always releases immediately; HP-Lite follows suit for Type C rather than inventing a new gate with no legacy precedent to justify it).

All three share: schedule generated once at activation/creation and stored (never recomputed except through an explicit, permissioned reschedule action that regenerates and audits); `total_payable_minor`/`total_paid_minor`/`balance_minor` recomputed from the payments ledger on every posted payment; early settlement = one payment for the full `balance_minor`, allowed as an explicit case in `post_payment`, not a separate code path.

**Enforcement notes (added after an end-to-end audit of these rules):**
- `CONTRACT_STATUSES_BY_TYPE` (`src/lib/constants/contracts.ts`) is the single source of truth `cancelContract`/`writeOffContract` consult — `CANCELLED` is not in `DEVICE_LOAN`'s list, so a disbursed loan can never be cancelled (write-off is its only non-completion exit); `WRITTEN_OFF` is not in `DEPOSIT_INSTALMENT`'s or `SAVE_TO_OWN`'s lists, so only loans can be written off.
- `DEFAULTED` is reached by `overdueService.markDefaultedContracts()` (wired into the same daily 08:00 cron as the overdue sweep): an `ACTIVE` `DEPOSIT_INSTALMENT`/`DEVICE_LOAN` contract with an instalment more than 90 days overdue is flipped to `DEFAULTED`. `SAVE_TO_OWN` is exempt — no `DEFAULTED` state exists for it since the device was never released. A `DEFAULTED` contract is not terminal: `post_payment` still accepts payments against it, and `advanceContractStatus` cures it back to `ACTIVE` (or straight to `COMPLETED`, in the same pass, if that payment also clears the balance) the moment no `OVERDUE` instalments remain.
- Cancelling a contract never touches the payments ledger itself (reversals stay a separate, explicit, per-payment action) — it instead returns `refundDueMinor` (= `total_paid_minor` at the moment of cancellation) so staff have an unambiguous figure for what's owed back to the customer.
- A `DEPOSIT` entry type is only accepted while a `DEPOSIT_INSTALMENT` contract is still `PENDING_DEPOSIT` — once the gate clears, further money must be posted as `INSTALMENT_PAYMENT` so it actually allocates against the schedule instead of just inflating `total_paid_minor`.
- `Contract.inventoryItemId` is a plain FK, **not** unique (`InventoryItem.contracts` is a list, not a to-one). It used to be `@unique`, which meant the instant any contract — even one immediately `CANCELLED` — referenced a physical item, that serial number could never be issued again: the item correctly flips back to `AVAILABLE`, but a second `contract.create()` against it hit a P2002 forever. Found via the "New Contract" wizard (below) end-to-end in a real browser, not by inspection. `createContract`'s own `item.status !== 'AVAILABLE'` check is what actually prevents double-booking a *currently* live contract — the DB uniqueness was redundant for that and actively wrong for reuse after cancellation.
- **Payment frequency** (`DAILY`/`WEEKLY`/`MONTHLY`) applies to all three types identically: the admin still enters a term as "number of months," but prices each `(product, contractType, termMonths, paymentFrequency)` combination as its own `PriceChartEntry` (own `totalPayableMinor`/`instalmentAmountMinor` — no derived-math risk on money figures). `numberOfInstalmentsForTerm` (`constants/contracts.ts`) converts the term into an actual instalment count using a fixed, staff-legible convention — 30 days/4 weeks per month, not calendar-accurate — so a 6-month term is always 180 daily or 24 weekly instalments. `scheduleService`'s `addPeriod` spaces due dates accordingly (day/week increments, or `addMonths` for `MONTHLY`). For `DEVICE_LOAN`, total interest is still derived from the loan's duration in months and the annual rate (frequency-agnostic), then spread evenly across the frequency-derived instalment count — collecting weekly instead of monthly changes the schedule shape, not the total interest owed.

---

## 6. Payment allocation order (documented constant, not scattered logic)

```
ALLOCATION_ORDER = [PENALTY_OR_FEE, INTEREST, PRINCIPAL_OR_INSTALMENT]
```

- **Types A / B**: no separate interest concept, so allocation is `penalties → oldest unpaid instalment forward`. Overpayment past the final instalment is flagged as `entry_type = CREDIT`, refundable, not silently absorbed.
- **Type C**: `penalties/fees → interest (of the current instalment(s), oldest first) → principal`, per mission §5/§8.3. Implemented as one ordered list the `post_payment` service walks top-to-bottom, not per-type conditionals scattered across controllers — a single allocator function takes the ordered target list for a given contract's type and applies amount left after each step.

Both channels (cash, USSD) call the same `post_payment` service, matching mission §8's explicit requirement and the one thing the legacy system got structurally right (even though its allocator was duplicated between two call sites, which HP-Lite fixes by having exactly one implementation).

---

## 7. RBAC — roles, permissions, branch scoping

Roles (seeded, per mission §11, plus `AGENT` — see §22): `SUPER_ADMIN`, `ADMIN`, `BRANCH_MANAGER`, `CASHIER`, `SALES`, `AGENT`, `STORE_KEEPER`, `AUDITOR`.

Permission strings (dot notation, extending mission §11's examples): `customer.create`, `customer.view`, `customer.update`, `contract.create`, `contract.view`, `contract.cancel`, `contract.writeoff`, `contract.reschedule`, `contract.approve`, `payment.cash.record`, `payment.reverse`, `payment.view`, `pricechart.view`, `pricechart.edit`, `inventory.receive`, `inventory.issue`, `inventory.transfer`, `inventory.adjust`, `inventory.view`, `report.view.branch`, `report.view.all`, `report.export`, `user.manage`, `role.manage`, `audit.view`, `settings.manage`, `agent.ledger.view`, `agent.ledger.remit`, `agent.ledger.manage`.

Enforcement: role→permission only (no per-user overrides, matching what worked in legacy), OR-semantics (`requireAnyPermission`), `SUPER_ADMIN` unconditional bypass, every check server-side at the top of each Route Handler via `src/lib/auth/rbac.ts` helpers (`requireAuth`/`requirePermission`) — never trust a client-supplied branch/user filter.

Branch scoping: `users.branch_id` is nullable — null means all-branch (`SUPER_ADMIN`, `ADMIN`, `AUDITOR`); every other role has a required `branch_id`. Every list/report query for a branch-scoped role adds `WHERE branch_id = req.user.branch_id` server-side, never client-supplied. One `branches` row seeded by default ("Main Branch") since the legacy system was effectively single-branch in practice — resolves mission ambiguity §15.4.

---

## 8. Milestone order

Following mission §14, refined:

1. ~~Phase 0 study~~ (`docs/00-legacy-study.md`) — done.
2. ~~This plan~~ — done. Next: `docs/02-loan-maths.md` (Type C worked example) before touching contract code.
3. `scripts/bootstrap.sh` — scaffold one Next.js app (pages + API routes + Prisma + SQLite), install all deps, init Prisma, create `.env` from `.env.example`, run initial migration, seed roles/permissions/branch/demo users, print summary. Idempotent; `--fresh` flag for destructive reset.
4. Auth, users, roles, permissions, branches — login, JWT, RBAC route-handler helpers, seeded users per role.
5. Customers module.
6. Products + Inventory + stock movements.
7. Price chart (entries + versioning + CSV import + contract-time snapshot read).
8. Contracts + schedule generation for all three types (this is where `docs/02-loan-maths.md` gets consumed).
9. Payment pipeline (`post_payment` service) + cash channel + receipts + reversal.
10. SMS layer — `LogSmsProvider` first (unblocks testing without credentials), `HubtelSmsProvider` after.
11. Hubtel USSD — session handler, payment initiation, callback (fail-closed verification), reconciliation job, mock simulator page (sandbox mode driven by env, per mission §8.2).
12. Reports + dashboard (12 reports from mission §10).
13. Hardening pass: audit trail completeness check, tests (per mission §13 minimum coverage list), README, `docs/03-api.md`.

---

## 9. Ambiguity resolutions (mission §15)

1. **SMS recipient** — the customer. Staff/cashier/manager notification is a config toggle (`NOTIFY_STAFF_ON_PAYMENT=false` by default), per mission's own instruction.
2. **Type C interest basis** — legacy has no interest logic at all to match (study doc §5), so HP-Lite implements **flat rate** first, behind an `InterestCalculator` interface so reducing-balance can be added later without touching callers. Worked example in `docs/02-loan-maths.md`.
3. **Type C device release** — unconditional at disbursement, no down-payment gate. Matches legacy's one universal pattern ("device now" in every contract it supports) — see study doc §3 and plan §5 above.
4. **Multi-branch** — yes, `branch_id` on every relevant table, one branch seeded by default. Legacy has zero branch concept (confirmed in study doc §2/§9), so this is net-new modeling per the mission's explicit instruction to keep it anyway.

---

## 11. Customer phones, mobile money verification, and Hubtel Direct Debit

- **Three phone slots** (`phone`/`phone2`/`phone3` on `Customer`, all nullable, all independently unique): registration requires at least one, enforced at the API layer (`customerService.ts`'s `validateAtLeastOnePhone`), not by making any single slot mandatory. Cross-slot uniqueness (my `phone2` can't equal someone else's `phone1`) is also app-level (`assertPhonesNotTaken`) since the schema's per-column `@unique` only catches same-slot collisions. `primaryPhone()` (`phone ?? phone2 ?? phone3`) is what anything needing one canonical number uses (SMS recipient, direct-debit default); USSD lookup matches any of the three via `OR`.
- **Mobile money verification** (`hubtelVerificationService.ts`) is modeled on `salesinventoryapp`'s actual Hubtel Verification API usage — confirms a number is a real, currently-registered wallet and returns the holder's name, purely a typo/sanity check. Rate-limited (30/5min per user) and cached (5min), **fails open** — a verification hiccup never blocks registration or a payment. It is *not* an OTP/SMS-code flow — that pattern doesn't exist anywhere in the reference codebase, so nothing was built to imitate it.
- **Hubtel Direct Debit** (`hubtelPreapprovalService.ts`, modeled on the legacy `hirepurchase` app's Preapproval API) is a mandate: the customer approves *once* (a USSD prompt or an OTP Hubtel sends directly to their phone — this app never sees or handles that code), then the merchant charges it repeatedly with no further customer action. Mock mode (no live Hubtel account) resolves a mandate to `APPROVED` synchronously, same convention as `initiateHubtelPayment`'s mock charge.
  - **Eligibility**: only `DEPOSIT_INSTALMENT` and `DEVICE_LOAN`, only once `ACTIVE` — `SAVE_TO_OWN` has no due schedule to auto-collect against (free-form savings, §5 above), and a contract still `PENDING_DEPOSIT` has no instalment schedule yet.
  - **Network restriction**: MTN, Vodafone/Telecel only — AirtelTigo has no Hubtel direct-debit product (matches the legacy app exactly).
  - **Reuse**: an existing `APPROVED` mandate for the same customer+number+network is reused rather than re-prompting.
  - **Collections run** (`collectionsService.ts`, cron in `instrumentation.ts`): proactively charges the oldest due instalment for every `ACTIVE` contract with an attached `APPROVED` mandate. This is the one piece the legacy app never actually wired up in production (its own auto-retry only re-attempts charges that had already failed) — without it, a mandate would just be something nobody ever uses to collect.
  - **Retry**: a failed charge schedules a retry at a fixed 1/3/7-day offset (capped at 3 attempts) — a hardcoded policy, not a configurable settings model, matching this codebase's existing style (`overdueService`'s fixed `DEFAULT_THRESHOLD_DAYS`).

## 12. Price chart pricing model matches the legacy hirepurchase app

Studied the legacy app's actual `Product`/`ProductPricing` schema and its admin product-pricing UI (not `salesinventoryapp` — that's a different reference project) and matched two concrete structural traits HP-Lite previously diverged on:

- **Fixed 3/4/6-month terms** (`PRICE_CHART_TERM_MONTHS` in `constants/contracts.ts`), not the free-form 1–60 months HP-Lite allowed before — legacy's `ProductPricing.installmentMonths` only ever takes 3, 4, or 6. Enforced in `priceChartService.validateEntryBody` (the admin-entry point), **not** a DB constraint — existing rows and test fixtures at other terms (e.g. `docs/02-loan-maths.md`'s 12-month DEVICE_LOAN worked example) stay valid since DEVICE_LOAN has no legacy precedent to match at all (mission ambiguity resolution #2: legacy has no loan/interest concept whatsoever).
- **Absolute deposit amount, not a percentage** — `PriceChartEntry.depositAmountMinor` replaces `depositPercentage`. Legacy's `ProductPricing.depositAmount` is a currency figure the admin types directly per term, not a percent of the total; HP-Lite now matches that exactly, and `contractService.ts` just copies it onto the contract rather than computing `totalPayable × percentage ÷ 100`. `Contract.depositPercentage` (a pure snapshot, never read for any logic or by any UI) was dropped rather than kept as dead weight.
- Payment frequency (DAILY/WEEKLY/MONTHLY) stays exactly as already built (§11-adjacent, an explicit HP-Lite requirement with no legacy precedent either way) — legacy's own contract wizard turned out to already have an equivalent `paymentFrequency` concept that only affects instalment *count*, never the priced total, which is exactly how HP-Lite already worked; confirms no change was needed there.

---

## 14. Every product's price chart must cover all three contract types

Requirement: a product's pricing must satisfy SAVE_TO_OWN, DEPOSIT_INSTALMENT, and DEVICE_LOAN, not just whichever type an admin happened to price first — a customer choosing any of the three for a given product must find a price.

- `priceChartService.createPriceChartEntriesForTerm` — the single-entry creator (`createPriceChartEntryInTx`) is now a tx-scoped helper reused by both the original one-at-a-time `createPriceChartEntry` and this new bundle path, which takes a product + term + frequency + a map of per-type pricing and creates only the types not already actively priced for that exact combo, atomically (`POST /api/price-chart/bundle`). Submitting a bundle where every listed type is already priced, or where any one entry fails `validateEntryBody`, creates nothing — no partial bundles.
- `priceChartService.missingContractTypesForProduct` / the `missingContractTypes` field now returned on every product from `GET /api/products` — "has at least one active entry, any term/frequency" per type, used to render a "X/3 types priced" badge on the Products list and a "Missing: ..." / "All 3 contract types priced" badge on the product detail page.
- The Price Chart admin page's entry form was redesigned around this: pick Product + Term + Frequency first, then three cards (one per contract type) — types already priced for that combo show "Already priced" and are skipped; only checked, unpriced types are submitted.
- Re-pricing a type that's already active for a combo is still a single-entry edit via the original `createPriceChartEntry`/`POST /api/price-chart` — the bundle path only fills gaps, it never supersedes existing pricing.

---

## 16. Company/org settings (name, logo, address, phone, email)

The client running this HP-Lite instance needs to brand it as their own business rather than seeing "HP-Lite" everywhere — shown in the browser tab title, the top navbar/sidebar, and on reports.

- `OrgSettings` — a single always-exactly-one-row table (`id` pinned to the literal `"singleton"`), not a multi-tenant `Company` table: this app is single-tenant per deployment (one business per running instance), so there's no notion of "which company" to key rows by.
- `GET /api/settings` is deliberately public (no `requireAuth`) — the login screen and the browser tab title need the company name/logo before anyone has signed in, and none of these fields are sensitive. `PATCH /api/settings` requires the new `settings.manage` permission (SUPER_ADMIN + ADMIN, via the same `ALL.filter(...)` pattern as everything else ADMIN can touch except user/role management).
- The root layout's `generateMetadata` reads `OrgSettings` directly (server component, no HTTP round-trip) to set the tab title. This forced `export const dynamic = "force-dynamic"` onto the whole app: metadata generated during static prerendering would otherwise freeze the title into the build artifact, so a company-name change on the Settings page would never reach a live deployment without a full rebuild+redeploy. Given every page under `(app)` is already a client component gated behind an auth check (no meaningful static HTML being cached either way), trading static generation for per-request rendering costs nothing real here.
- Client-side branding (`AppTopBar`, `AppSidebar`'s brand strip, the login screen) reads a small `orgSettingsStore` (zustand) hydrated once from `GET /api/settings` on app mount — same pattern as `authStore`. Falls back to the `HP-Lite` defaults on fetch failure so a settings-endpoint hiccup never blocks the rest of the UI.
- Reports get a shared `ReportLetterhead` component (logo/initials badge + company name + address/phone/email) at the top of each report page; the Daily Cash CSV export also prepends the company name as its own header row.

---

## 18. Contract wizard's payment-terms step matches the legacy admin UI, plus grace period + late penalties

The mission's own glossary named "Grace Period" and "Penalty" from the start (docs/00-legacy-study.md §mission glossary), but neither existed anywhere in the code — no field, no automated penalty creation — until this pass, prompted by redesigning step 3 ("Configure Payment Terms") of the contract wizard to match the legacy admin app's actual layout: term selectable as priced cards (conforming to whatever the product's price chart says, never free-typed), then frequency/start date/grace/penalty/payment-method, a live summary, and a client-side schedule preview.

- `Contract.gracePeriodDays` (default 7) and `Contract.penaltyRateBps` (default 0, bps like `interestRateBps`) — set per contract in the wizard. `penaltyRateBps` of 0 is a deliberate no-op, not a special case to check for.
- `overdueService.applyLatePenalties()` — once an OVERDUE instalment passes its own contract's `gracePeriodDays`, creates a one-time `Penalty` row for `penaltyRateBps`% of that instalment's amount. Idempotent per instalment (checks for an existing `reason: 'LATE_PENALTY'` row first), wired into the daily cron right after `markDefaultedContracts` (same "must run after markOverdueInstalments" ordering).
- **Direct debit at contract-creation time**: the wizard captures network+msisdn immediately if the customer's chosen payment method is Hubtel, but mandates require the contract to already be ACTIVE (see §11) — for DEVICE_LOAN (ACTIVE immediately) it's initiated right there in `createContract`; for DEPOSIT_INSTALMENT (starts PENDING_DEPOSIT) the network/msisdn are stashed on `Contract.pendingDirectDebitNetwork/Msisdn` and consumed automatically the moment `paymentService.advanceContractStatus` flips it to ACTIVE — no re-asking the customer once the deposit clears.
- That initiation is **awaited**, not fire-and-forget like SMS: unlike an SMS send, it sets real contract state (`hubtelPreapprovalId`) a caller checking the contract right after creation/payment would expect to already be reflected, and mock mode resolves with no real network latency to shield against. Still fully error-contained (try/catch, never throws out) so a Hubtel failure can't undo a contract or a payment. `paymentService.ts`'s side of this uses a dynamic `import('./hubtelPreapprovalService')` — a static one would be circular, since that module imports `postPayment` from `paymentService.ts` for `chargeDirectDebit`.
- The wizard's "Preview Installment Schedule" reuses `scheduleService.ts`'s exact generation functions client-side (that file has zero server-only dependencies — pure date/money math) rather than a new preview endpoint, so the preview can never drift from what the backend will actually create.

---

## 20. DEVICE_LOAN disburses cash — no store inventory unit involved at all

Corrected a fundamental misreading of what Device Loan means: it isn't "hand over a store device with loan-style financing" (which is what SAVE_TO_OWN/DEPOSIT_INSTALMENT already are, just with different payment shapes) — it's a **cash loan**. The customer receives money and buys a device themselves, outside the store. So unlike the other two types, a DEVICE_LOAN contract never reserves, issues, or otherwise touches a specific serialized `InventoryItem` — `Contract.inventoryItemId` is `null` for every one of them.

- `createContract` branches on contract type before ever touching inventory: SAVE_TO_OWN/DEPOSIT_INSTALMENT still require `inventoryItemId` (a specific available unit at the customer's branch); DEVICE_LOAN requires `productId` instead — pricing still comes from that product's price chart (principal + interest derived exactly as before), it's just never tied to a specific stock unit. No `applyStockMovement` call happens for a DEVICE_LOAN contract at all.
- This meant moving contract-type selection earlier in the wizard: it used to be the first field inside step 3 ("Configure Payment Terms"), but step 2 now needs to already know the type to decide whether to show an inventory-unit picker or a product-only picker. It's now the first field of step 2, retitled "Select Type & Product".
- **Disbursement is a real cash outflow, unlike every other payment flow in this app** (all of which are customer→store). Since nothing else in HP-Lite ever tracked money leaving the till, `POST /api/contracts` logs a separate `DEVICE_LOAN_DISBURSEMENT` audit entry distinct from the ordinary `CONTRACT_CREATE` one, and the loan-book report (`reportService.loanBookReport`) now surfaces `disbursedAt` (`= activatedAt`, since a loan is ACTIVE immediately) per row so the report itself shows when each disbursement happened, not just the outstanding balance.
- Save-to-Own's already-implemented behavior (free-form deposits, blocked once COMPLETED since that's a terminal status, device released only after full payment, withdrawal-with-refund via `reverseAllPaymentsForContract`) was independently re-verified against this same request and needed no changes — it already matched exactly.

---

## 21. Open questions still to resolve during implementation (not blocking)

- Exact CSV import column schema for price chart bulk-import (mission §6) — design when building that screen, not upfront.
- Whether `payment_allocations` needs a `FEE` target distinct from `PENALTY` for Type C (mission says "penalties/fees → interest → principal") — likely yes, decide when implementing Type C allocation.
- Receipt PDF/print template styling — deferred to the cash-payments milestone.

---

## 22. Agent module (ported from the legacy hirepurchase app's own AGENT role)

An `AGENT` role added alongside `SALES` (same permission shape: `customer.create`, `customer.view`, `contract.create`, `contract.view`, `pricechart.view`, `inventory.view`), plus two differences that make it genuinely a distinct role rather than a renamed `SALES`:

**Own-scoped, not branch-scoped visibility.** Every other branch-scoped role (`BRANCH_MANAGER`, `CASHIER`, `SALES`, `STORE_KEEPER`) sees the whole branch's customers/contracts. `OWN_SCOPED_ROLES` (`constants/rbac.ts`, currently just `AGENT`) restricts further, to only records the acting user themselves created — `ownRecordsWhere`/`assertOwnRecordAccess` (`auth/rbac.ts`), layered on top of the existing `branchScopeWhere`/`assertBranchAccess` at every customer/contract read. Matches the legacy manual's own rule verbatim: "you will only ever see contracts you personally created."

**Contracts require approval.** A contract created by an `AGENT` user (`requiresApproval`, computed server-side from the acting user's role — never client-supplied) starts at `PENDING_APPROVAL` instead of its type's usual first status, regardless of type — two new statuses, `PENDING_APPROVAL` and `REVISION_REQUESTED` (`PRE_APPROVAL_STATUSES`), prepended to every type's state machine in §5's `CONTRACT_STATUSES_BY_TYPE`. Neither status accepts a payment (`postPayment`/`postWithdrawal`/`postDeviceLoanPayment` all refuse them), is visible to the customer portal or USSD, or fires the `contract.activated` SMS. A new permission, `contract.approve` (held by `BRANCH_MANAGER`/`ADMIN`/`SUPER_ADMIN`), gates three actions:
- **Approve** — jumps straight to the type's real first status (`INITIAL_STATUS_BY_TYPE`: `ACTIVE` for `SAVE_TO_OWN`/`DEVICE_LOAN`, `PENDING_DEPOSIT` for `DEPOSIT_INSTALMENT`), exactly as if a non-agent had created it — the withheld SMS fires now, and a `DEVICE_LOAN`'s disbursement audit entry is only logged here, never at submission.
- **Request revision** — `REVISION_REQUESTED` + a required reason.
- (**Reject outright** is not a separate action — `cancelContract`/`writeOffContract` already accept both pre-approval statuses as a source state, doubling as an approver's "no" with no revision cycle needed.)

The agent who created a `REVISION_REQUESTED` contract (and only them — `assertOwnRecordAccess`) can edit its terms and resubmit (`resubmitContract`): back to `PENDING_APPROVAL`, reason cleared, and for `DEPOSIT_INSTALMENT` the instalment schedule is rebuilt from scratch (safe — nothing on the old one can have been paid, since payments are refused on both pre-approval statuses).

**Commission + deposit-custody ledger.** An agent who collects a `DEPOSIT_INSTALMENT` contract's deposit in cash is holding company money, separately from the fact that the deposit is already correctly recorded as paid on the contract itself. The moment such a deposit posts (`entryType: 'DEPOSIT'`, `channel: 'CASH'`, contract's creator has role `AGENT` — checked inside `postPayment`'s own transaction, so it can never desync from the payment it's derived from), an `AgentDepositLedger` row is created: `commissionAmountMinor` snapshotted from `CommissionSettings` (Settings > Agent commission, one fixed amount, editable by `settings.manage`) and clamped to the deposit itself, `amountOwedMinor = depositAmountMinor − commissionAmountMinor`. Deliberately **not** wired to an automated mobile-money remittance (no new parallel Hubtel integration, given money-correctness stakes and no way to test live callbacks here) — an agent instead *files* a remittance claim (`AgentRemittance`: amount, method, an optional self-reported reference) against a ledger entry, capped so pending+confirmed claims can never exceed what remains owed, and an approver (`agent.ledger.manage`: `BRANCH_MANAGER`/`ADMIN`/`SUPER_ADMIN`/`AUDITOR`) confirms or rejects it — only confirming ever touches the ledger's running total, flipping it to `SETTLED` once fully remitted.
