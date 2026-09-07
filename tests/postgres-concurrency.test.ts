import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Exercises the real Postgres advisory-lock coordination path: two SEPARATE connections
// (via two independently constructed PostgresStore/Pool instances, mirroring two separate
// processes) racing the same operation identity, forced to genuinely overlap with a barrier
// rather than relying on timing.
describe.skipIf(!connectionString)("PostgresStore concurrency (session advisory locks)", () => {
  let poolA: Pool;
  let poolB: Pool;

  beforeAll(async () => {
    poolA = new Pool({ connectionString });
    await PostgresStore.migrate(poolA);
  });

  beforeEach(async () => {
    await poolA.query("TRUNCATE corrobo_operations");
    poolB = new Pool({ connectionString }); // a genuinely separate connection pool, like a second process
  });

  afterEach(async () => {
    await poolB.end();
  });

  afterAll(async () => {
    await poolA.end();
  });

  it("CASE 1: two concurrent callers racing the SAME identity cause exactly one external mutation", async () => {
    const storeA = new PostgresStore(poolA);
    const storeB = new PostgresStore(poolB);
    const barrier = deferred<void>();
    const enteredExecute = deferred<void>();
    let executeCalls = 0;
    let mutationCount = 0;

    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/pg-race",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },
      async execute() {
        executeCalls += 1;
        enteredExecute.resolve();
        await barrier.promise;
        mutationCount += 1;
        return { done: true };
      },
      async observe() {
        return {
          status: "observed",
          data: { done: mutationCount > 0 },
          authoritative: true,
          source: "t",
          observedAt: new Date().toISOString()
        };
      },
      reconcile: ({ observation }) => {
        const data = observation.status === "observed" ? (observation.data as { done: boolean }) : undefined;
        return data?.done
          ? { evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "X", summary: "x" } };
      }
    };

    const identity = { id: "pg-race-1", operationType: contract.operationType };

    const callA = runEffect(storeA, contract, { identity, intent: {} });
    await enteredExecute.promise; // A now genuinely holds the advisory lock, mid-flight in execute()

    const callB = runEffect(storeB, contract, { identity, intent: {} });
    const resultB = await callB;

    expect(executeCalls).toBe(1); // B never entered execute() while A held the lock
    expect(resultB.disposition).not.toBe("COMPLETE");

    barrier.resolve();
    const resultA = await callA;
    expect(resultA.evidenceState).toBe("APPLIED");
    expect(resultA.disposition).toBe("COMPLETE");
    expect(mutationCount).toBe(1);

    // Both callers eventually see a result consistent with the single logical operation.
    const resultC = await runEffect(storeB, contract, { identity, intent: {} });
    expect(resultC.evidenceState).toBe("APPLIED");
    expect(resultC.disposition).toBe("COMPLETE");
    expect(executeCalls).toBe(1);
    expect(mutationCount).toBe(1);
  });

  it("CASE 2: different identities execute concurrently without serializing behind a global lock", async () => {
    const storeA = new PostgresStore(poolA);
    const storeB = new PostgresStore(poolB);
    const barrierA = deferred<void>();
    const barrierB = deferred<void>();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    let concurrentInsideExecute = 0;
    let maxConcurrent = 0;

    function makeContract(barrier: Promise<void>, entered: { resolve: () => void }): EffectContract<Record<string, never>, unknown, unknown> {
      return {
        operationType: "test/pg-parallel",
        capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
        retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },
        async execute() {
          concurrentInsideExecute += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrentInsideExecute);
          entered.resolve();
          await barrier;
          concurrentInsideExecute -= 1;
          return { done: true };
        },
        async observe() {
          return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
        },
        reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
      };
    }

    const callA = runEffect(storeA, makeContract(barrierA.promise, { resolve: () => enteredA.resolve() }), {
      identity: { id: "pg-parallel-a", operationType: "test/pg-parallel" },
      intent: {}
    });
    const callB = runEffect(storeB, makeContract(barrierB.promise, { resolve: () => enteredB.resolve() }), {
      identity: { id: "pg-parallel-b", operationType: "test/pg-parallel" },
      intent: {}
    });

    await Promise.all([enteredA.promise, enteredB.promise]);
    expect(maxConcurrent).toBe(2); // no accidental global serialization across different identities

    barrierA.resolve();
    barrierB.resolve();
    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA.disposition).toBe("COMPLETE");
    expect(resultB.disposition).toBe("COMPLETE");
  });

  it("CASE 3: a race resolving to PENDING does not cause a second execute(), and convergence still requires only one", async () => {
    const storeA = new PostgresStore(poolA);
    const storeB = new PostgresStore(poolB);
    const barrier = deferred<void>();
    const enteredExecute = deferred<void>();
    let executeCalls = 0;
    let converged = false;

    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/pg-pending-race",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: true },
      retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },
      async execute() {
        executeCalls += 1;
        enteredExecute.resolve();
        await barrier.promise;
        setTimeout(() => {
          converged = true;
        }, 150);
        return { done: true };
      },
      async observe() {
        const observedAt = new Date().toISOString();
        if (converged) {
          return { status: "observed" as const, data: { done: true }, authoritative: true, source: "t", observedAt };
        }
        return { status: "pending" as const, authoritative: true, source: "t", observedAt };
      },
      reconcile: ({ observation }) =>
        observation.status === "pending"
          ? { evidenceState: "PENDING", reason: { code: "WAIT", summary: "wait" } }
          : { evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } }
    };

    const identity = { id: "pg-pending-race-1", operationType: contract.operationType };

    const callA = runEffect(storeA, contract, { identity, intent: {} });
    await enteredExecute.promise;
    const callB = runEffect(storeB, contract, { identity, intent: {} });
    const resultB = await callB;
    expect(executeCalls).toBe(1);
    expect(resultB.disposition).not.toBe("COMPLETE");

    barrier.resolve();
    const resultA = await callA;
    expect(resultA.evidenceState).toBe("PENDING");
    expect(resultA.disposition).toBeNull();
    expect(executeCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const resultC = await runEffect(storeB, contract, { identity, intent: {} });
    expect(resultC.evidenceState).toBe("APPLIED");
    expect(resultC.disposition).toBe("COMPLETE");
    expect(executeCalls).toBe(1); // still only ever one real execution
  });

  it("CASE 5: a race resolving to UNKNOWN does not turn coordination into an unsafe second execution", async () => {
    const storeA = new PostgresStore(poolA);
    const storeB = new PostgresStore(poolB);
    const barrier = deferred<void>();
    const enteredExecute = deferred<void>();
    let executeCalls = 0;

    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/pg-unknown-race",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },
      async execute() {
        executeCalls += 1;
        enteredExecute.resolve();
        await barrier.promise;
        throw new Error("ambiguous network failure");
      },
      async observe() {
        throw new Error("read-back also failed");
      },
      reconcile: ({ observation }) =>
        observation.status === "observation_failed"
          ? { evidenceState: "UNKNOWN", reason: { code: "READBACK_UNAVAILABLE", summary: "read-back failed" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "UNREACHABLE", summary: "should not be reached" } }
    };

    const identity = { id: "pg-unknown-race-1", operationType: contract.operationType };

    const callA = runEffect(storeA, contract, { identity, intent: {} });
    await enteredExecute.promise;
    const callB = runEffect(storeB, contract, { identity, intent: {} });
    const resultB = await callB;
    expect(executeCalls).toBe(1);
    expect(resultB.disposition).not.toBe("COMPLETE");
    expect(resultB.disposition).not.toBe("RETRY"); // B must never independently decide to retry/execute

    barrier.resolve();
    const resultA = await callA;
    expect(resultA.evidenceState).toBe("UNKNOWN");
    expect(resultA.disposition).toBe("INVESTIGATE");
    expect(executeCalls).toBe(1); // the ambiguity was never "resolved" by trying again automatically
  });
});
