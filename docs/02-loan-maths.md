# 02 — Loan Maths (Type C: `DEVICE_LOAN`)

Per `docs/00-legacy-study.md` §5, the legacy system has **no interest calculation anywhere** — every contract it supports is a straight-line, interest-free split of `(totalPrice − deposit)` across N instalments. There is no precedent to "match the legacy app's actual behaviour" for Type C, so this doc defines HP-Lite's own choice and the reasoning behind it, per the mission's fallback instruction ("implement per the legacy app's actual behaviour and document the choice... with a worked example" — there being no legacy behaviour, the choice is HP-Lite's own).

---

## 1. Structure chosen: flat-rate, interest spread evenly across every instalment

Not an interest-only phase followed by a principal phase, and not interest front-loaded into the first few instalments. Every instalment carries the same proportional split of interest and principal for the life of the loan. Reasoning:

- **Auditability**: a customer (or a support agent) can explain "each of your 12 payments is GHS 40 interest + GHS 166.67 principal" far more simply than a two-phase or front-loaded structure.
- **Consistency with the allocation order** (mission §5/§8.3: penalties/fees → interest → principal): allocation operates *within* a single instalment when a payment is partial. A flat, evenly-spread structure means "pay this instalment's interest before its principal" is well-defined for every instalment, not just a subset during an interest-only phase.
- **Consistency with the legacy rounding rule** kept for Types A/B (study doc §5: round each instalment up to the cent, final instalment absorbs the exact remainder) — that rule extends cleanly to a flat-rate loan by applying it independently to the principal component and the interest component of each instalment.
- **`rate_basis` stays an explicit column** (`FLAT` today) behind an `InterestCalculator` interface, so a reducing-balance implementation can be added later without changing callers — satisfies mission §15.2's "implement flat first, leave the interface open."

## 2. Formulas

```
total_interest   = principal × annual_rate × (term_months / 12)
total_payable    = principal + total_interest
instalment_count = term_months  (one instalment per month; other frequencies scale accordingly)

per_instalment_interest_raw  = total_interest / instalment_count
per_instalment_principal_raw = principal / instalment_count

for i in 1..instalment_count:
  if i < instalment_count:
    interest_portion  = ceil_to_cent(per_instalment_interest_raw)
    principal_portion = ceil_to_cent(per_instalment_principal_raw)
  else:  # final instalment absorbs both remainders
    interest_portion  = total_interest  − sum(interest_portion  for i=1..N-1)
    principal_portion = principal       − sum(principal_portion for i=1..N-1)

  amount_due = interest_portion + principal_portion
```

`ceil_to_cent(x) = Math.ceil(x * 100) / 100`, applied in minor units in actual code (`Math.ceil(x)` directly on integer pesewas — no float division survives past the raw/N step). `annual_rate` is stored as basis points (`interest_rate_bps`, e.g. `2400` = 24%/yr) to avoid float rates in the schema.

**Down payment**: Type C has no mandatory deposit gate (plan doc §5, resolving mission ambiguity §15.3), but the price chart may still define an optional down payment for a given product/term. If present, `principal_minor = total_price_minor − down_payment_minor`; if absent, `principal_minor = total_price_minor` (the full price is financed). Either way, the device is released unconditionally at disbursement — the down payment (if any) only affects the principal base, not release timing.

## 3. Worked example

Product cash price: **GHS 2,000.00** (200,000 pesewas). Term: **12 months**. Annual flat rate: **24%** (`interest_rate_bps = 2400`). No down payment — full price financed.

```
principal        = 200,000 pesewas   (GHS 2,000.00)
total_interest    = 200,000 × 0.24 × (12/12) = 48,000 pesewas   (GHS 480.00)
total_payable     = 248,000 pesewas   (GHS 2,480.00)

per-instalment interest (raw)  = 48,000 / 12 = 4,000.00 → ceil to cent = 4,000 pesewas  (GHS 40.00)
per-instalment principal (raw) = 200,000 / 12 = 16,666.67 → ceil to cent = 16,667 pesewas (GHS 166.67)

Instalments 1–11: amount_due = 4,000 + 16,667 = 20,667 pesewas (GHS 206.67) each
  sum(interest, 1–11)  = 44,000 pesewas
  sum(principal, 1–11) = 183,337 pesewas

Instalment 12 (absorbs remainder):
  interest_portion  = 48,000 − 44,000  = 4,000 pesewas   (GHS 40.00)
  principal_portion = 200,000 − 183,337 = 16,663 pesewas  (GHS 166.63)
  amount_due = 20,663 pesewas (GHS 206.63)

Check: sum(all amount_due) = 11 × 20,667 + 20,663 = 227,337 + 20,663 = 248,000 pesewas = total_payable ✓
```

Note the final instalment is 4 pesewas (GHS 0.04) *smaller* than the rest — same shape as the legacy rounding rule for Types A/B, just applied to two components instead of one.

## 4. Payment allocation within a Type C instalment

Per mission §5/§8.3 and plan doc §6: **penalties/fees → interest → principal**, applied in that order by the shared `post_payment` allocator, walking instalments oldest-due-first:

1. Any unpaid `penalties` rows for the contract, oldest first.
2. Remaining amount → the current oldest unpaid instalment's `interest_portion` first, then its `principal_portion`. A partial payment that only covers part of an instalment's interest leaves that instalment `PARTIAL` with `principal_portion` entirely unpaid — principal is never touched before that instalment's interest is fully covered.
3. Once an instalment's `amount_paid_minor = amount_due_minor`, it's `PAID` and allocation moves to the next instalment.
4. Overpayment past the final instalment → `entry_type = CREDIT`, refundable (same as Types A/B, plan doc §6).

## 5. Edge cases

- **1-month term**: `instalment_count = 1` — the loop's "final instalment absorbs the remainder" branch fires immediately (i = 1 is both first and last), so `interest_portion = total_interest` and `principal_portion = principal` exactly, no raw/ceil step needed. Degenerates cleanly to a single bullet payment.
- **Zero-interest edge (`interest_rate_bps = 0`)**: `total_interest = 0`, every instalment's `interest_portion = 0`, and the schedule degenerates to the same straight-line split used for Types A/B — confirms the flat-rate formula is a strict superset, not a parallel code path.
- **Early settlement**: paying the full current `balance_minor` in one payment is handled by the same allocator (step 2 above just keeps consuming instalments in order until the amount runs out); no special "settlement" formula needed since interest is fixed per instalment up front, not accruing daily — there's no rebate calculation to perform because unpaid future interest was never "earned" in a daily-accrual sense, it's simply on instalments that are now paid off in the same pass. This is a direct consequence of choosing flat/precomputed-per-instalment interest over daily accrual, and is explicitly called out here since it's the kind of assumption that needs to be visible, not buried in code.
- **Rounding drift check**: the worked example's final "Check" line is exactly what a unit test should assert for every generated Type C schedule — `sum(amount_due) === total_payable_minor` to the pesewa, for every `(principal, rate, term)` combination exercised in tests.
