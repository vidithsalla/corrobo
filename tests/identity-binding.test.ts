import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

function makeContract(operationType: string): EffectContract<{ amount: number }, unknown, unknown> {
  return {
    operationType,
    capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    async execute() {
      return { done: true };
    },
    async observe() {
      return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
    },
    reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
  };
}

describe("operation identity must bind to the same logical operation", () => {
  it("same identity + same operationType + same intent -> normal reuse, no error", async () => {
    const store = new InMemoryStore();
    const contract = makeContract("test/refund");
    const identity = { id: "refund:same-1", operationType: contract.operationType };

    const r1 = await runEffect(store, contract, { identity, intent: { amount: 50 } });
    const r2 = await runEffect(store, contract, { identity, intent: { amount: 50 } });
    expect(r1.disposition).toBe("COMPLETE");
    expect(r2.disposition).toBe("COMPLETE");
  });

  it("same identity + different operationType -> loud conflict error, no execute", async () => {
    const store = new InMemoryStore();
    const refundContract = makeContract("test/refund");
    const cancelContract = makeContract("test/cancel");
    const identity = { id: "refund:conflict-1", operationType: refundContract.operationType };

    await runEffect(store, refundContract, { identity, intent: { amount: 50 } });

    await expect(
      runEffect(store, cancelContract, { identity: { id: identity.id, operationType: cancelContract.operationType }, intent: { amount: 50 } })
    ).rejects.toThrow(/already used with operationType/);
  });

  it("same identity + same operationType + different intent -> loud conflict error, never a silent stale result", async () => {
    const store = new InMemoryStore();
    const contract = makeContract("test/refund");
    const identity = { id: "refund:123", operationType: contract.operationType };

    const first = await runEffect(store, contract, { identity, intent: { amount: 50 } });
    expect(first.disposition).toBe("COMPLETE");

    // An accidental reuse of the same identity for a logically different request (e.g. $500
    // instead of $50) must never silently return the first refund's COMPLETE result.
    await expect(runEffect(store, contract, { identity, intent: { amount: 500 } })).rejects.toThrow(
      /already used with a different intent/
    );
  });

  it("the conflict check also applies to a caller who lost the coordination race", async () => {
    // Even the non-blocking "lock loser" path (which just reads cached state) must not hand
    // back a mismatched operation's result silently.
    const store = new InMemoryStore();
    const contract = makeContract("test/refund");
    const identity = { id: "refund:race-1", operationType: contract.operationType };
    await runEffect(store, contract, { identity, intent: { amount: 50 } });

    // Manually simulate holding the lock so the next call takes the "lock loser" branch.
    const lock = await store.tryAcquireLock(identity.id);
    expect(lock).not.toBeNull();
    try {
      await expect(runEffect(store, contract, { identity, intent: { amount: 999 } })).rejects.toThrow(
        /already used with a different intent/
      );
    } finally {
      await lock?.release();
    }
  });
});
