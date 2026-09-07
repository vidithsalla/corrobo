# corrobo

What happens when a state-changing API call times out and you don't know whether the change happened?

Most code answers that question by accident: a caught exception becomes "it failed, retry," and a successful response becomes "it worked." Neither is reliable. A timeout doesn't mean the write didn't happen — it just means the response didn't arrive. Retrying on that assumption is how you double-charge a customer or double-cancel an order.

**A transport response is evidence. It is not business truth.**

corrobo is a small TypeScript runtime that keeps those two things separate for any consequential side-effecting operation — a payment, a ticket update, an order mutation, a deployment — whether the caller is an LLM agent, a script, or a person. It is framework-independent: nothing in it imports an LLM SDK, and it's just as useful for a plain backend job as it is for an agent's tool call.

```
execute()   — attempt the side effect; capture what happened at the transport level, nothing more
observe()   — ask the authoritative source what's actually true (a fresh read, not the write's own response)
reconcile() — compare what you intended to what you observed → an evidence state
recover     — decide what's safe to do next, from the evidence state alone
```

## Install

```
npm install corrobo
```

## Quickstart

This uses `InMemoryStore`, which is **quickstart/testing only** — no crash-survival, no cross-process coordination. See [Postgres for production](#postgres-for-production) below for real durability.

```ts
import { runEffect, InMemoryStore } from "corrobo";

const store = new InMemoryStore(); // quickstart/testing only — see PostgresStore below

const cancelOrder = {
  operationType: "orders/cancel",
  capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: true, convergence: false },
  retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },

  async execute({ intent }) {
    const res = await fetch(`/orders/${intent.orderId}/cancel`, { method: "POST", body: JSON.stringify(intent) });
    return { httpStatus: res.status, body: await res.json() };
  },

  async observe({ intent }) {
    const res = await fetch(`/orders/${intent.orderId}`);
    const order = await res.json();
    return { status: "observed", data: order, authoritative: true, source: "orders-api", observedAt: new Date().toISOString() };
  },

  reconcile({ observation }) {
    const applied = observation.status === "observed" && observation.data.status === "cancelled";
    return applied
      ? { evidenceState: "APPLIED", reason: { code: "CONFIRMED", summary: "Order is cancelled." } }
      : { evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "Order is still open." } };
  }
};

const result = await runEffect(store, cancelOrder, {
  identity: { id: "cancel-order-42-v1", operationType: cancelOrder.operationType },
  intent: { orderId: "42" }
});

result.evidenceState; // "APPLIED" | "NOT_APPLIED" | "CONFLICTED" | "PENDING" | "UNKNOWN"
result.disposition;   // "COMPLETE" | "RETRY" | "REPLAN" | "REVIEW" | "INVESTIGATE" | null (only when PENDING)
```

`runEffect` is safe to call again with the same `identity`: it only calls `execute()` when doing so is actually safe (a fresh operation, or a prior `RETRY`). A completed, conflicted, or under-review operation returns its recorded result instead of re-attempting the mutation.

## The headline case: timeout after the write already happened

```
intent (cancel order #42)
  → POST /orders/42/cancel
  → the response never arrives (timeout)
  → corrobo does NOT assume the cancellation failed
  → observe(): GET /orders/42, the authoritative source
  → the order is already cancelled
  → APPLIED → COMPLETE
  → no duplicate cancellation is ever attempted
```

This is the reason corrobo exists. A `try { await cancel() } catch { retry() }` pattern would see the timeout, assume nothing happened, and retry — which is fine if the API is natively idempotent and unsafe otherwise. corrobo never makes that assumption: it always asks the authoritative source what actually happened before deciding anything. See [`examples/rest`](examples/rest) for this exact scenario running against a real local HTTP server, and [Flagship example: Stripe refunds](#flagship-example-stripe-refunds) below for the same story against a real payment API.

## Evidence states and dispositions

**Evidence states** (what the evidence establishes): `APPLIED`, `NOT_APPLIED`, `CONFLICTED`, `PENDING`, `UNKNOWN`
**Recovery dispositions** (what's safe to do next): `COMPLETE`, `RETRY`, `REPLAN`, `REVIEW`, `INVESTIGATE`

These are two different vocabularies on purpose. Evidence state is what you can establish about the world. Disposition is what corrobo recommends doing about it — and it's derived from evidence state, never the other way around.

- `APPLIED` → `COMPLETE`.
- `NOT_APPLIED` → `RETRY` only if the operation type is actually safe to retry (`retryPolicy.retryOnNotApplied`) and attempts remain; otherwise `INVESTIGATE`.
- `CONFLICTED` → `REPLAN` — the world changed under the plan; a new intent and identity are needed, not a retry of this one.
- `PENDING` → **no disposition.** Some operations (an async payment, a converging Kubernetes deployment) legitimately acknowledge a request before the effect is final; corrobo re-observes on the next call rather than re-executing.
- `UNKNOWN` → `INVESTIGATE`, never a silent retry. This is a legitimate, permanent-until-a-human-looks answer — corrobo will not guess that a duplicate side effect is safe just because a retry loop wants one.
- `REVIEW` is a *pre-execution* policy gate on a known, well-formed action requiring human sign-off — it never comes from evidence, and a human can reject it (closing the operation without ever calling `execute()`) as well as approve it.

See [`docs/v0.1-spec.md`](docs/v0.1-spec.md) for the full type-level contract, including crash recovery and identity-binding semantics, and [`docs/pressure-test-v0.md`](docs/pressure-test-v0.md) for the real-world research (Stripe, GitHub, Slack, Linear, Kubernetes) this design is based on.

## Postgres for production

- **`InMemoryStore`** (from `corrobo`) — quickstart and tests only. State lives in process memory: a restart loses every operation record, and its concurrency coordination is an in-process mutex with no cross-process guarantee.
- **`PostgresStore`** (from `corrobo/postgres`) — the production-shaped store. One table, one `CREATE TABLE IF NOT EXISTS` migration (`PostgresStore.migrate(pool)`), no ORM.
  - **Crash recovery**: corrobo durably reserves an attempt *before* `execute()` is ever called. If a worker dies mid-attempt, the next run for that identity observes and reconciles first — it never blindly re-executes just because the prior attempt's outcome was never recorded.
  - **Concurrency**: callers using the *same* operation identity are coordinated via a session-scoped Postgres advisory lock held on one dedicated connection for the whole pass, so one in-flight identity consumes exactly one pool connection. A crashed process cannot leave a permanent lock — Postgres releases it when the connection dies. *Different* identities never serialize against each other.
  - A custom `EffectStore` implementation must provide the same same-identity coordination to be safe for concurrent use.

See [`docs/v0.1-spec.md`](docs/v0.1-spec.md#i1-concurrency-two-callers-the-same-operation-identity) for the precise wording of what this does and doesn't guarantee.

## Examples

- **[`examples/rest`](examples/rest)** — a generic order-cancellation HTTP mutation against a real local server (no external credentials). Run `npm run example:rest` for a deterministic walkthrough of normal success, timeout-before-write, timeout-after-write (the headline case), a stale-version conflict, async `PENDING` convergence, and an unresolvable `UNKNOWN`.
- **[`examples/stripe-refund`](examples/stripe-refund)** — see below.

### Flagship example: Stripe refunds

[`examples/stripe-refund`](examples/stripe-refund) wraps the official Stripe refunds API the same way `examples/rest` wraps a plain HTTP mutation — same `execute`/`observe`/`reconcile` shape, no adapter framework in between. The corrobo operation `identity` and the Stripe `Idempotency-Key` are tied together deterministically (`refund:<identity.id>`): every attempt of the same logical refund reuses the same key, so a lost response is resolved by asking Stripe what it already recorded, not by guessing. A genuinely new refund requires a new identity, and therefore a new key, by construction.

`npm run example:stripe` runs a **deterministic demo against a fake Stripe boundary** (no network, no credentials) covering every case above plus a conflicting refund amount, an asynchronously-settling refund, and a high-value refund requiring human review before Stripe is ever called. `npm run example:stripe:live-smoke` is a separate, **entirely optional** script that exercises the same contract against the real Stripe **test-mode** API — it only runs if `STRIPE_SECRET_KEY` is set to a key starting with `sk_test_` (it refuses anything else), requires no key at all to skip cleanly, and never touches live mode.

To be precise about what's actually guaranteed:
- **Stripe** provides the idempotency guarantee at its own API boundary — the same key never creates two refund objects, but only for at least 24 hours. The example won't replay past a conservative margin under that window (22h by default), and once a stable refund id is known, it prefers a direct lookup by id over replaying the key at all. Past the safe window with no id known, it honestly reports `UNKNOWN` rather than risk a second refund.
- **corrobo** persists the operation identity before ever calling Stripe, keeps transport evidence separate from Stripe's authoritative refund state, and derives a conservative disposition from that evidence alone.
- Together these mean corrobo won't *itself* cause a duplicate refund — they do **not** mean global exactly-once payment behavior. A downstream bank/payment rail issue is outside what either Stripe's or corrobo's guarantees reach.

## Agent Skill (integration assistant)

[`skills/corrobo`](skills/corrobo) is an optional Agent Skill (SKILL.md + reference docs, no runtime code) for Claude Code / Codex-style coding agents. It can help a coding agent:

- audit an existing codebase for consequential side-effecting operations and unsafe retry assumptions;
- identify what identity/idempotency/observation mechanisms an operation actually has (never inventing ones it doesn't);
- propose a minimal Effect Contract for a specific operation;
- scaffold the integration and generate targeted fault tests — only when explicitly asked.

**The Skill is not the safety layer. The runtime is.**

```
Agent Skill      -> helps a developer identify + integrate
corrobo runtime  -> owns operation identity, coordination, execution evidence,
                     observation, reconciliation, disposition, persistence
External system  -> owns authoritative business truth
```

corrobo is not "an AI skill" or an agent framework — the Skill is an optional adoption aid on top of a runtime that works identically with or without an LLM involved, and the project is fully usable without ever touching it.

## Guarantees and non-guarantees

corrobo **is**: a small reliability runtime for consequential side effects, framework-independent, and useful with or without LLM agents involved.

corrobo is **not**: a workflow engine, a task queue, a generic agent orchestration framework, a generic exactly-once execution system, or a replacement for an API's own native idempotency support — it *composes* with native idempotency (as the Stripe example does) rather than replacing it.

Precisely:
- corrobo does **not** guarantee exactly-once execution against any third-party system it doesn't control. It guarantees that its own recorded decision (`COMPLETE`/`RETRY`/`REPLAN`/`REVIEW`/`INVESTIGATE`) is derived only from real evidence, never invented.
- corrobo cannot create authoritative evidence where none exists. If `observe()` fails or is genuinely ambiguous, the honest answer is `UNKNOWN` → `INVESTIGATE`, not a guess — this is a correct, expected outcome, not a bug to engineer away.
- `PENDING` means "observe again later," never "execute again" — re-execution never happens just because convergence is incomplete.
- Whether a retry is safe is entirely a function of the operation's own declared semantics (`retryPolicy.retryOnNotApplied`) — corrobo enforces the policy a contract declares, it does not infer safety on its own.
- Not a polling/orchestration engine: `PENDING` is modeled and re-observable, but corrobo does not schedule *when* you call `run()` again.

## Development

```
npm install
npm run typecheck
npm test
npm run example:rest
npm run build
```

Postgres tests run only when `CORROBO_TEST_DATABASE_URL` is set, pointing at a scratch database:

```
createdb corrobo_dev_test
CORROBO_TEST_DATABASE_URL=postgres://localhost:5432/corrobo_dev_test npm test
```
