# Running corrobo in production

What to set up, what to watch, and what not to do, for corrobo with `PostgresStore`. Every SQL query on this page is run against a real Postgres by `tests/operations-doc.test.ts`, so they stay correct as the schema evolves.

## Set up the pool

```ts
import { Pool } from "pg";
import { PostgresStore } from "corrobo/postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // operations in flight at once, plus whatever else uses this pool
  connectionTimeoutMillis: 5_000 // don't wait forever for a connection
});
// An idle client that loses its connection (a failover, a network drop) emits "error" on the pool.
// Without a listener, node-postgres lets that crash the process.
pool.on("error", (err) => console.error("postgres pool error", err));

const store = new PostgresStore(pool, { acknowledgePersistence: true });
```

- **One connection per operation in flight.** Each `runEffect()` / `reviewEffect()` holds one pooled connection for its whole pass, including while your hooks run. Size `max` for the operations you run at once, or use a dedicated pool for corrobo.
- **"Busy" means the lock, not the pool.** A second call for the same operation returns the recorded state (or `OperationBusyError` from `reviewEffect()`) as soon as it finds the operation's lock held. But it first needs a connection from the pool: if the pool is exhausted, it waits for one like any other query. `connectionTimeoutMillis` bounds that wait.

## Give every hook a timeout

`authorize()`, `revalidate()`, `execute()` and `observe()` all run while the operation's lock and a pool connection are held. corrobo doesn't time them out: a hook whose promise never settles holds that connection forever, and a few of them can exhaust the pool. Give every network call inside a hook a deadline (for example `AbortSignal.timeout(10_000)`), and make `maxInFlightMs` at least `execute()`'s timeout plus the provider's processing time. A hook that times out should throw: `execute()` then records an unknown outcome, `observe()` an `UNKNOWN`, and `revalidate()` fails closed.

## Migrations and upgrades

- **Run `migrate()` as a deploy step, not on every startup,** with a lock timeout. Its `ALTER TABLE`s take a brief `ACCESS EXCLUSIVE` lock on `corrobo_operations`, which queues behind long-running transactions on that table, and everything queues behind it.

  ```ts
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await PostgresStore.migrate(client);
  } finally {
    client.release();
  }
  ```

- **Drain old workers before new ones serve traffic,** and don't run two corrobo versions against one table. Each release's upgrade notes in the [changelog](../CHANGELOG.md) say what changes.
- **Don't roll back from 0.5 to 0.4.0** if you use review. 0.4.0 ignores review tokens and `maxApprovalAgeMs`, so it would accept a decision made for an earlier review again (the bug 0.5.0 fixed). 0.4.0 is deprecated on npm.
- **Changing a contract during a rolling deploy.** An attempt records the `maxInFlightMs` it was sent under, and settlement never uses a shorter one. Other changes (`observe()`, `reconcile()`, `fingerprintIntent()`, the retry policy) apply to operations already open. If a change is incompatible with them, give the new contract a new `operationType` and let the old operations finish under the old one.

## Retention: never delete what can still be retried

The table keeps one row per operation and nothing expires on its own. **Deleting a row erases corrobo's memory of that operation:** if the same identity arrives again (a redelivered queue message, a retried job, a replayed webhook), it looks new and executes again. Before deleting a row, make sure nothing can ever present its identity again: keep rows at least as long as your longest redelivery or replay window, and for identities that could come back at any time (a user's "confirm" button), don't delete them at all. If you must shrink the table, archive closed rows somewhere `runEffect()` can't miss them, rather than deleting them.

## Finding operations that need a call

corrobo only acts when something calls `runEffect()` with an identity, so after a lost job, a crash, or a dropped review task, nothing happens until you look. The [action-table pattern](../examples/action-table) (your own row per action, plus a sweeper) covers most of this. These queries find each state directly.

Attempts interrupted mid-flight (a crash between sending the request and saving the outcome). Call `runEffect()` again: it observes first and never re-sends blindly.

```sql
SELECT id, operation_type, updated_at
FROM corrobo_operations
WHERE status = 'OPEN'
  AND attempts -> -1 ->> 'status' = 'RESERVED'
  AND updated_at < now() - interval '5 minutes'
ORDER BY updated_at;
```

Retries that are due (any `retryNotBefore` has passed):

```sql
SELECT id, operation_type, attempts -> -1 ->> 'retryNotBefore' AS retry_not_before
FROM corrobo_operations
WHERE status = 'OPEN'
  AND attempts -> -1 ->> 'disposition' = 'RETRY'
  AND coalesce((attempts -> -1 ->> 'retryNotBefore')::timestamptz, '-infinity') <= now()
ORDER BY updated_at;
```

Waiting for the provider to settle (`PENDING`):

```sql
SELECT id, operation_type, updated_at, jsonb_array_length(attempts -> -1 -> 'observations') AS observations
FROM corrobo_operations
WHERE status = 'OPEN'
  AND attempts -> -1 ->> 'evidenceState' = 'PENDING'
ORDER BY updated_at;
```

Stopped because `revalidate()` failed (it threw or its dependencies were down), and nobody has called again since:

```sql
SELECT id, operation_type, blocked_by -> 'reason' ->> 'summary' AS why, updated_at
FROM corrobo_operations
WHERE status = 'OPEN'
  AND blocked_by ->> 'outcome' = 'failed'
  AND (blocked_by ->> 'recordVersion')::bigint = version
ORDER BY updated_at;
```

Awaiting review, oldest first (the current token is `review_episode ->> 'token'`):

```sql
SELECT id, operation_type, review_reason ->> 'code' AS reason, review_episode ->> 'openedAt' AS since
FROM corrobo_operations
WHERE status = 'AWAITING_REVIEW'
ORDER BY review_episode ->> 'openedAt' NULLS FIRST;
```

Closed for a person to look at (`INVESTIGATE`: corrobo couldn't establish what happened; `REPLAN`: the world changed under the plan):

```sql
SELECT id, operation_type, attempts -> -1 ->> 'disposition' AS disposition,
       attempts -> -1 -> 'dispositionReason' ->> 'summary' AS why, updated_at
FROM corrobo_operations
WHERE status = 'CLOSED'
  AND attempts -> -1 ->> 'disposition' IN ('INVESTIGATE', 'REPLAN')
ORDER BY updated_at DESC;
```

On a large table, an index on `(status, updated_at)` keeps these cheap; create it without blocking writes:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS corrobo_operations_status_updated_at ON corrobo_operations (status, updated_at);
```

## `CLOSED` is final

A closed operation never changes again, including one closed as `INVESTIGATE` because `observe()` failed during an outage. Calling `runEffect()` again returns the recorded result; it doesn't re-check. Resolve it outside corrobo: check the provider yourself, record what you found in your own system, and if the effect still needs to happen, make it a new operation with a new identity.
