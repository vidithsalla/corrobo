import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { runEffect } from "../src/core/runtime";
import { canonicalStringify, fingerprintIntent } from "../src/core/fingerprint";
import type { EffectContract } from "../src/core/types";

describe("canonicalStringify / fingerprintIntent", () => {
  it("object key ordering does not change the fingerprint", () => {
    const a = { amountCents: 500, chargeId: "ch_1", reason: "requested_by_customer" };
    const b = { reason: "requested_by_customer", chargeId: "ch_1", amountCents: 500 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("nested key ordering does not change the fingerprint either", () => {
    const a = { chargeId: "ch_1", meta: { a: 1, b: 2 } };
    const b = { meta: { b: 2, a: 1 }, chargeId: "ch_1" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("array order DOES change the fingerprint — arrays are meaningful sequences, not sorted", () => {
    expect(canonicalStringify({ items: [1, 2, 3] })).not.toBe(canonicalStringify({ items: [3, 2, 1] }));
  });

  it("a genuinely different intent fingerprints differently", () => {
    expect(canonicalStringify({ chargeId: "ch_1", amountCents: 50 })).not.toBe(
      canonicalStringify({ chargeId: "ch_1", amountCents: 500 })
    );
  });

  it("fingerprintIntent uses the contract's own override when provided", () => {
    const contract = {
      fingerprintIntent: (intent: { chargeId: string; requestNonce: string }) => intent.chargeId
    };
    // Two intents that differ only in a field the override deliberately ignores still match.
    const fp1 = fingerprintIntent(contract, { chargeId: "ch_1", requestNonce: "a" });
    const fp2 = fingerprintIntent(contract, { chargeId: "ch_1", requestNonce: "b" });
    expect(fp1).toBe(fp2);

    // But a genuinely different chargeId still differs.
    const fp3 = fingerprintIntent(contract, { chargeId: "ch_2", requestNonce: "a" });
    expect(fp1).not.toBe(fp3);
  });

  it("fingerprintIntent falls back to canonicalStringify when no override is provided", () => {
    const contract = {};
    expect(fingerprintIntent(contract, { a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });
});

describe("runEffect honors a contract-provided fingerprintIntent override", () => {
  it("treats two intents differing only in an ignored field as the same logical operation", async () => {
    const store = new InMemoryStore();
    const contract: EffectContract<{ chargeId: string; requestNonce: string }, unknown, unknown> = {
      operationType: "test/fingerprint-override",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      fingerprintIntent: (intent) => intent.chargeId,
      async execute() {
        return { done: true };
      },
      async observe() {
        return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    };

    const identity = { id: "override-1", operationType: contract.operationType };
    const first = await runEffect(store, contract, { identity, intent: { chargeId: "ch_1", requestNonce: "a" } });
    expect(first.disposition).toBe("COMPLETE");

    // A different nonce alone must NOT be treated as a conflicting logical operation, because
    // the override deliberately fingerprints only chargeId.
    const second = await runEffect(store, contract, { identity, intent: { chargeId: "ch_1", requestNonce: "b" } });
    expect(second.disposition).toBe("COMPLETE");
  });
});
