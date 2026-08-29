# HP-Lite

A self-contained hire-purchase management system for a device retailer: register
customers, price products, hand out contracts across three distinct financing
models, collect payments by cash or mobile money, and see the whole portfolio
through role-scoped reports — all from one app, one database.

Every business detail an operator sees — the app's name in the browser tab
and navbar, the address/phone/logo on reports — is configurable per
deployment from **Settings**, not hardcoded. Money is never a float: every
amount is an integer in minor units (pesewas for GHS) end to end, deliberately
diverging from the legacy system this replaces on that one point.

## What it does

- **Three contract types, each with its own rules, enforced server-side**:
  - **Save to Own** — a customer pays in free-form amounts on no fixed
    schedule; the device is only released once the full price is paid, and
    the customer can walk away and get every payment refunded at any point
    before that release.
  - **Deposit + Instalment** — a deposit gate, then a fixed instalment
    schedule (daily/weekly/monthly) with penalty→instalment→principal
    payment allocation and a 90-day default sweep.
  - **Device Loan** — flat-rate interest, device released immediately at
    disbursement, no deposit gate.
- **Products priced for all three contract types at once**: an admin prices a
  product for a term across whichever contract types are still missing in one
  atomic bundle, and every product/product-list view shows an "X/3 types
  priced" coverage badge so nothing silently ships half-priced.
- **Customers with up to three phone numbers** (at least one required, each
  independently unique), optional mobile-money number verification against
  Hubtel, and one-time Hubtel Direct Debit mandates for proactive daily
  collection on any contract with a fixed schedule.
- **Cash and Hubtel USSD payments**, both idempotent and reversible (a
  reversal never deletes the original row — it's a linked, auditable entry),
  with SMS receipts and a built-in USSD simulator so the whole payment flow
  is testable without live Hubtel credentials.
- **Inventory and stock movements** per branch, a versioned price chart
  (superseding entries are never deleted, so historical contracts keep
  reading the figures they were created against), branch-scoped RBAC across
  7 roles, an audit trail, and 12 reports.

Background and the design decisions behind all of the above:
`docs/00-legacy-study.md` (what this rebuilds from), `docs/01-plan.md`
(schema/modules/every non-obvious architectural call, numbered and dated),
`docs/02-loan-maths.md` (Device Loan interest worked example), `docs/03-api.md`
(endpoint reference).

## Stack

Next.js 16 (App Router, Turbopack), React 19, TypeScript, Prisma, PostgreSQL
(matches the legacy hirepurchase app — see `DATABASE_URL`/`DIRECT_URL` in
`.env.example`), Tailwind CSS, Radix UI, Zustand.

- Pages: `src/app/<feature>`
- API routes: `src/app/api/<feature>/route.ts`
- Business logic: `src/lib/{services,auth,constants,utils,db}`
- Auth: bearer JWT, verified per-route via `src/lib/auth/rbac.ts` helpers (no NextAuth — one login type, no OAuth providers needed)

## Quick start

```bash
scripts/bootstrap.sh          # first run: installs Node if missing, scaffolds the app,
                               # installs all dependencies, creates+migrates+seeds the DB
scripts/bootstrap.sh --fresh   # same, but drops the existing DB and migration history first

npm run dev                    # http://localhost:3000 — pages and API routes, one process
```

## Seeded logins

`scripts/bootstrap.sh` seeds one user per role. Password for all of them: `Passw0rd!123` (dev only).

| Role | Email |
|---|---|
| SUPER_ADMIN | superadmin@zple.test |
| ADMIN | admin@zple.test |
| BRANCH_MANAGER | branchmanager@zple.test |
| CASHIER | cashier@zple.test |
| SALES | sales@zple.test |
| STORE_KEEPER | storekeeper@zple.test |
| AUDITOR | auditor@zple.test |

The company name/logo shown in the browser tab, navbar, and reports is set
separately per environment from **Settings** (SUPER_ADMIN/ADMIN only) — it's
database data, not something a deploy carries over.

## Environment variables

See `.env.example` at the repo root for the full documented list —
`bootstrap.sh` copies it to `.env` and generates real values for `JWT_SECRET`
and `WEBHOOK_SHARED_TOKEN`.

## Money

All amounts are stored and calculated in integer minor units (pesewas for
GHS) — never floats. Currency is configurable via `CURRENCY_CODE`.

## Testing

```bash
npm test        # vitest — calls Route Handlers directly, no server needed
npm run typecheck
```

64 tests across 9 suites, all passing — contract-type rules end to end,
payment idempotency/reversal/allocation, the price chart (including the
all-three-types bundle flow), USSD/Hubtel (mock mode), multi-phone customers
and Direct Debit, reports, and company settings.

## Testing Hubtel USSD without live credentials

`HUBTEL_PAYMENTS_MODE=mock` (the bootstrap default) enables a built-in
simulator so the full payment flow — including SMS on success — works without
real Hubtel credentials. Visit `/ussd-simulator` (linked in the sidebar) to
dial in as a customer, enter an amount, and confirm — it calls the same
`/api/ussd` endpoint a real Hubtel USSD gateway would.

## Deployment

`Dockerfile` builds a single production image; `.github/workflows/ci.yml`
runs the full check (typecheck/lint/test against a real Postgres service),
applies migrations against the production database, then publishes the image
to `ghcr.io/<owner>/hplite` tagged `:main` and `:<sha>`. Deployment itself is
pull-based and lives outside this repo: a box's own reconciler notices the
new `:main` digest and converges on its own — CI never holds server
credentials or touches a box directly.

## Status

Built, tested, and wired into the UI: Auth+RBAC (branch-scoped, 7 roles),
Customers (multi-phone, mobile-money verification), Products+Inventory+
stock-movements, a versioned Price Chart with all-three-contract-types bundle
pricing, all three Contract types with correct schedule generation and
type-specific business rules, the payment pipeline (idempotent, reversible,
penalty→instalment allocation, overpayment-as-credit), Hubtel Direct Debit
mandates plus a proactive daily collections run, SMS (log provider; Hubtel
provider implemented but untested against a live account), Hubtel USSD (mock
mode, session state machine, callback idempotency, stale-transaction
reconciliation via a cron job in `src/instrumentation.ts`), User and Branch
management UI, company Settings (name/logo/address shown in the tab title,
navbar, and on reports), all 12 reports + dashboard, and an audit trail. The
core flow — login → register customer → create a contract → record a cash
payment → pay via the USSD simulator → dashboard/daily-cash report — has been
driven end-to-end in a real headless Chrome session with zero console errors.

**Known gaps**: only the daily-cash report has a dedicated chart-style page —
the other 11 open through a generic authenticated JSON viewer
(`/reports/raw?path=...`) rather than a purpose-built page. Role→permission
mappings are fixed in code (`ROLE_PERMISSIONS` in `src/lib/constants/rbac.ts`,
re-synced via `db:seed`) — there's no UI or write API for editing them at
runtime, so `role.manage` as a permission exists but has nothing to gate yet.
No dedicated page yet for price-chart CSV import or receipt PDF printing
(both APIs exist and are usable via `curl`/Postman). `demo:seed` is still a
stub — seed realistic demo data manually via the UI or API for now. See
`docs/01-plan.md` §8 for the milestone order this was built against.
