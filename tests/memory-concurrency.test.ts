import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("InMemoryStore concurrency (single-process coordination)", () => {
  it("two overlapping runEffect() calls for the SAME identity cause exactly one execute()", async () => {
    const store = new InMemoryStore();
    const barrier = deferred<void>();
    const enteredExecute = deferred<void>();
    let executeCalls = 0;
    let mutationCount = 0;

    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/mem-race",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      async execute() {
        executeCalls += 1;
        enteredExecute.resolve(); // proves this caller now holds the lock and is mid-flight
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

    const identity = { id: "mem-race-1", operationType: contract.operationType };

    const callA = runEffect(store, contract, { identity, intent: {} });
    await enteredExecute.promise; // A is now guaranteed to be inside execute(), holding the lock

    const callB = runEffect(store, contract, { identity, intent: {} });
    const resultB = await callB;

    // B could not acquire the lock while A held it — it must not have executed a second time,
    // and must not report a false COMPLETE.
    expect(executeCalls).toBe(1);
    expect(resultB.disposition).not.toBe("COMPLETE");

    barrier.resolve();
    const resultA = await callA;
    expect(resultA.evidenceState).toBe("APPLIED");
    expect(resultA.disposition).toBe("COMPLETE");
    expect(mutationCount).toBe(1);
    expect(executeCalls).toBe(1);
  });

  it("two different identities execute concurrently without serializing behind each other", async () => {
    const store = new InMemoryStore();
    const barrierA = deferred<void>();
    const barrierB = deferred<void>();
    const enteredA = deferred<void>();
    const enteredB = deferred<void>();
    let concurrentInsideExecute = 0;
    let maxConcurrent = 0;

    function makeContract(
      barrier: Promise<void>,
      entered: { resolve: () => void }
    ): EffectContract<Record<string, never>, unknown, unknown> {
      return {
        operationType: "test/mem-parallel",
        capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
        retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
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

    const callA = runEffect(store, makeContract(barrierA.promise, { resolve: () => enteredA.resolve() }), {
      identity: { id: "mem-parallel-a", operationType: "test/mem-parallel" },
      intent: {}
    });
    const callB = runEffect(store, makeContract(barrierB.promise, { resolve: () => enteredB.resolve() }), {
      identity: { id: "mem-parallel-b", operationType: "test/mem-parallel" },
      intent: {}
    });

    await Promise.all([enteredA.promise, enteredB.promise]); // both are now confirmed mid-flight
    expect(maxConcurrent).toBe(2);

    barrierA.resolve();
    barrierB.resolve();
    const [resultA, resultB] = await Promise.all([callA, callB]);
    expect(resultA.disposition).toBe("COMPLETE");
    expect(resultB.disposition).toBe("COMPLETE");
  });
});
