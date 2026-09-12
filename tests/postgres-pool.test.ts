import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

/**
 * Regression test for the connection-pool self-deadlock: earlier, tryAcquireLock() held one
 * dedicated connection per in-flight identity while every other store call (getOperation,
 * createOperation, reserveAttempt, ...) checked out a SEPARATE connection from the same pool.
 * With a tiny pool, N concurrent distinct identities where N >= pool.max would exhaust every
 * connection on lock-holding alone, leaving none for any pass's own bookkeeping — every
 * holder permanently blocked waiting for a connection nothing could ever release. This is a
 * deterministic capacity failure, not a timing coincidence: it reproduces on every run with a
 * pool this small, not just occasionally.
 */
describe.skipIf(!connectionString)("PostgresStore connection-pool deadlock regression", () => {
  let setupPool: Pool;
  let tinyPool: Pool;

  beforeAll(async () => {
    setupPool = new Pool({ connectionString });
    await PostgresStore.migrate(setupPool);
  });

  beforeEach(async () => {
    await setupPool.query("TRUNCATE corrobo_operations");
    // Deliberately tiny: fewer connections than the number of concurrent distinct identities
    // below. Under the old design this pool size alone was enough to deadlock permanently.
    tinyPool = new Pool({ connectionString, max: 2 });
  });

  afterEach(async () => {
    await tinyPool.end();
  });

  afterAll(async () => {
    await setupPool.end();
  });

  it("N >= pool.max concurrent distinct identities complete without deadlocking, and genuinely overlap", async () => {
    const store = new PostgresStore(tinyPool, { acknowledgePersistence: true });
    const identityCount = 3; // > pool.max (2)
    let concurrentInsideExecute = 0;
    let maxConcurrent = 0;

    function makeContract(): EffectContract<Record<string, never>, unknown, unknown> {
      return {
        operationType: "test/pool-deadlock",
        capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
        retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
        async execute() {
          concurrentInsideExecute += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrentInsideExecute);
          await new Promise((resolve) => setTimeout(resolve, 100));
          concurrentInsideExecute -= 1;
          return { done: true };
        },
        async observe() {
          return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
        },
        reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
      };
    }

    const calls = Array.from({ length: identityCount }, (_, i) =>
      runEffect(store, makeContract(), {
        identity: { id: `pool-deadlock-${i}`, operationType: "test/pool-deadlock" },
        intent: {}
      })
    );

    const timeoutMs = 5000;
    const withTimeout = Promise.race([
      Promise.all(calls),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`possible deadlock: did not complete within ${timeoutMs}ms`)), timeoutMs)
      )
    ]);

    const results = (await withTimeout) as Awaited<ReturnType<typeof runEffect>>[];

    expect(results).toHaveLength(identityCount);
    for (const result of results) {
      expect(result.disposition).toBe("COMPLETE");
    }
    // With only 2 connections and 3 identities, at least 2 genuinely ran execute() at once —
    // proving this isn't accidentally serialized down to one-at-a-time either.
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });
});
