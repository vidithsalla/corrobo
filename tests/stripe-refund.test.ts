import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { reviewEffect, runEffect } from "../src/core/runtime";
import { createRefundContract, idempotencyKeyFor } from "../examples/stripe-refund/contract";
import { FakeStripeClient } from "../examples/stripe-refund/fake-stripe-client";
import { tokenOf } from "./support/review-token";

describe("Stripe refund example", () => {
  it("normal success -> APPLIED / COMPLETE", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_1", 5000);
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-1", operationType: contract.operationType },
      intent: { chargeId: "ch_1", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);
  });

  it("HEADLINE: timeout after Stripe commits the refund does not create a duplicate", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_2", 5000);
    client.scheduleFault("ch_2", { createFailures: 1, mode: "afterCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-2", operationType: contract.operationType };
    const intent = { chargeId: "ch_2", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("APPLIED");
    expect(r1.disposition).toBe("COMPLETE");

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("timeout BEFORE Stripe ever processes the request: observe() only reads and finds nothing; the retry with the same key creates exactly one refund", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_3", 5000);
    client.scheduleFault("ch_3", { createFailures: 1, mode: "beforeCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-3", operationType: contract.operationType };
    const intent = { chargeId: "ch_3", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1).toMatchObject({ evidenceState: "NOT_APPLIED", disposition: "RETRY" });
    expect(client.createdRefundCount).toBe(0); // observing created nothing

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(r2.attempts).toHaveLength(2);
    expect(client.createdRefundCount).toBe(1);
    expect(new Set(client.idempotencyKeysReceived)).toEqual(new Set([idempotencyKeyFor("refund-3")]));
  });

  it("observe() never creates a refund: an approval that expired while the request was lost leads to review, not a refund", async () => {
    // The adversarial-review finding: observe() runs where nothing may be executed (crash
    // recovery, the re-check before a retry, after an approval expired). It used to replay
    // create-refund, which created the refund whenever the original request had been lost.
    const client = new FakeStripeClient();
    client.seedCharge("ch_3b", 2_000_000);
    client.scheduleFault("ch_3b", { createFailures: 1, mode: "beforeCommit" });
    let now = Date.parse("2026-10-02T12:00:00.000Z");
    class ClockStore extends InMemoryStore {
      async now() {
        return new Date(now);
      }
    }
    const store = new ClockStore();
    const contract = { ...createRefundContract({ client, reviewThresholdCents: 1_000_000 }), maxApprovalAgeMs: 60_000 };
    const identity = "refund-3b";
    const intent = { chargeId: "ch_3b", amountCents: 2_000_000 };

    const waiting = await runEffect(store, contract, { identity, intent });
    await reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewer: "ops", reviewToken: waiting.reviewToken! } });
    const lost = await runEffect(store, contract, { identity, intent }); // the request never reaches Stripe
    expect(lost).toMatchObject({ evidenceState: "NOT_APPLIED", disposition: "RETRY" });

    now += 61_000; // the approval ages out
    const readsBefore = client.reads;
    const after = await runEffect(store, contract, { identity, intent });
    expect(after).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_EXPIRED" } });
    expect(client.reads).toBeGreaterThan(readsBefore); // it did re-check Stripe, by reading
    expect(client.createdRefundCount).toBe(0); // and created nothing
  });

  it("a definitive rejection that is NOT a state conflict (e.g. an invalid charge) is NOT_APPLIED, safely retryable once fixed", async () => {
    const client = new FakeStripeClient(); // ch_11 not seeded yet -> resource_missing on first attempt
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-11", operationType: contract.operationType };
    const intent = { chargeId: "ch_11", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("NOT_APPLIED");
    expect(r1.disposition).toBe("RETRY");
    expect(client.createdRefundCount).toBe(0);

    client.seedCharge("ch_11", 5000); // the underlying problem is now fixed
    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);
  });

  it("reuses the same Stripe idempotency key across attempts of the same logical operation", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_4", 5000);
    client.scheduleFault("ch_4", { createFailures: 1, mode: "beforeCommit" });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-4", operationType: contract.operationType };
    const intent = { chargeId: "ch_4", amountCents: 5000 };

    await runEffect(store, contract, { identity, intent });
    await runEffect(store, contract, { identity, intent });

    const record = await store.getOperation("refund-4");
    expect(record?.attempts.map((a) => a.status)).toEqual(["RESOLVED", "RESOLVED"]); // a failed create, then a retry
    const observations = (record?.attempts ?? []).flatMap((a) => (a.status === "RESOLVED" ? a.observations : []));
    const refundId = observations
      .map((o) => (o as { data?: { refundId?: string } }).data?.refundId)
      .find((id) => id !== undefined);
    expect(refundId).toBeDefined();
    expect(client.getRefundState(refundId as string)).toBeDefined();
    // A single Stripe key was ever used for this logical operation, and it produced one refund.
    expect(client.idempotencyKeysReceived.length).toBeGreaterThanOrEqual(2); // the failed create + at least one more call
    expect(new Set(client.idempotencyKeysReceived).size).toBe(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("a NEW logical operation (new identity) never reuses an old idempotency key", () => {
    expect(idempotencyKeyFor("refund-a")).not.toBe(idempotencyKeyFor("refund-b"));
    expect(idempotencyKeyFor("refund-a")).toBe(idempotencyKeyFor("refund-a"));
  });

  it("async convergence: PENDING, then re-observe resolves to APPLIED with no second refund", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_5", 5000, { convergeAsync: true });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-5", operationType: contract.operationType };
    const intent = { chargeId: "ch_5", amountCents: 5000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.evidenceState).toBe("PENDING");
    expect(r1.disposition).toBeNull();
    expect(client.createdRefundCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(r2.disposition).toBe("COMPLETE");
    expect(r2.attempts).toHaveLength(1);
    expect(client.createdRefundCount).toBe(1);
  });

  it("observation failure (execute and the read-back both ambiguous) -> UNKNOWN / INVESTIGATE", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_6", 5000);
    client.scheduleFault("ch_6", { createFailures: 1, mode: "beforeCommit", listFailures: 1 });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-6", operationType: contract.operationType },
      intent: { chargeId: "ch_6", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(client.createdRefundCount).toBe(0);
  });

  it("a failed read-back on an otherwise-successful create is honestly UNKNOWN, not assumed APPLIED", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_6b", 5000);
    client.scheduleFault("ch_6b", { retrieveFailures: 1 });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-6b", operationType: contract.operationType },
      intent: { chargeId: "ch_6b", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(client.createdRefundCount).toBe(1); // the refund really was created; we just couldn't confirm it yet
  });

  it("a charge already refunded by something else -> CONFLICTED / REPLAN", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_7", 5000, { alreadyRefunded: true });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-7", operationType: contract.operationType },
      intent: { chargeId: "ch_7", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("CONFLICTED");
    expect(result.disposition).toBe("REPLAN");
  });

  it("a requested amount exceeding the refundable balance -> CONFLICTED / REPLAN", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_8", 100);
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-8", operationType: contract.operationType },
      intent: { chargeId: "ch_8", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("CONFLICTED");
    expect(result.disposition).toBe("REPLAN");
  });

  it("a terminal Stripe-side failure is modeled as NOT_APPLIED, not silently retried into success", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_9", 5000, { terminalFailure: true });
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, {
      identity: { id: "refund-9", operationType: contract.operationType },
      intent: { chargeId: "ch_9", amountCents: 5000 }
    });
    expect(result.evidenceState).toBe("NOT_APPLIED");
    expect(result.disposition).toBe("RETRY");
    expect(result.evidenceReason?.code).toBe("REFUND_TERMINALLY_FAILED");
  });

  it("refunds above the review threshold require authorization before Stripe is ever called", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_10", 2_000_000);
    const store = new InMemoryStore();
    const contract = createRefundContract({ client, reviewThresholdCents: 1_000_000 });
    const identity = { id: "refund-10", operationType: contract.operationType };
    const intent = { chargeId: "ch_10", amountCents: 2_000_000 };

    const r1 = await runEffect(store, contract, { identity, intent });
    expect(r1.disposition).toBe("REVIEW");
    expect(r1.evidenceState).toBeNull();
    expect(client.createdRefundCount).toBe(0);

    await reviewEffect(store, contract, { identity, decision: { decision: "approved", reviewToken: await tokenOf(store, identity), reviewer: "reviewer@example.com" } });

    const r2 = await runEffect(store, contract, { identity, intent });
    expect(r2.disposition).toBe("COMPLETE");
    expect(client.createdRefundCount).toBe(1);
  });

  it("once execute() itself returns a stable refund id, later re-observations retrieve it directly", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_14", 5000, { convergeAsync: true }); // no fault: execute() succeeds directly
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const identity = { id: "refund-14", operationType: contract.operationType };
    const intent = { chargeId: "ch_14", amountCents: 5000 };

    const first = await runEffect(store, contract, { identity, intent });
    expect(first.evidenceState).toBe("PENDING");
    expect(client.createdRefundCount).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const second = await runEffect(store, contract, { identity, intent });
    expect(second.evidenceState).toBe("APPLIED");
    expect(second.disposition).toBe("COMPLETE");
    expect(second.observation?.source).toBe("stripe:refunds");
    expect(client.createdRefundCount).toBe(1);
  });

  it("a lost response long after the attempt is still found by its metadata: no reliance on the idempotency key's retention", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_15", 5000);
    client.scheduleFault("ch_15", { createFailures: 1, mode: "afterCommit" }); // created, response lost
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, { identity: "refund-15", intent: { chargeId: "ch_15", amountCents: 5000 } });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(result.observation?.source).toBe("stripe:refunds");
    expect(client.idempotencyKeysReceived).toHaveLength(1); // found by reading, not by re-sending the key
    expect(client.createdRefundCount).toBe(1);
  });

  it("the read-back pages through a charge's refunds: ours behind 150 others is still found", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_16", 1_000_000);
    for (let i = 0; i < 150; i++) {
      await client.refunds.create({ charge: "ch_16", amount: 100, metadata: { corrobo_operation: `other-${i}` } }, { idempotencyKey: `k-${i}` });
    }
    client.scheduleFault("ch_16", { createFailures: 1, mode: "afterCommit" }); // ours is created, its response lost
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, { identity: "refund-16", intent: { chargeId: "ch_16", amountCents: 5000 } });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(client.createdRefundCount).toBe(151);
  });
});
