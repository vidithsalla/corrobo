import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { reviewEffect, runEffect } from "../src/core/runtime";
import { defineContract, observed, reconciled } from "../src/core/helpers";

type Intent = { orderId: string; amountCents: number; memo: string };

/**
 * A contract with a custom fingerprintIntent() may treat two intents as the same operation while
 * ignoring fields execute() reads. After the operation is recorded (and reviewed), a later
 * request with a different value in such a field must not change what is executed.
 */
function contract(executed: Intent[]) {
  return defineContract<Intent>()({
    operationType: "recorded/refund",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    authorize: () => ({ requiresReview: true }),
    fingerprintIntent: (i) => JSON.stringify({ orderId: i.orderId }), // ignores amount and memo
    execute: async ({ intent }) => {
      executed.push(intent);
      return {};
    },
    observe: async () => observed(executed.length, { source: "ledger", authoritative: true }),
    reconcile: ({ observation }) =>
      observation.status === "observed" && observation.data > 0 ? reconciled("APPLIED", "A", "a") : reconciled("NOT_APPLIED", "N", "n")
  });
}

describe("acting on the recorded intent", () => {
  it("with a custom fingerprint, a later request can't change what the reviewer approved", async () => {
    const executed: Intent[] = [];
    const store = new InMemoryStore();
    const c = contract(executed);
    const shown: Intent = { orderId: "1", amountCents: 500, memo: "as reviewed" };
    const waiting = await runEffect(store, c, { identity: "r1", intent: shown });
    await reviewEffect(store, c, { identity: "r1", decision: { decision: "approved", reviewer: "alice", reviewToken: waiting.reviewToken! } });

    // An agent re-sends the "same" operation with a bigger amount.
    const result = await runEffect(store, c, { identity: "r1", intent: { orderId: "1", amountCents: 50_000, memo: "changed" } });
    expect(result.disposition).toBe("COMPLETE");
    expect(executed).toEqual([shown]);
  });

  it("with the default fingerprint nothing changes: a different intent is refused outright", async () => {
    const executed: Intent[] = [];
    const store = new InMemoryStore();
    const { fingerprintIntent: _custom, ...c } = contract(executed);
    await runEffect(store, c, { identity: "r2", intent: { orderId: "1", amountCents: 500, memo: "a" } });
    await expect(runEffect(store, c, { identity: "r2", intent: { orderId: "1", amountCents: 500, memo: "b" } })).rejects.toThrow(
      /different intent/
    );
  });
});
