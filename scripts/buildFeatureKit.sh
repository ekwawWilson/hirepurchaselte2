#!/usr/bin/env bash
# Builds one self-contained installer that carries the temporary unlock and
# agent short code deposit features into a similar project (same Next.js +
# Prisma shape, with the PayTrigger, Hubtel, USSD and agent ledger modules).
#
# New files go in whole, as they are now; changes to shared files go in as
# the patches of the commits that made them, so a project that has drifted
# gets everything that still fits and a list of what to merge by hand.
#
# Usage: scripts/buildFeatureKit.sh [output-file]
#   Then copy the output to the other project's root and run it there; it
#   explains itself with --help.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT_DIR/dist/install-temporary-unlock-and-agent-deposit.sh}"
# Each feature's commits, in the order they have to go in.
FEATURES=("temporary-unlock:9613829 581ca70" "agent-deposit:4debba1")

KIT="$(mktemp -d)"
trap 'rm -rf "$KIT"' EXIT
cd "$ROOT_DIR"

patch_no=0
for entry in "${FEATURES[@]}"; do
  feature="${entry%%:*}"
  for sha in ${entry#*:}; do
    while IFS=$'\t' read -r status path; do
      case "$status:$path" in
        A:prisma/migrations/*)
          folder="$(basename "$(dirname "$path")")"
          mkdir -p "$KIT/$feature/migrations/${folder#*_}"
          git show "HEAD:$path" > "$KIT/$feature/migrations/${folder#*_}/migration.sql"
          ;;
        A:*)
          mkdir -p "$KIT/$feature/files/$(dirname "$path")"
          git show "HEAD:$path" > "$KIT/$feature/files/$path"
          ;;
        M:*)
          patch_no=$((patch_no + 1))
          mkdir -p "$KIT/$feature/patches"
          git diff "$sha^" "$sha" -- "$path" > "$KIT/$feature/patches/$(printf '%03d' "$patch_no").patch"
          ;;
      esac
    done < <(git show --name-status --format= "$sha")
  done
done

# The kit is meant to leave this project, so nothing from .env may be in it.
if [ -f .env ]; then
  while IFS='=' read -r name value; do
    value="${value%\"}"; value="${value#\"}"
    if [[ "$name" =~ (KEY|SECRET|TOKEN|PASSWORD) ]] && [ "${#value}" -ge 8 ] && grep -rqF -- "$value" "$KIT"; then
      echo "Stopped: the kit contains the value of $name." >&2
      exit 1
    fi
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env)
fi

cat > "$KIT/GUIDE.md" <<'GUIDE'
# Temporary unlock and agent deposits

For developers adding these two features to a project built like HP-Lite.
Installed by `install-temporary-unlock-and-agent-deposit.sh`.

## What the project must already have

| Feature | Needs |
| --- | --- |
| Temporary unlock | PayTrigger Device Financing (`src/lib/paytrigger`: decide, reconcile, settings, notify), the agent ledger, payments, Hubtel, the USSD menu |
| Agent deposits | The agent ledger (`AgentDepositLedger`, `AgentRemittance`), Hubtel, the USSD menu with its checkout service, an `AGENT` role |

The migrations assume these table names: `users`, `roles`, `paytrigger_settings`.

Install both together if you can. Agent deposits on their own leave `hubtelPaymentService.ts` and `ussdService.ts` to merge by hand, because those changes build on temporary unlock's.

## After installing

1. Merge anything the installer listed: each file has a `.rej` beside it holding the parts that did not fit.
2. Run `npx prisma generate`, `npx prisma migrate deploy`, `npx tsc --noEmit` and the tests. The kit's own tests are `tests/temporary-unlock.test.ts` and `tests/agent-ussd-deposit.test.ts`.
3. Search for what is specific to the original project: the `GHS` currency on screens and in texts, the mobile app's name and package.
4. Turn on temporary unlock in Settings > PayTrigger. It is off by default. Agent deposits work as soon as they are deployed.

The kit is a snapshot: the new files as they were when it was built, and the shared-file changes as first committed.

## Temporary unlock

A customer whose financed phone has locked pays a share of what is overdue and the phone opens for a set time. When the time is up it locks again unless all that is overdue has been paid.

**Rules**

- Settings hold 4 to 6 tiers, each taking a higher percentage and opening for longer than the last. The defaults are 25% for 24 hours, 50% for 72, 75% for 120 and 90% for 168.
- A setting caps how many times it can be used (default 2). After that, the full overdue amount is needed.
- Overdue means instalments. Late charges never keep a phone locked.
- Defaulted contracts can use it.
- An agent deposit that has not been paid in still keeps the phone shut.
- It can be bought on the short code, in the customer app, or with cash through office staff. Agents cannot sell it.
- The phone opens only once the money has come in. A reversed payment takes its unlock with it.

**How it works**

Only the lock date moves (`decide.ts`, using the window from `temporaryUnlock.ts`), so the phone locks itself at the end of the window, online or offline. PayTrigger's own temporary unlock API is not used, because PayTrigger has to activate it per account (error 50011).

The tier is recorded against the charge's reference before the charge exists, so a payment that settles at once still finds it. `applyTemporaryUnlock` runs from the successful payment path.

The optional button on the lock screen needs the customer app on the phones, the setting switched on, and the app whitelisted in the PayTrigger portal.

## Agent deposits on the short code

An agent pays in the customers' cash they hold, by mobile money from any phone. The main menu shows `3. Agent deposits` to every caller; the agent's payment PIN gets them past it.

**The flow**

Dial, choose 3, enter the PIN. One sale goes straight to the amount, which can be part of what is owed. Several sales show a list with Pay all (oldest first) or one customer. Confirm, then approve the mobile money prompt.

**Rules**

- The ledger is credited when the money arrives, with no one confirming it. The charge is the proof.
- It is not a customer payment: no `Payment` row is written, so daily cash is not counted twice.
- A phone held for that sale's deposit can open once it is paid in.
- A failed charge credits nothing and the amount can be paid again. A success arriving late still lands, once.
- Closed days refuse it, as they do customer payments.
- The receipt text goes to the agent's number on record, otherwise to the phone that paid.

**The PIN**

- Six digits, unique to the agent. It is how the agent is identified, because anyone can dial the short code.
- Issued when an agent is created or moved into the role. The migration gives existing agents theirs, and the dashboard issues one if an agent somehow has none.
- It is shown on the agent's dashboard, so it is stored readable in `users.paymentPin`.
- Five wrong PINs from a phone within an hour stops that phone for an hour (`agent_pin_failures`).

**Check this in your project:** any query that sends a whole `User` record to the browser, such as `include: { createdBy: true }`, now sends the PIN too. Select only the fields needed. The original project's reports had this problem, and the fix is among the patches.

**How it works**

Charges use the `AGENT_DEPOSIT` channel on `HubtelTransaction`. `openUssdRemittance` records what the charge is for before it is made, as `AgentRemittance` rows with status `AWAITING_PAYMENT`, then `settleUssdRemittance` or `failUssdRemittance` ends them. The status column is a plain string. Rows are claimed one at a time, so a callback and the reconcile sweep cannot both credit the same one. A charge that matches no rows goes to `NEEDS_REVIEW`.
GUIDE

cat > "$KIT/header.sh" <<'INSTALLER'
#!/usr/bin/env bash
# Installs the temporary unlock and agent short code deposit features into
# this project. Built by scripts/buildFeatureKit.sh in the original project.
# It changes only the working tree and never commits. Everything is explained
# in the guide it adds at docs/temporary-unlock-and-agent-deposit.md.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install-temporary-unlock-and-agent-deposit.sh [--only FEATURE] [--dry-run]

Run from anywhere inside the project's git repository.

  --only FEATURE  Install one feature: temporary-unlock or agent-deposit.
                  The default installs both, in that order.
  --dry-run       Try it on a throwaway copy and report what would happen.

Exit status: 0 installed, 1 stopped before changing anything, 2 installed
with parts to merge by hand (each listed, with a .rej file beside it).
USAGE
}

die() { echo "Stopped: $*" >&2; exit 1; }

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
FEATURES="temporary-unlock agent-deposit"
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      case "${2:-}" in temporary-unlock|agent-deposit) FEATURES="$2" ;; *) die "--only takes temporary-unlock or agent-deposit" ;; esac
      shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 1 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this inside the project's git repository"
cd "$ROOT"
[ -f prisma/schema.prisma ] || die "no prisma/schema.prisma here: this does not look like a similar project"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "commit or stash your changes first, so this install can be undone"

for feature in $FEATURES; do
  case "$feature" in
    temporary-unlock) needed="src/lib/paytrigger/decide.ts src/lib/paytrigger/reconcile.ts src/lib/paytrigger/settings.ts src/lib/services/agentLedgerService.ts src/lib/services/hubtelPaymentService.ts src/lib/services/ussdService.ts" ;;
    agent-deposit) needed="src/lib/services/agentLedgerService.ts src/lib/services/hubtelPaymentService.ts src/lib/services/ussdCheckoutService.ts src/lib/services/ussdService.ts" ;;
  esac
  for path in $needed; do
    [ -f "$path" ] || die "$feature needs $path, which this project does not have (see the guide's first section)"
  done
done
grep -q '^model AgentDepositLedger ' prisma/schema.prisma || die "the agent ledger (model AgentDepositLedger) is not in this project's schema"

TEMP="$(mktemp -d)"
WORKTREE=""
cleanup() {
  [ -z "$WORKTREE" ] || git -C "$ROOT" worktree remove --force "$WORKTREE"
  rm -rf "$TEMP"
}
trap cleanup EXIT

KIT="$TEMP/kit"
mkdir "$KIT"
sed -n '/^__PAYLOAD__$/,$p' "$SELF" | tail -n +2 | base64 -d | tar xz -C "$KIT"

if $DRY_RUN; then
  echo "Dry run: working on a throwaway copy."
  WORKTREE="$TEMP/copy"
  git worktree add --quiet --detach "$WORKTREE" HEAD
  cd "$WORKTREE"
fi

# The customer app's part goes in only if this project has one.
skipped_app() { [[ "$1" == mobile/* && ! -d mobile ]]; }

added=0; patched=0; existing=(); by_hand=()
stamp="$(date -u +%Y%m%d%H%M)"
migration_no=0

for feature in $FEATURES; do
  echo "== $feature"
  if [ -d "$KIT/$feature/files" ]; then
    while IFS= read -r file; do
      path="${file#"$KIT/$feature/files/"}"
      skipped_app "$path" && continue
      if [ -e "$path" ]; then existing+=("$path"); continue; fi
      mkdir -p "$(dirname "$path")"
      cp "$file" "$path"
      added=$((added + 1))
    done < <(find "$KIT/$feature/files" -type f | sort)
  fi

  for folder in "$KIT/$feature"/migrations/*/; do
    name="$(basename "$folder")"
    # Named for now, so it runs after this project's own migrations.
    target="prisma/migrations/${stamp}$(printf '%02d' "$migration_no")_$name"
    migration_no=$((migration_no + 1))
    mkdir -p "$target"
    cp "$folder/migration.sql" "$target/migration.sql"
    echo "   migration: $target"
  done

  for patch_file in "$KIT/$feature"/patches/*.patch; do
    path="$(sed -n 's#^+++ b/##p' "$patch_file" | head -1)"
    skipped_app "$path" && continue
    if [ ! -f "$path" ]; then by_hand+=("$path (not in this project)"); continue; fi
    if git apply --reject --whitespace=nowarn "$patch_file" 2>/dev/null; then
      patched=$((patched + 1))
    else
      by_hand+=("$path (see $path.rej)")
    fi
  done
done

mkdir -p docs
cp "$KIT/GUIDE.md" docs/temporary-unlock-and-agent-deposit.md

echo
echo "New files added: $added. Shared files changed cleanly: $patched."
if [ ${#existing[@]} -gt 0 ]; then
  echo "Already in this project, left as they were:"
  printf '  %s\n' "${existing[@]}"
fi
if [ ${#by_hand[@]} -gt 0 ]; then
  echo "To merge by hand:"
  printf '  %s\n' "${by_hand[@]}"
fi
$DRY_RUN && echo "Dry run: nothing in your project was changed."
echo "Next: follow docs/temporary-unlock-and-agent-deposit.md (After installing)."
[ ${#by_hand[@]} -eq 0 ] || exit 2
exit 0
INSTALLER

mkdir -p "$(dirname "$OUTPUT")"
{
  cat "$KIT/header.sh"
  echo '__PAYLOAD__'
  tar czf - -C "$KIT" temporary-unlock agent-deposit GUIDE.md | base64
} > "$OUTPUT"
chmod +x "$OUTPUT"
echo "Built $OUTPUT"
