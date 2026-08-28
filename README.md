# HP-Lite

A simplified, self-contained hire-purchase system: three contract types
(save-to-own, deposit+instalment, device loan), cash and Hubtel USSD payments,
SMS notifications, inventory, a price chart, RBAC, and daily reports.

One fullstack Next.js app — pages and API routes together, no separate
backend service — following the pattern of this workspace's other apps (e.g.
`market-inventory`).

Background and design decisions: `docs/00-legacy-study.md` (what this rebuilds
from), `docs/01-plan.md` (schema/modules/milestones — see §1 for the
mid-build architecture revision to a single Next.js app), `docs/02-loan-maths.md`
(Type C interest worked example), `docs/03-api.md` (endpoint reference, added
as the API is built).

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
| SUPER_ADMIN | superadmin@hplite.test |
| ADMIN | admin@hplite.test |
| BRANCH_MANAGER | branchmanager@hplite.test |
| CASHIER | cashier@hplite.test |
| SALES | sales@hplite.test |
| STORE_KEEPER | storekeeper@hplite.test |
| AUDITOR | auditor@hplite.test |

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

## Testing Hubtel USSD without live credentials

`HUBTEL_PAYMENTS_MODE=mock` (the bootstrap default) enables a built-in
simulator so the full payment flow — including SMS on success — works without
real Hubtel credentials. Visit `/ussd-simulator` (linked in the sidebar) to
dial in as a customer, enter an amount, and confirm — it calls the same
`/api/ussd` endpoint a real Hubtel USSD gateway would.

## Status

Built, tested, and wired into the UI: Auth+RBAC (branch-scoped, 7 roles),
Customers, Products+Inventory+stock-movements, Price Chart (versioned), all
three Contract types with correct schedule generation, the payment pipeline
(idempotent, reversible, penalty→instalment allocation, overpayment-as-credit),
SMS (log provider; Hubtel provider implemented but untested against a live
account), Hubtel USSD (mock mode, session state machine, callback idempotency,
stale-transaction reconciliation via a cron job in `src/instrumentation.ts`),
all 12 reports + dashboard, and an audit trail. 37 automated tests across 3
suites (`npm test`), all passing; the core flow (login → register customer →
create a contract → record a cash payment → pay via the USSD simulator →
dashboard/daily-cash report) has been driven end-to-end in a real headless
Chrome session with zero console errors.

**Known gaps**: only the daily-cash report has a dedicated chart-style page —
the other 11 open through a generic authenticated JSON viewer
(`/reports/raw?path=...`) rather than a purpose-built page. No dedicated pages
yet for user/role management, receipt printing, or price-chart CSV import (the
API for all three exists and is usable via `curl`/Postman). `demo:seed` is
still a stub — seed realistic demo data manually via the UI or API for now.
See `docs/01-plan.md` §8 for the milestone order this was built against.
