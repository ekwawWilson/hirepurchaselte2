#!/usr/bin/env bash
# HP-Lite bootstrap script.
#
# HP-Lite is ONE fullstack Next.js app (pages + API routes + Prisma), not a
# separate backend/frontend split — matching the pattern of the other apps in
# this workspace (e.g. market-inventory). This script scaffolds it, installs
# every dependency, creates the database, runs migrations, and seeds RBAC +
# branch data. Idempotent: safe to re-run. Destructive DB reset only happens
# with --fresh.
#
# Usage: scripts/bootstrap.sh [--fresh]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR_WANTED=20
NODE_INSTALL_DIR="$HOME/.local/opt"
LOCAL_BIN="$HOME/.local/bin"
FRESH=false
SEED_PASSWORD="Passw0rd!123"

for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=true ;;
    -h|--help)
      echo "Usage: $0 [--fresh]"
      echo "  --fresh   Drop and recreate the local database before migrating/seeding."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

log()  { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git is required but was not found. Install git and re-run."

if command -v wget >/dev/null 2>&1; then
  DOWNLOADER=wget
elif command -v curl >/dev/null 2>&1; then
  DOWNLOADER=curl
else
  fail "Neither wget nor curl was found. Install one of them and re-run."
fi

mkdir -p "$LOCAL_BIN"
export PATH="$LOCAL_BIN:$PATH"

fetch() { # fetch <url> <dest>
  if [ "$DOWNLOADER" = wget ]; then
    wget -q -O "$2" "$1"
  else
    curl -fsSL -o "$2" "$1"
  fi
}

# ---------------------------------------------------------------------------
# 2. Node.js (installed locally under ~/.local, no sudo required)
# ---------------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge "$NODE_MAJOR_WANTED" ]
}

if node_ok; then
  log "Node $(node -v) already available on PATH, skipping install."
else
  log "Node.js ${NODE_MAJOR_WANTED}.x not found — installing locally under $NODE_INSTALL_DIR (no sudo)..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64|arm64) NODE_ARCH=arm64 ;;
    *) fail "Unsupported architecture for automatic Node.js install: $ARCH. Install Node ${NODE_MAJOR_WANTED}.x manually and re-run." ;;
  esac

  TMP_NODE="$(mktemp -d)"
  trap 'rm -rf "$TMP_NODE"' EXIT

  SHAFILE="$TMP_NODE/SHASUMS256.txt"
  fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR_WANTED}.x/SHASUMS256.txt" "$SHAFILE" \
    || fail "Could not reach nodejs.org to download Node.js. Check your network connection and re-run, or install Node ${NODE_MAJOR_WANTED}.x manually."

  TARBALL_NAME="$(grep "linux-${NODE_ARCH}.tar.xz" "$SHAFILE" | awk '{print $2}')"
  [ -n "$TARBALL_NAME" ] || fail "Could not resolve a Node.js ${NODE_MAJOR_WANTED}.x tarball for linux-${NODE_ARCH}."

  log "Downloading $TARBALL_NAME..."
  fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR_WANTED}.x/$TARBALL_NAME" "$TMP_NODE/$TARBALL_NAME"

  EXPECTED_SHA="$(grep " $TARBALL_NAME\$" "$SHAFILE" | awk '{print $1}')"
  ACTUAL_SHA="$(sha256sum "$TMP_NODE/$TARBALL_NAME" | awk '{print $1}')"
  [ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || fail "Downloaded Node.js tarball failed checksum verification."

  mkdir -p "$NODE_INSTALL_DIR"
  tar -xJf "$TMP_NODE/$TARBALL_NAME" -C "$NODE_INSTALL_DIR"
  NODE_DIR_NAME="${TARBALL_NAME%.tar.xz}"
  for bin in node npm npx; do
    ln -sf "$NODE_INSTALL_DIR/$NODE_DIR_NAME/bin/$bin" "$LOCAL_BIN/$bin"
  done

  rm -rf "$TMP_NODE"
  trap - EXIT

  node_ok || fail "Node.js install completed but 'node' is still not usable. Check $LOCAL_BIN is on your PATH."
  log "Installed Node $(node -v) -> $NODE_INSTALL_DIR/$NODE_DIR_NAME (symlinked into $LOCAL_BIN)"
  if ! grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null && ! grep -q '.local/bin' "$HOME/.profile" 2>/dev/null; then
    warn "Add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to your shell profile so new terminals can find node."
  else
    warn "New terminals will pick up node from ~/.local/bin automatically via your existing shell profile (open a fresh shell, or run: source ~/.profile)."
  fi
fi

npm config set fund false >/dev/null 2>&1 || true
npm config set audit false >/dev/null 2>&1 || true

gen_secret() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }

# ---------------------------------------------------------------------------
# 3. Next.js app scaffold (ONE fullstack app: pages + API routes + Prisma)
# ---------------------------------------------------------------------------
log "Creating project skeleton..."
mkdir -p "$ROOT_DIR"/docs "$ROOT_DIR"/scripts "$ROOT_DIR"/prisma "$ROOT_DIR"/tests
mkdir -p "$ROOT_DIR"/src/lib/{db,constants,auth,utils,services}
mkdir -p "$ROOT_DIR"/src/app/api

if [ ! -f "$ROOT_DIR/package.json" ]; then
  log "Scaffolding the Next.js app with create-next-app (this can take a minute)..."
  CI=1 npx --yes create-next-app@latest "$ROOT_DIR" \
    --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
  # create-next-app names the package after the target directory; rename it.
  node -e "const p='$ROOT_DIR/package.json'; const j=require(p); j.name='hp-lite'; require('fs').writeFileSync(p, JSON.stringify(j,null,2)+'\n');"
else
  log "package.json already exists, leaving the Next.js scaffold alone."
fi

log "Installing business-logic dependencies (Prisma, auth, forms, UI, testing)..."
(cd "$ROOT_DIR" && npm install --no-fund --no-audit \
  @prisma/client bcryptjs jsonwebtoken node-cron axios \
  zustand react-hook-form @hookform/resolvers zod date-fns lucide-react \
  class-variance-authority clsx tailwind-merge \
  @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-select \
  @radix-ui/react-tabs @radix-ui/react-toast @radix-ui/react-label \
  @radix-ui/react-checkbox @radix-ui/react-avatar @radix-ui/react-popover \
  @radix-ui/react-separator @radix-ui/react-alert-dialog @radix-ui/react-slot)

(cd "$ROOT_DIR" && npm install --no-fund --no-audit --save-dev \
  prisma tsx vitest supertest @types/supertest @types/jsonwebtoken dotenv)

# package.json scripts (idempotent: only add what's missing)
node -e "
const fs = require('fs');
const p = '$ROOT_DIR/package.json';
const j = require(p);
j.scripts = Object.assign({
  dev: 'next dev',
  build: 'next build',
  start: 'next start',
  lint: 'eslint',
  typecheck: 'tsc --noEmit',
  'db:migrate': 'prisma migrate dev',
  'db:generate': 'prisma generate',
  'db:seed': 'tsx prisma/seed.ts',
  'db:studio': 'prisma studio',
  'demo:seed': 'tsx prisma/demoSeed.ts',
  test: 'vitest run',
}, j.scripts);
j.prisma = { seed: 'tsx prisma/seed.ts' };
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"

if [ ! -f "$ROOT_DIR/.env.example" ]; then
  log "Writing .env.example..."
  cat > "$ROOT_DIR/.env.example" <<'ENV_EOF'
# HP-Lite is one fullstack Next.js app (pages + API routes) — one .env file for everything.

# --- Core -----------------------------------------------------------------
NODE_ENV=development
PORT=3000
# PostgreSQL — matches the legacy hirepurchase app's own database (docs/00-legacy-study.md
# §1). DIRECT_URL is a non-pooled connection used only for running migrations (a pooled/
# pgbouncer DATABASE_URL doesn't support the prepared statements migrations need).
DATABASE_URL="postgresql://user:password@localhost:5432/hplite?schema=public"
DIRECT_URL="postgresql://user:password@localhost:5432/hplite?schema=public"
JWT_SECRET=replace-with-a-generated-secret
JWT_EXPIRES_IN=7d
NEXT_PUBLIC_API_URL=http://localhost:3000/api
CURRENCY_CODE=GHS
BCRYPT_ROUNDS=10

# --- SMS (Hubtel SMS; LogSmsProvider used in dev regardless of these) ------
ENABLE_SMS_NOTIFICATIONS=false
SMS_PROVIDER=log
HUBTEL_SMS_CLIENT_ID=
HUBTEL_SMS_CLIENT_SECRET=
HUBTEL_SMS_SENDER_ID=HP-Lite
# SMS to staff (cashier/manager) on every payment, in addition to the customer. Off by default.
NOTIFY_STAFF_ON_PAYMENT=false

# --- Hubtel payments (USSD / receive-money) --------------------------------
# mock = built-in simulator, no live Hubtel credentials required
HUBTEL_PAYMENTS_MODE=mock
HUBTEL_POS_SALES_ID=
HUBTEL_API_KEY=
HUBTEL_API_SECRET=
HUBTEL_CALLBACK_URL=http://localhost:3000/api/payments/hubtel/callback
# Shared secret HP-Lite expects on incoming Hubtel callbacks (fails CLOSED if unset).
WEBHOOK_SHARED_TOKEN=replace-with-a-generated-secret
ENV_EOF
fi

if [ ! -f "$ROOT_DIR/.env" ]; then
  log "Generating .env from .env.example with fresh secrets..."
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  JWT_SECRET_VAL="$(gen_secret)"
  WEBHOOK_TOKEN_VAL="$(gen_secret)"
  sed -i.bak "s#^JWT_SECRET=.*#JWT_SECRET=${JWT_SECRET_VAL}#" "$ROOT_DIR/.env"
  sed -i.bak "s#^WEBHOOK_SHARED_TOKEN=.*#WEBHOOK_SHARED_TOKEN=${WEBHOOK_TOKEN_VAL}#" "$ROOT_DIR/.env"
  rm -f "$ROOT_DIR/.env.bak"
else
  log ".env already exists, leaving it alone."
fi

# ---------------------------------------------------------------------------
# 4. Prisma schema + seed
# ---------------------------------------------------------------------------
if [ ! -f "$ROOT_DIR/prisma/schema.prisma" ]; then
  log "Writing prisma/schema.prisma..."
  cat > "$ROOT_DIR/prisma/schema.prisma" <<'SCHEMA_EOF'
// HP-Lite data model.
// NOTE: this heredoc is a Phase-0 scaffolding snapshot (only ever written when
// prisma/schema.prisma doesn't exist yet) — it has not tracked every model/field
// added to the real schema.prisma since. Treat prisma/schema.prisma itself as
// the source of truth; this is only what a from-scratch bootstrap produces.
//
// PostgreSQL provider — matches the legacy hirepurchase app's own database
// (docs/00-legacy-study.md §1). Status/type fields stay plain String with
// app-level constants in src/lib/constants and a comment listing valid values
// (not native Postgres enums) — same convention the legacy app uses throughout.

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ---------------------------------------------------------------------------
// Branches / Auth / RBAC
// ---------------------------------------------------------------------------

model Branch {
  id        String   @id @default(cuid())
  name      String
  code      String   @unique
  address   String?
  phone     String?
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())

  users          User[]
  customers      Customer[]
  inventoryItems InventoryItem[]
  contracts      Contract[]

  @@map("branches")
}

model Role {
  id          String   @id @default(cuid())
  name        String   @unique
  description String?
  createdAt   DateTime @default(now())

  permissions Permission[]
  users       User[]

  @@map("roles")
}

model Permission {
  id          String  @id @default(cuid())
  name        String  @unique
  description String?

  roles Role[]

  @@map("permissions")
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  phone        String?
  passwordHash String
  firstName    String
  lastName     String
  roleId       String
  branchId     String?
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  role   Role    @relation(fields: [roleId], references: [id])
  branch Branch? @relation(fields: [branchId], references: [id])

  customersCreated  Customer[]        @relation("CustomerCreatedBy")
  customersUpdated  Customer[]        @relation("CustomerUpdatedBy")
  contractsCreated  Contract[]        @relation("ContractCreatedBy")
  contractsUpdated  Contract[]        @relation("ContractUpdatedBy")
  priceChartEntries PriceChartEntry[]
  stockMovements    StockMovement[]
  paymentsRecorded  Payment[]         @relation("PaymentCreatedBy")
  paymentsReversed  Payment[]         @relation("PaymentReversedBy")
  auditLogs         AuditLog[]

  @@map("users")
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

model Customer {
  id             String    @id @default(cuid())
  membershipId   String    @unique
  firstName      String
  lastName       String
  phone          String    @unique
  email          String?
  address        String?
  nationalId     String?
  dateOfBirth    DateTime?
  photoUrl       String?
  guarantorName  String?
  guarantorPhone String?
  branchId       String
  isActivated    Boolean   @default(false)
  createdById    String
  updatedById    String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  branch    Branch @relation(fields: [branchId], references: [id])
  createdBy User   @relation("CustomerCreatedBy", fields: [createdById], references: [id])
  updatedBy User?  @relation("CustomerUpdatedBy", fields: [updatedById], references: [id])

  contracts       Contract[]
  payments        Payment[]        @relation("PaymentInitiatedByCustomer")
  smsMessages     SmsMessage[]

  @@index([branchId])
  @@map("customers")
}

// ---------------------------------------------------------------------------
// Products & Inventory
// ---------------------------------------------------------------------------

model ProductCategory {
  id   String @id @default(cuid())
  name String @unique

  products Product[]

  @@map("product_categories")
}

model Product {
  id            String   @id @default(cuid())
  sku           String   @unique
  name          String
  description   String?
  categoryId    String?
  brand         String?
  model         String?
  cashPriceMinor Int
  imageUrl      String?
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())

  category         ProductCategory?   @relation(fields: [categoryId], references: [id])
  inventoryItems   InventoryItem[]
  priceChartEntries PriceChartEntry[]
  contracts        Contract[]

  @@map("products")
}

// status: AVAILABLE | RESERVED | ISSUED | RETURNED | WRITTEN_OFF
model InventoryItem {
  id           String   @id @default(cuid())
  productId    String
  branchId     String
  serialNumber String   @unique
  status       String   @default("AVAILABLE")
  createdAt    DateTime @default(now())

  product Product @relation(fields: [productId], references: [id])
  branch  Branch  @relation(fields: [branchId], references: [id])

  stockMovements StockMovement[]
  contract       Contract?

  @@index([productId, branchId, status])
  @@map("inventory_items")
}

// type: RECEIPT | RESERVE | ISSUE | RETURN | TRANSFER | ADJUSTMENT
model StockMovement {
  id              String   @id @default(cuid())
  inventoryItemId String
  productId       String
  branchId        String
  type            String
  fromBranchId    String?
  toBranchId      String?
  referenceType   String?
  referenceId     String?
  reason          String?
  createdById     String
  createdAt       DateTime @default(now())

  inventoryItem InventoryItem @relation(fields: [inventoryItemId], references: [id])
  createdBy     User          @relation(fields: [createdById], references: [id])

  @@index([inventoryItemId])
  @@index([branchId, type])
  @@map("stock_movements")
}

// ---------------------------------------------------------------------------
// Price chart
// ---------------------------------------------------------------------------

// contractType: SAVE_TO_OWN | DEPOSIT_INSTALMENT | DEVICE_LOAN
model PriceChartEntry {
  id                   String    @id @default(cuid())
  productId            String
  contractType         String
  termMonths           Int
  depositPercentage    Int       @default(0)
  totalPayableMinor    Int
  instalmentAmountMinor Int
  interestRateBps      Int?
  effectiveFrom        DateTime  @default(now())
  effectiveTo          DateTime?
  createdById          String
  createdAt            DateTime  @default(now())

  product   Product @relation(fields: [productId], references: [id])
  createdBy User    @relation(fields: [createdById], references: [id])

  contracts Contract[]

  @@index([productId, contractType, termMonths])
  @@map("price_chart_entries")
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

// contractType: SAVE_TO_OWN | DEPOSIT_INSTALMENT | DEVICE_LOAN
// status (union across types, see docs/01-plan.md §5):
//   SAVE_TO_OWN:         ACTIVE | COMPLETED | RELEASED | CANCELLED
//   DEPOSIT_INSTALMENT:  PENDING_DEPOSIT | ACTIVE | COMPLETED | DEFAULTED | CANCELLED
//   DEVICE_LOAN:         ACTIVE | COMPLETED | DEFAULTED | WRITTEN_OFF
model Contract {
  id               String    @id @default(cuid())
  contractNumber   String    @unique
  contractType     String
  customerId       String
  productId        String
  inventoryItemId  String?   @unique
  branchId         String
  priceChartEntryId String?

  // Snapshotted pricing terms — never re-read from priceChartEntries after creation.
  totalPriceMinor       Int
  depositAmountMinor    Int      @default(0)
  depositPercentage     Int      @default(0)
  termMonths             Int
  paymentFrequency       String   @default("MONTHLY")
  instalmentAmountMinor  Int

  // DEVICE_LOAN only
  principalMinor   Int?
  interestRateBps  Int?
  rateBasis        String?  @default("FLAT")

  status String @default("ACTIVE")

  totalPayableMinor Int
  totalPaidMinor    Int @default(0)
  balanceMinor      Int

  startDate     DateTime
  activatedAt   DateTime?
  completedAt   DateTime?
  releasedAt    DateTime?
  cancelledAt   DateTime?
  defaultedAt   DateTime?
  writtenOffAt  DateTime?
  cancelReason  String?
  writeOffReason String?

  createdById String
  updatedById String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  customer        Customer         @relation(fields: [customerId], references: [id])
  product         Product          @relation(fields: [productId], references: [id])
  inventoryItem   InventoryItem?   @relation(fields: [inventoryItemId], references: [id])
  branch          Branch           @relation(fields: [branchId], references: [id])
  priceChartEntry PriceChartEntry? @relation(fields: [priceChartEntryId], references: [id])
  createdBy       User             @relation("ContractCreatedBy", fields: [createdById], references: [id])
  updatedBy       User?            @relation("ContractUpdatedBy", fields: [updatedById], references: [id])

  instalments        Instalment[]
  payments           Payment[]
  penalties          Penalty[]
  hubtelTransactions HubtelTransaction[]
  ussdSessions       UssdSession[]
  smsMessages        SmsMessage[]

  @@index([status, createdAt])
  @@index([customerId, status])
  @@index([branchId, status])
  @@map("contracts")
}

// status: PENDING | PARTIAL | PAID | OVERDUE
model Instalment {
  id                    String    @id @default(cuid())
  contractId            String
  instalmentNo          Int
  dueDate               DateTime
  amountDueMinor        Int
  principalPortionMinor Int       @default(0)
  interestPortionMinor  Int       @default(0)
  amountPaidMinor       Int       @default(0)
  status                String    @default("PENDING")
  paidAt                DateTime?

  contract    Contract              @relation(fields: [contractId], references: [id])
  allocations PaymentAllocation[]
  penalties   Penalty[]

  @@unique([contractId, instalmentNo])
  @@index([contractId, status])
  @@map("instalments")
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

// entryType: DEPOSIT | INSTALMENT_PAYMENT | CREDIT
// channel: CASH | USSD
// status: PENDING | SUCCESS | FAILED
model Payment {
  id                    String    @id @default(cuid())
  contractId            String
  entryType             String
  amountMinor           Int
  channel               String
  mobileMoneyNetwork    String?
  transactionRef        String    @unique
  externalRef           String?
  status                String    @default("PENDING")
  receiptNumber         String?
  notes                 String?
  rawGatewayPayload     String?
  createdById           String?
  initiatedByCustomerId String?
  reversesPaymentId     String?   @unique
  reversalReason        String?
  reversedById          String?
  receivedAt            DateTime?
  createdAt             DateTime  @default(now())

  contract              Contract  @relation(fields: [contractId], references: [id])
  createdBy             User?     @relation("PaymentCreatedBy", fields: [createdById], references: [id])
  reversedBy            User?     @relation("PaymentReversedBy", fields: [reversedById], references: [id])
  initiatedByCustomer   Customer? @relation("PaymentInitiatedByCustomer", fields: [initiatedByCustomerId], references: [id])
  reverses              Payment?  @relation("PaymentReversal", fields: [reversesPaymentId], references: [id])
  reversedByPayment     Payment?  @relation("PaymentReversal")

  allocations        PaymentAllocation[]
  hubtelTransaction  HubtelTransaction?
  smsMessages        SmsMessage[]

  @@index([contractId, status])
  @@map("payments")
}

// targetType: PENALTY | INSTALMENT
model PaymentAllocation {
  id           String  @id @default(cuid())
  paymentId    String
  targetType   String
  instalmentId String?
  penaltyId    String?
  amountMinor  Int

  payment    Payment     @relation(fields: [paymentId], references: [id])
  instalment Instalment? @relation(fields: [instalmentId], references: [id])
  penalty    Penalty?    @relation(fields: [penaltyId], references: [id])

  @@map("payment_allocations")
}

model Penalty {
  id           String    @id @default(cuid())
  contractId   String
  instalmentId String?
  amountMinor  Int
  reason       String
  appliedDate  DateTime  @default(now())
  isPaid       Boolean   @default(false)
  paidAt       DateTime?

  contract    Contract            @relation(fields: [contractId], references: [id])
  instalment  Instalment?         @relation(fields: [instalmentId], references: [id])
  allocations PaymentAllocation[]

  @@map("penalties")
}

// ---------------------------------------------------------------------------
// Hubtel USSD payments
// ---------------------------------------------------------------------------

// status: PENDING | SUCCESS | FAILED
model HubtelTransaction {
  id                 String   @id @default(cuid())
  clientReference    String   @unique
  contractId         String
  msisdn             String
  amountMinor        Int
  status             String   @default("PENDING")
  rawCallbackPayload String?
  paymentId          String?  @unique
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  contract Contract @relation(fields: [contractId], references: [id])
  payment  Payment? @relation(fields: [paymentId], references: [id])

  @@map("hubtel_transactions")
}

// msisdn is deliberately NOT a foreign key to Customer.phone — a USSD session
// can start from a number that isn't a registered customer yet (that's what
// the lookup step in the menu is for).
model UssdSession {
  id         String   @id @default(cuid())
  sessionId  String   @unique
  msisdn     String
  state      String
  contractId String?
  context    String?
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  contract Contract? @relation(fields: [contractId], references: [id])

  @@map("ussd_sessions")
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

model SmsTemplate {
  id           String  @id @default(cuid())
  key          String  @unique
  name         String
  bodyTemplate String
  isActive     Boolean @default(true)

  @@map("sms_templates")
}

// status: QUEUED | SENT | FAILED
model SmsMessage {
  id                String    @id @default(cuid())
  recipient         String
  templateKey       String
  body              String
  relatedPaymentId  String?
  relatedContractId String?
  relatedCustomerId String?
  status            String    @default("QUEUED")
  providerRef       String?
  attempts          Int       @default(0)
  lastAttemptAt     DateTime?
  createdAt         DateTime  @default(now())

  relatedPayment  Payment?  @relation(fields: [relatedPaymentId], references: [id])
  relatedContract Contract? @relation(fields: [relatedContractId], references: [id])
  relatedCustomer Customer? @relation(fields: [relatedCustomerId], references: [id])

  @@map("sms_messages")
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

model AuditLog {
  id         String   @id @default(cuid())
  userId     String?
  action     String
  entityType String
  entityId   String?
  oldValues  String?
  newValues  String?
  ipAddress  String?
  createdAt  DateTime @default(now())

  user User? @relation(fields: [userId], references: [id])

  @@index([entityType, entityId])
  @@map("audit_logs")
}
SCHEMA_EOF
else
  log "prisma/schema.prisma already exists, leaving it alone."
fi

if [ ! -f "$ROOT_DIR/prisma/seed.ts" ]; then
  log "Writing prisma/seed.ts..."
  cat > "$ROOT_DIR/prisma/seed.ts" <<'SEED_TS_EOF'
/**
 * Seeds the baseline reference data HP-Lite needs to log in and enforce RBAC:
 * one branch, the full permission catalog, the seven roles from docs/01-plan.md §7,
 * and one demo user per role. Idempotent — safe to re-run (upserts throughout).
 *
 * Business demo data (products, price chart, customers, contracts) lives in
 * demoSeed.ts instead, since it depends on modules built after this one.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLE_PERMISSIONS, DEMO_USERS, SEED_PASSWORD, BRANCH_SCOPED_ROLES } from '../src/lib/constants/rbac';

const prisma = new PrismaClient();

async function main() {
  const branch = await prisma.branch.upsert({
    where: { code: 'MAIN' },
    update: {},
    create: { name: 'Main Branch', code: 'MAIN', address: 'Head Office' },
  });

  for (const name of PERMISSIONS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name } });
  }

  for (const [roleName, perms] of Object.entries(ROLE_PERMISSIONS)) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: { permissions: { set: perms.map((name) => ({ name })) } },
      create: {
        name: roleName,
        permissions: { connect: perms.map((name) => ({ name })) },
      },
    });
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  for (const u of DEMO_USERS) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        roleId: role.id,
        branchId: BRANCH_SCOPED_ROLES.includes(u.role) ? branch.id : null,
      },
    });
  }

  const smsTemplates = [
    {
      key: 'payment.success',
      name: 'Payment received',
      bodyTemplate:
        'Hi {{customerName}}, we received your payment of {{currency}} {{amountPaid}} for contract {{contractNumber}}. ' +
        'Outstanding balance: {{currency}} {{outstandingBalance}}. Next due: {{currency}} {{nextDueAmount}} on {{nextDueDate}}.',
    },
    {
      key: 'contract.activated',
      name: 'Contract activated / welcome',
      bodyTemplate:
        'Hi {{customerName}}, your contract {{contractNumber}} is now active. ' +
        'Outstanding balance: {{currency}} {{outstandingBalance}}. Next payment of {{currency}} {{nextDueAmount}} is due {{nextDueDate}}.',
    },
  ];
  for (const t of smsTemplates) {
    await prisma.smsTemplate.upsert({ where: { key: t.key }, update: {}, create: t });
  }

  console.log('\nSeeded roles, permissions, branch, demo users, and SMS templates.');
  console.log(`Demo login password for every seeded user: ${SEED_PASSWORD}\n`);
  for (const u of DEMO_USERS) {
    console.log(`  ${u.role.padEnd(15)} ${u.email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
SEED_TS_EOF
else
  log "prisma/seed.ts already exists, leaving it alone."
fi

if [ ! -f "$ROOT_DIR/prisma/demoSeed.ts" ]; then
  log "Writing prisma/demoSeed.ts placeholder..."
  cat > "$ROOT_DIR/prisma/demoSeed.ts" <<'DEMO_SEED_EOF'
/**
 * Business demo data (products, price chart, customers, one contract of each
 * type). Deliberately left as a stub by bootstrap.sh: it depends on the
 * Products, Price Chart, and Contracts modules, which are built after the
 * initial scaffold. Run `npm run demo:seed` once those modules exist.
 */
async function main() {
  console.log('demo:seed is not implemented yet — build the Products/Price Chart/Contracts modules first.');
}

main();
DEMO_SEED_EOF
fi

log "Generating Prisma client..."
(cd "$ROOT_DIR" && npx prisma generate)

if [ "$FRESH" = true ]; then
  warn "--fresh passed: removing existing database and migration history..."
  rm -f "$ROOT_DIR/prisma/dev.db" "$ROOT_DIR/prisma/dev.db-journal"
  rm -rf "$ROOT_DIR/prisma/migrations"
fi

if [ ! -d "$ROOT_DIR/prisma/migrations" ]; then
  log "Running initial database migration..."
  (cd "$ROOT_DIR" && npx prisma migrate dev --name init)
else
  log "Migrations already exist, applying any pending ones..."
  (cd "$ROOT_DIR" && npx prisma migrate deploy)
fi

log "Seeding RBAC + branch + demo users..."
(cd "$ROOT_DIR" && npm run db:seed)

# ---------------------------------------------------------------------------
# 5. Root-level files
# ---------------------------------------------------------------------------
if [ ! -f "$ROOT_DIR/.gitignore" ] || ! grep -q '\*.db' "$ROOT_DIR/.gitignore" 2>/dev/null; then
  log "Writing .gitignore..."
  cat > "$ROOT_DIR/.gitignore" <<'GITIGNORE_EOF'
node_modules/
.next/
*.db
*.db-journal
.env
!.env.example
*.log
.DS_Store
*.tsbuildinfo
next-env.d.ts
GITIGNORE_EOF
fi

if [ ! -d "$ROOT_DIR/.git" ]; then
  log "Initializing git repository..."
  (cd "$ROOT_DIR" && git init -q)
fi

# ---------------------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------------------
echo
log "Bootstrap complete."
echo
echo "  Dev server (pages + API routes, one process): npm run dev -> http://localhost:3000"
echo "  Prisma Studio (browse the DB): npm run db:studio"
echo "  Tests: npm test"
echo
echo "  Seeded logins (password for all: $SEED_PASSWORD):"
echo "    superadmin@zple.test   (SUPER_ADMIN)"
echo "    admin@zple.test        (ADMIN)"
echo "    branchmanager@zple.test (BRANCH_MANAGER)"
echo "    cashier@zple.test      (CASHIER)"
echo "    sales@zple.test        (SALES)"
echo "    storekeeper@zple.test  (STORE_KEEPER)"
echo "    auditor@zple.test      (AUDITOR)"
echo
echo "  Re-run this script any time — it's idempotent. Use --fresh to reset the database."
echo
