# corrobo

What happens when a state-changing API call times out and you don't know whether the change happened?

Most code answers that question by accident: a caught exception becomes "it failed, retry," and a successful response becomes "it worked." Neither is reliable. A timeout doesn't mean the write didn't happen — it just means the response didn't arrive. Retrying on that assumption is how you double-charge a customer or double-cancel an order.

**A transport response is evidence. It is not business truth.**

corrobo is a small TypeScript runtime that keeps those two things separate for any side-effecting operation — a payment, a ticket update, an order mutation, a deployment — whether the caller is an LLM agent, a script, or a person.

## The model

```
execute()   — attempt the side effect; capture what happened at the transport level, nothing more
observe()   — ask the authoritative source what's actually true (a fresh read, not the write's own response)
reconcile() — compare what you intended to what you observed → an evidence state
recover     — decide what's safe to do next, from the evidence state alone
```

**Evidence states**: `APPLIED`, `NOT_APPLIED`, `CONFLICTED`, `PENDING`, `UNKNOWN`
**Recovery dispositions**: `COMPLETE`, `RETRY`, `REPLAN`, `REVIEW`, `INVESTIGATE`

These are two different vocabularies on purpose. Evidence state is what you can establish about the world. Disposition is what corrobo recommends doing about it — and it's derived from evidence state, never the other way around. `PENDING` in particular is not a failure: some operations (an async payment, a converging Kubernetes deployment) legitimately acknowledge a request before the effect is final, and corrobo re-observes rather than re-executing in that case.

`UNKNOWN` is a legitimate, permanent-until-a-human-looks answer. corrobo will not guess that a duplicate side effect is safe just because a retry loop wants one.

See [`docs/v0.1-spec.md`](docs/v0.1-spec.md) for the full type-level contract and [`docs/pressure-test-v0.md`](docs/pressure-test-v0.md) for the real-world research (Stripe, GitHub, Slack, Linear, Kubernetes) this design is based on.

## Usage

```ts
import { runEffect, InMemoryStore } from "corrobo";

const store = new InMemoryStore(); // or PostgresStore, for real durability

const cancelOrder = {
  operationType: "orders/cancel",
  capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: true, convergence: false },
  retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },

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

`runEffect` is safe to call again with the same `identity`: it only calls `execute()` when doing so is actually safe (a fresh operation, or a prior `RETRY`). A completed, conflicted, or under-review operation returns its recorded result instead of re-attempting the mutation. See [`examples/rest`](examples/rest) for a runnable walkthrough of every scenario below against a real local HTTP server.

## Flagship example: Stripe refunds

Timeout does not mean the refund failed.

```
intent (refund $50 on charge ch_123)
  → Stripe call, with an Idempotency-Key derived from the operation identity
  → the response never arrives (timeout)
  → observe(): Stripe's OWN idempotency cache is asked what actually happened
  → a refund already exists and succeeded
  → APPLIED → COMPLETE
  → no duplicate refund is ever created
```

[`examples/stripe-refund`](examples/stripe-refund) wraps the official Stripe refunds API the same way `examples/rest` wraps a plain HTTP mutation — same `execute`/`observe`/`reconcile` shape, no adapter framework in between. The corrobo operation `identity` and the Stripe `Idempotency-Key` are tied together deterministically (`refund:<identity.id>`): every attempt of the same logical refund reuses the same key, so a lost response is resolved by asking Stripe what it already recorded, not by guessing. A genuinely new refund requires a new identity, and therefore a new key, by construction.

To be precise about what's actually guaranteed:
- **Stripe** provides the idempotency guarantee at its own API boundary — the same key never creates two refund objects.
- **corrobo** persists the operation identity before ever calling Stripe, keeps transport evidence separate from Stripe's authoritative refund state, and derives a conservative disposition from that evidence alone.
- Together these mean corrobo won't *itself* cause a duplicate refund — they do **not** mean global exactly-once payment behavior. A downstream bank/payment rail issue is outside what either Stripe's or corrobo's guarantees reach.

Run `npm run example:stripe` for a deterministic walkthrough (no network, no credentials) of every case above plus a conflicting refund amount, an asynchronously-settling refund, and a high-value refund that requires human review before Stripe is ever called. An optional `npm run example:stripe:live-smoke` exercises the same contract against the real Stripe test-mode API if `STRIPE_SECRET_KEY` (a `sk_test_...` key) is set — it is skipped, not required, otherwise.

## What this is not

- Not an exactly-once guarantee. corrobo cannot promise a third-party system it doesn't control never double-processes anything — only that its own recorded decision was derived from real evidence, not a guess.
- Not a polling/orchestration engine. `PENDING` is modeled and re-observable, but corrobo does not schedule when you call `run()` again.
- Not tied to any agent framework. Nothing in `src/core` imports an LLM SDK — this is useful with or without one.

## Stores

- **In-memory** (`InMemoryStore`) — for tests, examples, and local development only. State lives in process memory: a restart loses every operation record. No crash-survival, no durable-idempotency guarantee. Its concurrency coordination is an in-process mutex only — no cross-process guarantee.
- **Postgres** (`corrobo/postgres`) — durable mode intended for real applications. Operation identity and prior evidence survive a process restart. One table, one `CREATE TABLE IF NOT EXISTS` migration (`PostgresStore.migrate(pool)`), no ORM. Concurrent callers using the same operation identity are coordinated via a session-scoped Postgres advisory lock, so only one active execution path runs at a time — a crashed process cannot leave a permanent lock, since Postgres releases it when the connection dies. This is not a distributed exactly-once guarantee for the external system; see [`docs/v0.1-spec.md`](docs/v0.1-spec.md#i1-concurrency-two-callers-the-same-operation-identity) for the precise wording.

## Fault testing

`corrobo/testing` provides deterministic fault injection — `FaultSchedule`, `withFaultInjection`, `withObservationFault` — for wrapping your *own* real delegate calls in tests, so you can simulate "the mutation happened but the response was lost" or "the read-back failed" without corrobo's runtime ever being aware faults exist. It lives outside `src/core` on purpose: nothing in the production path imports it.

## Agent Skill (integration assistant)

[`skills/corrobo`](skills/corrobo) is a small Agent Skill (SKILL.md + reference docs, no runtime code) for Claude Code / Codex-style coding agents. It helps a developer *find* consequential mutations with unsafe retry assumptions in an existing codebase and *scaffold* an integration — it audits and proposes, then implements only when explicitly asked.

It does not provide any safety guarantee itself:

```
Agent Skill      -> helps a developer identify + integrate
corrobo runtime  -> owns operation identity, coordination, execution evidence,
                     observation, reconciliation, disposition, persistence
External system  -> owns authoritative business truth
```

corrobo is not "an AI skill" — the skill is an optional adoption aid on top of a runtime that works identically with or without an LLM involved.

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
