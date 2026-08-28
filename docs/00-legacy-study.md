# 00 — Legacy Study

Source: `/run/media/wilson-junior/ubuntu/projects/hirepurchase` (product name in its own docs: "AidooTech Hire Purchase System"). This is a real, production system with live incident postmortems in its repo root — treated as authoritative for behavior, terminology, and hard-won lessons.

Studied via two research passes: one over the backend code (`backend/prisma/schema.prisma`, controllers, services), one over the operational manuals (`SYSTEM_MANUAL.md`, `ADMIN_MANUAL.html`, `AGENT_MANUAL*.html`, `CHANGELOG.html`) and the frontend (`frontend/src`). Findings below are merged and reconciled — where the manuals and the code disagree, the code wins as ground truth, and the disagreement itself is noted (it's a useful signal).

---

## 1. Stack detected

| Layer | Legacy | HP-Lite decision |
|---|---|---|
| Backend | Node 20.x, Express 5, TypeScript, Prisma 5 | **Reuse** |
| DB (declared) | `@libsql/client` + `@prisma/adapter-libsql` in `package.json` | — |
| DB (actual) | **Plain PostgreSQL via Supabase** — `schema.prisma` datasource is `provider = "postgresql"`, real `DATABASE_URL` points at a Supabase pooler. The libsql packages are imported nowhere in `src/` — vestigial, likely an abandoned migration. | **Now matches: PostgreSQL** (SQLite was a temporary deviation — see below) |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Radix UI primitives, Zustand, `react-hook-form` + `zod`, `axios` | **Reuse** |
| Package manager | npm | **Reuse** |
| Auth | JWT (`jsonwebtoken`), `bcryptjs`, 7-day expiry | **Reuse** |
| File storage | Supabase Storage | **Drop** (no photo/signature upload requirement in scope; revisit if needed) |

**Why SQLite instead of Postgres, originally:** this machine has no `psql`/`mysql`/`docker`, no passwordless `sudo`, and no `node`/`npm` preinstalled — a from-scratch, one-script bootstrap that stands up a Postgres server (or requires Docker) wasn't realistic here without asking the user to authorize system package installation or a Docker Desktop install. Prisma's `sqlite` provider needed no server, no daemon, no privileged install. This was flagged as a documented, deliberate deviation from day one, precisely *because* the schema was designed to make reversing it cheap: Prisma abstracts most schema features (models, relations, string-backed status fields, indexes) identically across sqlite/postgres, and the legacy schema itself avoids native Postgres enums (status fields are plain `String` with app-level validation), so the migration path back to real Postgres was always meant to be just a `datasource` swap plus re-running migrations — not a rewrite.

**Reversed 2026-08-28** (explicit request: "use the db structure/type in the hirepurchase main app"). `schema.prisma`'s datasource is now `provider = "postgresql"` with `url`/`directUrl` matching the legacy app's own pooled/direct-connection pattern; every model's `@id` now defaults to `uuid()` (legacy's own convention) instead of `cuid()`. Migration history was reset to a single fresh Postgres-dialect baseline (`prisma/migrations/20260828000000_init`) generated offline via `prisma migrate diff --from-empty` — this machine still has no reachable Postgres server, so nothing has been run against a live database; the schema is ready the moment a `DATABASE_URL`/`DIRECT_URL` is supplied. One legacy convention was deliberately **not** copied: every money field in the legacy schema is `Float` (`totalPrice`, `installmentAmount`, `outstandingBalance`, …) — HP-Lite keeps integer minor units (`Int`, e.g. `totalPayableMinor`), since that's the mission's own non-negotiable rule and floating-point money is exactly the kind of bug a real production incident (§4/§6 below) was about. Matching the legacy app's *database engine* doesn't mean matching a data type that's a known, documented footgun.

Everything else in the stack is directly reusable and battle-tested by a real system, so HP-Lite keeps it.

---

## 2. Data model (legacy, as built)

Full model list in `backend/prisma/schema.prisma` (571 lines):

- **Users/roles**: `Role`, `Permission`, `AdminUser` (roleId FK, no per-user permission overrides — permissions live only on the role).
- **Customer service**: `CsoAgentAssignment`, `ContactAttempt` — **excluded from HP-Lite** (§3 mission scope).
- **Customer**: `Customer` — membershipId, phone (unique, doubles as portal login), guarantorName/guarantorPhone as plain fields (no separate Guarantor entity), photoUrl, isActivated/activatedAt.
- **Product & inventory**: `ProductCategory`, `Product` (basePrice), `ProductPricing` (productId × installmentMonths[3|4|6] → basePrice, depositAmount — **this is the legacy "price chart"**), `InventoryItem` (serialNumber unique = IMEI/serial, status: AVAILABLE/SOLD/RESERVED, plus Knox lock fields — excluded).
- **Contracts**: `HirePurchaseContract` — **single model, no contract-type discriminator.** `paymentMethod` (HUBTEL_REGULAR/HUBTEL_DIRECT_DEBIT/MANUAL/CASH) is the closest thing to a "type" but only affects payment collection, not contract structure or device-release timing. `status`: ACTIVE/COMPLETED/DEFAULTED/CANCELLED/PENDING_APPROVAL/REVISION_REQUESTED/WRITTEN_OFF (plain `String`, not a Prisma `enum`). `InstallmentSchedule` (installmentNo, dueDate, amount, paidAmount, status: PENDING/PARTIAL/PAID/OVERDUE/WRITTEN_OFF).
- **Payments**: `PaymentTransaction` (transactionRef **unique** = idempotency key, status PENDING/SUCCESS/FAILED, retry fields), `PaymentRetry`, `Penalty`, `HubtelPreapproval` (direct-debit consent).
- **Knox**: `ManagedDevice`, `ManagedDeviceCommand` — **excluded**.
- **Audit/notifications**: `AuditLog` (userId, action, entity, entityId, oldValues/newValues as JSON strings), `NotificationSettings`, `RetrySettings`, `NotificationLog` (type SMS/EMAIL, status SENT/FAILED/PENDING), `PasswordResetOtp`.
- **Agent commission**: `CommissionSettings`, `AgentDepositLedger`, `AgentDepositPayment` — **excluded** (not in mission scope §2; entangled only with the approval workflow, which is also excluded).

**Nothing resembling a branch/location model exists anywhere.** "Scoping" is entirely creator/assignment-based (`scopeService.ts`): a permission set resolves to `{all} / {own,userId} / {assigned,agentIds} / {none}`, and queries are narrowed by `createdById`. HP-Lite's mission requires branch scoping explicitly (§11, §15.4), so this is new modeling, not a port — see plan doc.

---

## 3. Contract lifecycle & state machine (legacy)

- **Creation** (`contractController.ts:239-624`): one `prisma.$transaction` writing the contract row + `installmentSchedule.createMany` + inventory status flip + customer activation, all-or-nothing.
- **Schedule is precomputed once at creation** and stored (not recomputed on the fly), via `calculateInstallmentSchedule()` (`utils/helpers.ts:45-73`). Nothing regenerates it later except explicit admin actions (reschedule/edit-instalment/amend).
- **Approval branch**: `requiresApproval = (creatorRole === 'AGENT')`. If true → status `PENDING_APPROVAL`, inventory → `RESERVED`. Otherwise → status `ACTIVE` immediately, inventory → `SOLD` immediately. This is a plain `if` in `createContract`, not a separate subsystem — confirms it can be removed cleanly by always taking the "otherwise" branch, exactly what HP-Lite's mission requires (§3: "contracts go straight to active on creation; no maker-checker").
- Approval (when it happens) also fires three side-effects inline: SMS/email, Knox enrollment, and agent-deposit-ledger creation — all three are excluded from HP-Lite, so removing the approval branch removes all three trigger points too, cleanly.
- Other transitions: `cancelContract` → CANCELLED, frees inventory; `writeOffContract` → WRITTEN_OFF, frees inventory, records reason/who/when; `transferOwnership` → COMPLETED; `deleteContract`/`nullifyContract` → hard delete (kept only behind a `NULLIFY_CONTRACT` permission — **not** a pattern HP-Lite should copy, given the mission's "nothing financial is hard-deleted" rule).
- `updateOverdueInstallments` — a cron sweep that flips overdue `InstallmentSchedule` rows to `OVERDUE`, also re-run opportunistically on manual notification triggers (per `CHANGELOG.html`) for immediate accuracy, not purely time-driven.

**Verdict:** the legacy system models exactly one contract shape — deposit-now, device-now, instalments-after — which maps directly onto HP-Lite's Type B (`DEPOSIT_INSTALMENT`). Types A (`SAVE_TO_OWN`, device withheld until fully paid) and C (`DEVICE_LOAN`, interest-bearing) have **no legacy equivalent** and are new domain modeling for HP-Lite, following the mission spec.

---

## 4. Payment posting & allocation (legacy) — the load-bearing logic to keep

Single allocator (duplicated between the manual-payment path and the Hubtel-callback path — worth **not** duplicating in HP-Lite; mission explicitly requires one `post_payment` service for both channels):

1. **Allocation order**: unpaid `Penalty` rows first (oldest first, each fully-or-not-at-all) → then `InstallmentSchedule` rows ordered by `installmentNo` ascending (oldest-due-first), each paid as far as the remaining amount allows, leaving a `PARTIAL` row if it runs out. **No interest concept exists** — there is no principal/interest split anywhere in the legacy codebase (see §5).
2. **Totals are recomputed from source of truth on every payment**, not incremented: `totalPaid = depositAmount + SUM(SUCCESS PaymentTransaction.amount)`; `outstandingBalance = totalPrice - totalPaid` (clamped ≥0); contract flips to `COMPLETED` once outstanding ≤ a rounding tolerance (0.005). **This recompute-from-ledger pattern is the single most important thing to keep** — it's self-healing against drift, and its *absence* in an earlier iteration is exactly what caused the incident in §6 below.
3. **Overpayment is rejected outright** — the legacy system validates `amount ≤ outstandingBalance` before accepting a payment (HTTP 400 otherwise). **HP-Lite deviates here**: the mission requires overpayment to roll to the next instalment (or flag as refundable credit on completion), and early settlement in one payment — both are explicit acceptance-test requirements (§13), so this is a deliberate, documented improvement over the legacy behavior, not an oversight.
4. **Idempotency**: `PaymentTransaction.transactionRef` is a unique column, checked/generated before insert. The actual concurrency guard against a replayed callback is a conditional update — `updateMany({ where: { id, status: { not: 'SUCCESS' } } })` — so a race between two simultaneous callbacks can only have one succeed. **Keep this exact pattern** (it's the correct primitive: a unique key alone doesn't stop a second callback from re-processing an already-SUCCESS row and double-posting side effects; the conditional-update-on-status is what actually does).
5. **Reversal/correction = hard delete + full replay**, not a reversal row: editing/deleting a payment resets every non-fully-paid instalment to PENDING and replays all remaining SUCCESS payments in order to rebuild state. Only payments flagged `metadata.isManual === true` are touched this way; gateway payments can't be edited/deleted at all. **HP-Lite deviates here** per its own non-negotiable rule #6 ("nothing financial is hard-deleted... corrections are reversals with a reason and a user") — a reversal will be a new ledger entry with `reason` + `reversed_by_user_id`, leaving the original row intact, then the same recompute-from-ledger logic in point 2 naturally produces the corrected balance with no special-casing.

---

## 5. Interest / instalment math (legacy)

**There is no interest calculation anywhere in the legacy codebase** (confirmed by an exhaustive grep for "interest" across `backend/src` and the schema — zero hits). The schedule generator is a straight-line split:

```ts
// backend/src/utils/helpers.ts:45-73 (verbatim, reformatted)
const installmentAmount = Math.ceil((financeAmount / totalInstallments) * 100) / 100; // rounds UP to the cent
for (i = 1..totalInstallments) {
  amount = (i === totalInstallments)
    ? financeAmount - (installmentAmount * (totalInstallments - 1))  // last one absorbs the remainder
    : installmentAmount;
}
```

`financeAmount = totalPrice - depositAmount`. Any markup/profit is baked directly into `Product.basePrice`/`ProductPricing.basePrice`, set manually by an admin per product per tenor — not computed by the contract engine. Penalties are a flat `%` of *something* (`calculatePenalty = round(amount * pct/100, 2)`), tracked as a separate model, not folded into the schedule.

**Rounding rule worth keeping verbatim for Types A/B**: round each regular instalment *up* to the cent, then let the **final instalment absorb the exact remainder** (so it reconciles to the total to the cent, and is typically the smallest instalment rather than the largest). This is a clean, simple, auditable rule and HP-Lite reuses it for Types A and B. Type C (loan, interest-bearing) needs genuinely new math since none of this transfers — see `docs/02-loan-maths.md`.

---

## 6. The deposit-as-implicit-value incident (critical lesson)

Documented in `ROOT_CAUSE_DEPOSIT_MISSING.md` / `FINAL_DIAGNOSIS_*.md` / `SYSTEM_WIDE_FIX_SUMMARY.md` at the legacy repo root (PII redacted from this summary per the research pass instructions).

**The flaw**: the deposit is never written as its own `PaymentTransaction` row — it's folded directly into `totalPaid` as a bare number at contract creation (`totalPaid: Number(depositAmount)`). Because it's not a queryable, auditable transaction, there is nothing to reconcile against if `totalPaid` ever drifts (e.g. from a manual DB fix). One real incident cascaded: an admin manually zeroed `totalPaid` because a deposit hadn't actually been collected, then a second manual "correction" on top of that double-subtracted the deposit, producing a materially wrong balance. **Roughly 1 in 7 audited contracts had this class of discrepancy**, all traced to the same structural gap — an implicit, non-transactional deposit.

**The fix that was proposed but never actually implemented in the schema** (confirmed — no CHECK constraint exists in the current schema): a DB constraint that `totalPaid ≥ depositAmount` for ACTIVE contracts, validation at creation, an audit-warning on any mismatch, and a scheduled reconciliation job.

**HP-Lite's design decision, directly informed by this incident**: the deposit is **always an explicit ledger/payment-transaction row**, created atomically with the contract, with its own `created_by_user_id`, exactly like every other payment. `total_paid` is *always* `SUM(all posted ledger entries)` — zero special-casing, nothing implicit to drift. This closes the entire bug class structurally rather than papering over it with constraints. (Constraints and a reconciliation job are still worth having as defense-in-depth, but they're not load-bearing the way they'd have to be under the legacy design.)

---

## 7. Inventory (legacy)

No stock-movement ledger exists — state lives purely as a status field (`InventoryItem.status`: AVAILABLE/SOLD/RESERVED) mutated in place by controllers, with history only inferable from `AuditLog`. Transitions: AVAILABLE→RESERVED (agent-created, pending approval) or →SOLD (non-agent, immediate) at creation; RESERVED→SOLD on approval; →AVAILABLE on cancel/write-off/delete. `serialNumber` (IMEI or serial) is the sole identity key, 1:1 with a contract via a unique FK.

Devices are handed over at contract signing in every legacy case (financed immediately) — there's no "withhold the physical device until fully paid" gate in the legacy system; Knox device-locking substitutes for that (lock the device instead of withholding it). Since Knox is excluded from HP-Lite, **Type A (`SAVE_TO_OWN`) needs a real withholding gate** — inventory reserved-not-issued until balance is zero — which is new logic, not a port.

**HP-Lite deviates from legacy by adding a proper stock-movements ledger** (RECEIPT/RESERVE/ISSUE/RETURN/TRANSFER/ADJUSTMENT), per mission §7 — this is an explicit improvement over legacy's status-field-only approach, consistent with the same "ledger, not a mutable field" lesson from §6.

---

## 8. SMS & Hubtel integration (legacy)

- **SMS provider**: Nalo SMS (`NALO_API_URL/API_KEY/SENDER_ID`), abstracted behind a single `notificationService.ts`, gated by an env flag + a cached settings row, every send logged to `NotificationLog`. **HP-Lite deviates**: the mission explicitly specifies Hubtel SMS as the provider (§9), so HP-Lite implements an `SmsProvider` interface with `LogSmsProvider` (dev default) and `HubtelSmsProvider` (real), not the legacy's Nalo client — but keeps the legacy's abstraction shape (interface + settings gate + delivery log) and its async/non-blocking/retry pattern.
- Triggers worth keeping: payment success (mandatory per mission), contract activation/welcome, pre-due reminder, overdue notice, combined-overdue (one SMS bundling multiple overdue instalments per customer rather than spamming one per instalment — a good pattern to keep for Type B/C arrears).
- **Hubtel payments**: `hubtelService.ts` implements both a regular receive-money charge and a direct-debit preapproval+recurring-charge flow. Callback processing is defensive against duplicates/out-of-order delivery and validates phone/preapproval-id consistency (throws on mismatch). **Gotcha to carry over**: Hubtel adds its own charge on top of the customer's requested amount (`AmountCharged` = requested + `Charges`, merchant receives `AmountAfterCharges`) — HP-Lite's ledger should post the **net/after-charges amount** as the payment applied to the contract, matching the amount the business actually received, and store the gross/charges breakdown in the raw payload for reference.
- **USSD**: legacy implements a genuine stateless-per-request USSD menu machine — state is round-tripped by Hubtel itself as an opaque string token per hop (e.g. `AMOUNT|{contractId}|{network}|...`), no server-side session store. This is a clean, simple pattern worth reusing directly for HP-Lite's USSD handler (mission §8.2 calls for "sessions persisted with TTL" — legacy's token-based approach is arguably simpler and avoids a session store entirely; HP-Lite will use a lightweight DB-backed session table instead since the mission explicitly asks for persisted sessions with TTL, but the menu-state-machine shape is reused).
- **Callback verification is a known weak spot to fix, not copy**: legacy checks a shared-secret token via `timingSafeEqual`, and — critically — **skips validation entirely if the secret env var isn't set**, silently passing. HP-Lite keeps the shared-secret pattern (it's what Hubtel's sandbox actually supports) but must **fail closed** if the secret isn't configured, not fail open.
- **Reconciliation**: legacy has an admin/cron-triggered pass that polls Hubtel for stuck PENDING transactions — directly reusable pattern for HP-Lite's mission-required reconciliation job (§8.2).

---

## 9. Roles & permissions (legacy)

Roles seeded: `SUPER_ADMIN`, `ADMIN`, `SALES_AGENT`, `AGENT`, `CUSTOMER_SERVICE` (the last excluded from HP-Lite). ~46 SCREAMING_SNAKE_CASE permission strings on `backend/src/constants/permissions.ts`, assigned per-role only (no per-user overrides). Middleware: `requireAnyPermission(...)` is OR-semantics, `SUPER_ADMIN` unconditionally bypasses every check, `requireSuperAdmin` is a separate hard gate.

No branch model — "scoping" is creator/assignment-based (`scopeService.ts`), resolving to `{all}/{own}/{assigned}/{none}` per permission held, with a fail-closed default (`{none}`, never `{all}`) when an assignment-scoped user has no assignments. This fail-closed default is a good pattern to keep even though HP-Lite's scoping mechanism (branch-based) differs structurally.

HP-Lite adopts the mission's own role list (§11: SUPER_ADMIN/ADMIN/BRANCH_MANAGER/CASHIER/SALES/STORE_KEEPER/AUDITOR) and dot-notation permission strings (`contract.create`, `payment.cash.record`, …) rather than legacy's naming, but keeps: role→permission (not per-user) assignment, OR-semantics permission checks, SUPER_ADMIN bypass, and fail-closed scoping.

---

## 10. Things deliberately dropped (per mission §3, confirmed decouplable)

| Dropped | Legacy coupling found | Decoupling note |
|---|---|---|
| **Knox device management** | `ManagedDevice`/`ManagedDeviceCommand` models, ~5 service/controller files, 4 fields on `InventoryItem`. Both FKs (`contractId`, `inventoryItemId`) are nullable — architecturally already decoupled. Only wiring to remove: two fire-and-forget call sites (`enrollManagedDeviceForContract` at approval, `safelyEvaluateManagedDeviceForContract` after every payment). Payments never depend on Knox's result (one-way, non-blocking). | Drop the models/files entirely; no call site elsewhere breaks. |
| **Approval workflow** | A single `if (creatorRole === 'AGENT')` branch in `createContract`, not a subsystem. Approval inline-triggers SMS, Knox enrollment, and agent-deposit-ledger creation. | Always take the non-approval branch (status→ACTIVE, inventory→SOLD immediately) — this removes all three triggers for free. |
| **Customer service / ticketing** | `CsoAgentAssignment`, `ContactAttempt` models; a verification-required gate in the approval controller that only fires when the approver's scope is `'assigned'` (CSO role). | Drop the models and the `CUSTOMER_SERVICE` role; the gate is dead code with no CSO role to trigger it. |
| **Agent commission/deposit ledger** | `CommissionSettings`, `AgentDepositLedger`, `AgentDepositPayment` — created only from inside the approval-workflow trigger. | Not in mission scope (§2) at all; drops automatically once the approval workflow is gone, nothing else references it. |

---

## 11. Terminology to stay consistent with

Customer, Membership ID, Guarantor (name + phone, kept as plain fields on Customer rather than a separate entity, matching legacy — HP-Lite's KYC-lite scope doesn't need more), Product, Inventory Item (serial/IMEI), Contract / Contract Number, Instalment / Instalment Schedule, Deposit Amount, Finance Amount (`totalPrice − depositAmount`), Total Price, Payment Transaction, Penalty, Grace Period, Price Chart (generalizing legacy's `ProductPricing`).

Status vocabulary kept where it maps: `PENDING`/`PARTIAL`/`PAID`/`OVERDUE` for instalments; `ACTIVE`/`COMPLETED`/`CANCELLED` for contracts (extended per mission with the three contract-type-specific status sets in §5 of the mission). Inventory status naming is normalized to `AVAILABLE`/`RESERVED`/`ISSUED`/`RETURNED` (legacy inconsistently used `SOLD` in the admin doc vs `ON_CONTRACT`/`RESERVED` elsewhere — HP-Lite picks one consistent set).

---

## 12. Open items carried into the plan doc

- Exact `price_chart_entries` shape (extending `ProductPricing` with a `contract_type` dimension and `effective_from`/`effective_to` versioning, per mission §6).
- Branch model design (net-new — legacy has none).
- Loan math for Type C (net-new — legacy has none); see `docs/02-loan-maths.md`.
- Whether to model contract types as one table with a discriminator or three tables — legacy's single-model-with-no-discriminator approach argues for a single table (it already proved workable at production scale for one shape); decision recorded in `docs/01-plan.md`.
