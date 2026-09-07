# Dogfood audit 1: this repo (corrobo itself)

Performed by literally following `references/audit-guide.md` steps 1-5 against this repository. Audit mode only — no code changed as part of this audit.

## Step 1 — candidate side effects found

- `examples/rest/contract.ts`: `POST /orders/:id/cancel` via `callCancel()`.
- `examples/stripe-refund/contract.ts`: `stripe.refunds.create(...)` via the injected `StripeClientLike`.
- `examples/stripe-refund/live-smoke.ts`: `stripe.charges.create(...)` (creates a test-mode charge) and `stripe.refunds.create(...)` (via the contract).
- Considered and excluded: `src/stores/postgres.ts`'s `INSERT`/`UPDATE` statements against `corrobo_operations`. Per the audit guide's explicit exclusion (added after finding this ambiguous during this exact audit — see "finding" below), this is corrobo's own internal bookkeeping, not an application-level external mutation. Out of scope.

## Findings

| Operation | Risk | Current behavior | Identity | Observation | Retry hazard | Recommended treatment |
|---|---|---|---|---|---|---|
| `POST /orders/:id/cancel` (`examples/rest/contract.ts`) | N/A — already wrapped | Called only from inside a corrobo `EffectContract.execute()`; read-back via `GET /orders/:id` inside `observe()` | Corrobo operation identity, used as the sole correlation; server also tracks a `version` field checked by `reconcile()` | Direct, authoritative (`GET` by id), immediate | None — timeout-after-write is exercised in `tests/rest-example.test.ts` and confirmed non-duplicating | Already correct. No action. |
| `stripe.refunds.create(...)` (`examples/stripe-refund/contract.ts`) | N/A — already wrapped | Called only inside the contract's `execute()`, with the Stripe `Idempotency-Key` derived from the corrobo identity (`refund:<identity.id>`) | Native Stripe idempotency key, deterministically tied to the corrobo operation identity | Direct retrieve-by-id when available; idempotency-key replay as fallback observation when not | None found | Already correct. No action. |
| `stripe.charges.create(...)` (`examples/stripe-refund/live-smoke.ts`) | Low | Not wrapped by any corrobo contract; no idempotency key passed | None — a fresh charge id is created on every run | N/A (this call's own result is used directly, not reconciled) | Repeated runs of this script create additional test-mode charges (clutter, not correctness) | **Not recommended for corrobo wrapping.** This is manual smoke-test scaffolding to produce a fresh refundable charge, in Stripe TEST MODE only — its repetition has no real business consequence (no real money, not part of the demonstrated operation). If reducing test-charge clutter across repeated runs is desired, pass a client-generated idempotency key to this one call — that's a Stripe-idempotency hygiene improvement, not a corrobo integration need. |

## Finding used to improve the skill itself

While reasoning about `src/stores/postgres.ts`'s own `INSERT`/`UPDATE` statements, it was genuinely ambiguous on a first pass whether a literal-minded audit (e.g. a keyword search for "INSERT"/"UPDATE"/"mutation") would incorrectly flag corrobo's *own* persistence writes as a candidate needing corrobo-wrapping — which would be circular (corrobo wrapping itself). `references/audit-guide.md`'s "do not flag" list was missing this case. Fixed: added an explicit exclusion for a persistence layer's own internal bookkeeping writes, distinguishing them from an application's business mutation against an external system.

## Conclusion

This repo's own demonstrated operations (the two example contracts) are already correctly integrated. The one genuinely unwrapped mutating call (`live-smoke.ts`'s charge creation) is correctly assessed as out of scope given its test-mode-only, non-business-consequential nature — a useful check that the audit doesn't manufacture findings just to have something to report.
