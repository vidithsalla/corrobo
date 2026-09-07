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

## What this is not

- Not an exactly-once guarantee. corrobo cannot promise a third-party system it doesn't control never double-processes anything — only that its own recorded decision was derived from real evidence, not a guess.
- Not a polling/orchestration engine. `PENDING` is modeled and re-observable, but corrobo does not schedule when you call `run()` again.
- Not tied to any agent framework. Nothing in `src/core` imports an LLM SDK — this is useful with or without one.

## Stores

- **In-memory** (`InMemoryStore`) — for tests, examples, and local development only. State lives in process memory: a restart loses every operation record. No crash-survival, no durable-idempotency guarantee.
- **Postgres** (`corrobo/postgres`) — durable mode intended for real applications. Operation identity and prior evidence survive a process restart. One table, one `CREATE TABLE IF NOT EXISTS` migration (`PostgresStore.migrate(pool)`), no ORM.

## Fault testing

`corrobo/testing` provides deterministic fault injection — `FaultSchedule`, `withFaultInjection`, `withObservationFault` — for wrapping your *own* real delegate calls in tests, so you can simulate "the mutation happened but the response was lost" or "the read-back failed" without corrobo's runtime ever being aware faults exist. It lives outside `src/core` on purpose: nothing in the production path imports it.

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
