# Changelog

## Unreleased

### Fixed

- **A new review could have no token for a moment during an upgrade from 0.4.0.** If a 0.4.0 worker had approved an operation (recording no token) and 0.5.0 opened a new review for it in the same millisecond, that review counted as already answered: the result reported `AWAITING_REVIEW` with `reviewToken: null` until the next `runEffect()`. That's fail-closed (nothing could be approved or executed), but it's wrong. A review now records the tokenless decision that predates it (`ReviewEpisode.predatesDecisionAt`). Found by the new model-based test.

### Added

- **A model-based test of the review flow** (`tests/review-state-machine.test.ts`). It runs random sequences of runs, review decisions (current, stale, foreign and garbage tokens, decisions dated before the review, expiries), `revalidate()` outcomes, transport outcomes, late landings, clock jumps, crashes at store writes, lock contention and 0.4.0 workers in a rolling upgrade, in memory and against Postgres. It checks every `execute()` and every decision against an independent oracle. It caught all 14 deliberately reintroduced bugs, including the original stale-review bug. Scale it with `CORROBO_MODEL_SEEDS` / `CORROBO_MODEL_STEPS`; re-run one seed with `CORROBO_MODEL_SEED`.

## 0.5.0 — 2026-10-02

Fixes a review-boundary bug in 0.4.0: a decision made for one review of an operation could approve a later review of it. Each review now has its own token, and decisions are refused unless they carry the current one. Also adds `maxApprovalAgeMs` and corrects what the docs claim about the `runEffect()`/`reviewEffect()` split. Upgrade from 0.4.0 if you use review.

### Security

- **A decision made for an earlier review could approve a later one (0.4.0).** If `revalidate()` sent an approved operation back to review, a decision from the first review (say, from a reviewer's stale screen) was accepted for the second, and the operation executed. Each review now has its own token, which a decision must carry, and a decision dated before the current review began is refused. Reported with a reproduction by Ömer Faruk Koç.

### Upgrading from 0.4.0

1. **Drain 0.4.0 workers, then run `PostgresStore.migrate(pool)` once** before 0.5.0 serves traffic. It adds a nullable `review_episode` column in place. Don't run both versions against the same table: a 0.4.0 worker can send an operation back to review without opening a new review. (0.5.0 refuses the already-answered token in that case and opens a new review on the next `runEffect()`, but draining is the clean path.)
2. **Approvals recorded by 0.4.0 need a new review.** They carry no token, so they can't be tied to a review, and one may have come in through the bug above. An operation 0.4.0 approved that hasn't finished goes back to `AWAITING_REVIEW` with `APPROVAL_NOT_RECORDED` before any further attempt.
3. **`ReviewDecision.reviewToken` is required.** Keep `result.reviewToken` from the result that reported `AWAITING_REVIEW` with your review task, and pass it with the decision. An operation already awaiting review gets a token on its next `runEffect()`.
4. **`reviewEffect()` throws `ReviewNotAcceptedError` instead of returning quietly** when it doesn't record a decision: not awaiting review, a stale token, a decision dated before the review began, a different intent, or an approval that has already expired. `.code` says which, and `.current` is the operation's state. The intent-mismatch and already-expired refusals used to be plain `Error`s.
5. **`setStatus()` is still there**, still deprecated. Its removal moves to 0.6, so custom stores and callers get one more release to switch to `updateOperation()`.
6. **New required fields:** `EffectResult.reviewToken` (`string | null`) and `RecordedReview.reviewToken`. Custom stores must persist `OperationRecord.reviewEpisode`, including when an operation is created with one (`NewOperationInput.reviewEpisode`).

### Added

- `ReviewEpisode` (`OperationRecord.reviewEpisode`), `EffectResult.reviewToken`, `ReviewNotAcceptedError` / `ReviewRefusal`.
- **`maxApprovalAgeMs` on contracts:** the longest any approval covers new attempts, counted from when it was decided, whether or not it set `expiresAt`. A review screen that forgets an expiry can no longer produce an approval that lasts forever.
- Docs: the `runEffect()`/`reviewEffect()` split is an API boundary that enables capability separation, not a privilege boundary that provides it; `context` must be built on your server; keep `revalidate()` fast and bounded.

## 0.4.0 — 2026-10-01

Pre-execute checks for agent runtimes: `revalidate()` before every attempt, and review decisions that record who approved what, bound to the intent and checked before each attempt. Both were designed in review by Ömer Faruk Koç.

### Upgrading from 0.3.x

1. **Run `PostgresStore.migrate(pool)` once.** It adds nullable `blocked_by` and `review` columns in place. Drain 0.3.x workers first: they don't know about the new fields.
2. **Custom `EffectStore` implementations** must add `updateOperation(id, update, expectedVersion)`. It's version-checked like every write, and must apply only the fields present, with `null` clearing a field. They must also persist `OperationRecord.blockedBy`, `OperationRecord.review` and the optional `check` on reserved attempts (`ReservedAttemptInput.check`). `setStatus()` is deprecated: runEffect() no longer calls it, and it will be removed in 0.5.
3. **`EffectResult.review`** is a new required field (`RecordedReview | null`). Code that builds results by hand, such as test fixtures, needs `review: null`.
4. **Operations approved under 0.3.x need a new review.** 0.3.x recorded no review decision, so an operation it approved that hasn't finished goes back to `AWAITING_REVIEW` with `APPROVAL_NOT_RECORDED` before any further attempt, rather than executing on an approval nobody can attribute. Re-approve it with a `ReviewDecision`.
5. **`runEffect()` no longer takes `reviewDecision`.** Record decisions with `reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewer } })` from your review flow, then call `runEffect()` to act on it. Passing a `reviewDecision` value to `runEffect()` throws a `TypeError` instead of approving. This is what keeps an agent's tools or a worker from approving their own attempts.

### Added

- **`revalidate()` on contracts** ([#27](https://github.com/vidithsalla/corrobo/issues/27)) runs under the lock right before every attempt, including the first, and before the attempt is reserved. It can `proceed`, require review, or `reject` (`CLOSED`/`REPLAN`). If it throws, nothing executes and the operation stays `OPEN` (`REVALIDATION_FAILED`). It only gates new attempts: a late landing is still found and completed. Its result is recorded on the attempt (`check`), or on the operation when it stops one (`blockedBy`). See [spec §M.1](docs/v0.1-spec.md#m1-revalidation-before-each-attempt).
- **`EffectRequest.context`** is per-call caller information (actor, scope) passed to `authorize()` and `revalidate()`. It's never stored or fingerprinted. `defineContract<Intent, Context>()` types it.
- `authorize()` now also receives `{ identity, context }`.
- `corrobo/package.json` is exported, so `require("corrobo/package.json")` works.
- **Attributed review decisions** ([#28](https://github.com/vidithsalla/corrobo/issues/28)). `reviewEffect(store, contract, { identity, decision })` records a decision and never executes; the next `runEffect()` acts on it. Keeping them apart means the code that makes attempts can't approve them: `runEffect()` takes no decision (see upgrade note 5). `OperationBusyError` is thrown if another call holds the operation. A decision is `{ decision, reviewer, decidedAt?, expiresAt?, intentFingerprint?, note? }`, validated before anything runs (times must be strict RFC 3339 with `Z` or an offset). It's recorded on the operation (`OperationRecord.review`, `EffectResult.review`) with the recorded intent's fingerprint, and copied onto each attempt it allowed. A decision made for a different intent is refused. An expired approval, or one that no longer matches the recorded intent, sends the operation back to review before any further attempt. `revalidate()` receives the approval so it can check approver policy. See [spec §M](docs/v0.1-spec.md#m-review-decisions).
- Docs: [where the identity comes from](README.md#where-the-identity-comes-from). Mint it server-side when the action is confirmed and store it with the action, because the same intent with a new identity is a new effect.
- Example: [`examples/action-table`](examples/action-table) links corrobo's record to an app's own table of actions (`npm run example:action-table`). It's tested against Postgres, including the restart sweep and an operator join.

Thanks to Ömer Faruk Koç ([@negativexq](https://github.com/negativexq)), whose review and design prompted all of the above.

## 0.3.0 — 2026-09-30

### Upgrading from 0.2.x

1. **Install `pg` yourself if you use `PostgresStore`** (`npm install pg`). corrobo no longer depends on it: it never loaded `pg` at runtime anyway (you pass in your own `Pool`), so it's now an optional peer dependency. If your code imports `pg` and only worked because corrobo pulled it in, you'll see `Cannot find module 'pg'` until you add it.
2. **Drain 0.2.x workers, then run `PostgresStore.migrate(pool)` once** before 0.3.0 serves traffic. It adds a `version` column in place (existing rows start at 0). 0.2.x writes don't check or bump versions, so don't run both versions against the same table. On PostgreSQL 11+ this doesn't rewrite the table but takes a brief `ACCESS EXCLUSIVE` lock; run it with a `lock_timeout`.
3. **Declare `maxInFlightMs` on contracts that should retry after a timeout.** A `NOT_APPLIED` after a failed or unknown transport used to become `RETRY` immediately. A timed-out request can still land after that check, so it's now `INVESTIGATE` unless the contract declares `maxInFlightMs`. With it, a `RETRY` decided while that window is still open carries `retryNotBefore` (nothing executes before it); once the window has passed, corrobo re-checks before executing again. Use `0` only when every attempt sends the same provider idempotency key. `RETRY`s recorded by 0.2.x are re-checked under the new rule.
4. **Custom `EffectStore` implementations** must add `version` to records and take `expectedVersion` on every write, throwing `StoreConflictError` on mismatch (see spec §O). Add `now()` if the store is shared across hosts.
5. **Intents must be plain JSON.** An intent containing a function, `Map`, `Set`, `BigInt`, symbol, typed array, own getter or a circular reference now throws a `TypeError` naming the field, before anything runs. Previously some of these were silently mangled, and a `Date` never matched itself after a Postgres round trip, so every retry threw "different intent". Stored intents are now their JSON form (a `Date` is stored as its ISO string in both stores). Contracts with their own `fingerprintIntent()` are unaffected.
6. **`decideDisposition()` input** now requires `settlement` (only relevant if you call it directly).
7. **An explicit `identity` whose `operationType` differs from the contract's now throws** before anything runs. Previously it created a record that conflicted on the next call.
8. **New required fields on exported types:** `EffectResult.retryNotBefore` (`string | null`) and `OperationRecord.version` (`number`). Code that builds these objects by hand, such as test fixtures, needs `retryNotBefore: null` and a `version`.

### Fixed

- **Duplicate effect when a Postgres lock is lost mid-call.** If the lock's database session died while `execute()` was still running, another caller could observe "not applied" before the first request landed, record `RETRY`, and execute again. Fixed by version-checked writes (a stale caller can't overwrite anything) plus the settlement rule above.
- **Process crash on connection loss.** A terminated database session emitted an unhandled `error` event on the lock's client, which crashes a Node process. Now handled.
- A lock connection whose unlock failed was returned to the pool still holding the lock; it's now destroyed.
- Intent fingerprints: `Date`, `Map` and function fields all fingerprinted as `{}`, so different intents bound as the same operation (see upgrade note 5).
- `InMemoryStore` no longer breaks permanently when `execute()` throws a value that can't be cloned.
- A thrown `{ message }` object records its message instead of `"[object Object]"`; a thrown value whose `message` can't be read no longer aborts a pass.

### Added

- `maxInFlightMs` on contracts; `retryNotBefore` on results.
- `defineContract<Intent>()({...})`, `observed(data, { source, authoritative })` and `reconciled(state, code, summary)` helpers.
- `identity` may be a plain string id (the `operationType` comes from the contract).
- `capabilities` is optional (the runtime never read it).
- `StoreConflictError`; `OperationRecord.version`; `CoordinatedStore.now()`; `PostgresStore.now()` (the database clock).
- Structural `PgPool` / `PgPoolClient` / `PgQueryable` types: `corrobo/postgres` no longer needs `@types/pg` to type-check.
- Conformance harness: `verifyEffectContract()` and `formatConformanceReport()` in `corrobo/testing` run your contract against a fake of your provider through 12 failure scenarios and count effects on the fake ([guide](docs/testing-your-contract.md)); `npm run conformance`.
- `npm run demo` (timeout-after-write against a real HTTP ledger, CI-gated), `npm run quickstart`.
- Example: corrobo inside a DBOS workflow step across a real `SIGKILL` between the write and DBOS's checkpoint (naive: 2 credits; corrobo: 1), CI-gated.
- Docs: [failure matrix](docs/failure-matrix.md) (every row test-backed, CI-checked), [guarantees](docs/guarantees.md), [why not just…](docs/why-not-just.md).

## 0.2.1

See the [v0.2.1 release](https://github.com/vidithsalla/corrobo/releases/tag/v0.2.1).
