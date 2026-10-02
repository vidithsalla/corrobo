import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { OperationBusyError, ReviewNotAcceptedError, reviewEffect, runEffect } from "../src/core/runtime";
import { fingerprintIntent } from "../src/core/fingerprint";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { EffectContract, RecordedReview, RevalidateInput, RevalidationResult, ReviewDecision } from "../src/core/types";
import { tokenOf } from "./support/review-token";

/**
 * Attributed review decisions (issue #28): who decided, when, until when, and for exactly which
 * intent, recorded on the operation and checked before every attempt. Effects are counted on
 * the fake ledger, never from corrobo's own record.
 */

class ClockStore extends InMemoryStore {
  time = Date.parse("2026-10-01T12:00:00.000Z");
  async now(): Promise<Date> {
    return new Date(this.time);
  }
  iso(offsetMs = 0): string {
    return new Date(this.time + offsetMs).toISOString();
  }
}

type Intent = { orderId: string; amountCents: number; memo?: string };
type Context = { actor: string };

function makeLedger() {
  const credits: string[] = [];
  let respondNotApplied = false;
  return {
    credits,
    respondNotAppliedOnce() {
      respondNotApplied = true;
    },
    async credit(ref: string) {
      if (respondNotApplied) {
        respondNotApplied = false;
        return { applied: false };
      }
      credits.push(ref);
      return { applied: true };
    },
    count: (ref: string) => credits.filter((c) => c === ref).length
  };
}

function makeContract(
  ledger: ReturnType<typeof makeLedger>,
  options: {
    revalidate?: (input: RevalidateInput<Intent, Context>) => RevalidationResult;
    fingerprintIntent?: (intent: Intent) => string;
  } = {}
) {
  return defineContract<Intent, Context>()({
    operationType: "payments/refund",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    authorize: () => ({ requiresReview: true }),
    execute: ({ identity }) => ledger.credit(identity.id),
    observe: async ({ identity }) => observed(ledger.count(identity.id), { source: "ledger", authoritative: true }),
    reconcile: ({ observation }) =>
      observation.status === "observed" && observation.data > 0
        ? reconciled("APPLIED", "REFUNDED", "refunded")
        : reconciled("NOT_APPLIED", "NONE", "none"),
    ...(options.revalidate ? { revalidate: options.revalidate } : {}),
    ...(options.fingerprintIntent ? { fingerprintIntent: options.fingerprintIntent } : {})
  });
}

const intent: Intent = { orderId: "1001", amountCents: 5_000 };

/** The two-step flow: the review screen records the decision, then a worker acts on it. */
async function decideThenRun(
  store: ClockStore,
  contract: EffectContract<Intent, any, any, Context>,
  id: string,
  decision: Omit<ReviewDecision, "reviewToken">,
  options: { context?: Context } = {}
) {
  await reviewEffect(store, contract, { identity: id, decision: { ...decision, reviewToken: await tokenOf(store, id) } });
  return runEffect(store, contract, { identity: id, intent, ...(options.context ? { context: options.context } : {}) });
}

async function awaitingReview(store: ClockStore, contract: EffectContract<Intent, any, any, Context>, id: string) {
  const waiting = await runEffect(store, contract, { identity: id, intent });
  expect(waiting.status).toBe("AWAITING_REVIEW");
  return waiting;
}

describe("review decisions are recorded and bound", () => {
  it("an approval is recorded with who, when and the intent it applies to, and the attempt it allowed carries it", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    const waiting = await awaitingReview(store, contract, "a1");

    store.time += 60_000; // the reviewer takes a minute
    const decidedAt = store.iso(-1_000);
    const result = await decideThenRun(store, contract, "a1", { decision: "approved", reviewer: "alice@example.com", decidedAt, note: "customer called" });

    const expected: RecordedReview = {
      decision: "approved",
      reviewer: "alice@example.com",
      decidedAt,
      note: "customer called",
      intentFingerprint: fingerprintIntent(contract, intent),
      reviewToken: waiting.reviewToken!,
      recordedAt: store.iso(),
      attemptCount: 0
    };
    expect(result.disposition).toBe("COMPLETE");
    expect(result.review).toEqual(expected);
    expect((await store.getOperation("a1"))?.review).toEqual(expected);
    expect(result.attempts[0].check).toEqual({
      outcome: "proceed",
      reason: { code: "REVIEW_APPROVED", summary: "Approved in review by alice@example.com." },
      approval: expected,
      attemptNumber: 1,
      checkedAt: store.iso()
    });
    expect(ledger.count("a1")).toBe(1);
  });

  it("decidedAt defaults to when corrobo records it, from the store's clock", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "a2");
    const result = await decideThenRun(store, contract, "a2", { decision: "approved", reviewer: "bob" });
    expect(result.review).toMatchObject({ decidedAt: store.iso(), recordedAt: store.iso() });
  });

  it("a rejection records who rejected it, says so in the result, and nothing is executed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a3");
    const result = await decideThenRun(store, contract, "a3", { decision: "rejected", reviewer: "carol", note: "duplicate request" });
    expect(result).toMatchObject({
      status: "CLOSED",
      disposition: "REVIEW",
      dispositionReason: { code: "POLICY_REVIEW_REJECTED" },
      review: { decision: "rejected", reviewer: "carol", note: "duplicate request" }
    });
    expect(result.dispositionReason.summary).toContain("by carol");
    // A closed operation's decision can't be replaced: a later one is refused, loudly.
    await expect(decideThenRun(store, contract, "a3", { decision: "approved", reviewer: "mallory" })).rejects.toMatchObject({
      name: "ReviewNotAcceptedError",
      code: "NOT_AWAITING_REVIEW"
    });
    expect((await store.getOperation("a3"))?.review?.reviewer).toBe("carol");
    expect(ledger.credits).toEqual([]);
  });

  it("an approval made for a different intent than the recorded one is refused, and nothing changes", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a4");
    const before = await store.getOperation("a4");

    const shown = { ...intent, amountCents: 500 }; // the reviewer was shown $5, not $50
    await expect(
      decideThenRun(store, contract, "a4", { decision: "approved", reviewer: "alice", intentFingerprint: fingerprintIntent(contract, shown) })
    ).rejects.toThrow(/different intent/);
    expect(await store.getOperation("a4")).toEqual(before);
    expect(ledger.credits).toEqual([]);

    const ok = await decideThenRun(store, contract, "a4", { decision: "approved", reviewer: "alice", intentFingerprint: fingerprintIntent(contract, intent) });
    expect(ok.disposition).toBe("COMPLETE");
    expect(ledger.count("a4")).toBe(1);
  });

  it("an approval that has already expired when it arrives is refused, and nothing changes", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a5");
    const before = await store.getOperation("a5");
    await expect(
      decideThenRun(store, contract, "a5", { decision: "approved", reviewer: "alice", expiresAt: store.iso() })
    ).rejects.toThrow(/expired/);
    expect(await store.getOperation("a5")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["no reviewer", { decision: "approved" }],
    ["an empty reviewer", { decision: "approved", reviewer: "  " }],
    ["an unknown decision", { decision: "maybe", reviewer: "alice" }],
    ["a decidedAt that isn't a date", { decision: "approved", reviewer: "alice", decidedAt: "yesterday" }],
    ["an expiresAt on a rejection", { decision: "rejected", reviewer: "alice", expiresAt: "2030-01-01T00:00:00Z" }],
    [
      "an expiresAt before decidedAt",
      { decision: "approved", reviewer: "alice", decidedAt: "2030-01-02T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z" }
    ],
    ["a non-string note", { decision: "approved", reviewer: "alice", note: 42 }],
    ["a non-ISO date", { decision: "approved", reviewer: "alice", expiresAt: "12/31/2099" }],
    ["a date that doesn't exist", { decision: "approved", reviewer: "alice", expiresAt: "2099-02-30T00:00:00Z" }],
    ["a time with no offset (host-timezone dependent)", { decision: "approved", reviewer: "alice", expiresAt: "2099-01-01T00:00:00" }],
    ["a date with no time", { decision: "approved", reviewer: "alice", decidedAt: "2026-10-01" }],
    ["a time an offset carries past year 9999", { decision: "approved", reviewer: "alice", expiresAt: "9999-12-31T23:59:59-23:59" }],
    ["a leap second (a JavaScript Date can't hold it)", { decision: "approved", reviewer: "alice", expiresAt: "2099-12-31T23:59:60Z" }],
    ["no reviewToken", { decision: "approved", reviewer: "alice", reviewToken: undefined }],
    ["an empty reviewToken", { decision: "approved", reviewer: "alice", reviewToken: "" }],
    ["a number", 1],
    ["null", null]
  ])("a malformed reviewDecision (%s) throws before anything is recorded or executed", async (_label, decision) => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a6");
    const before = await store.getOperation("a6");
    await expect(
      reviewEffect(store, contract, {
        identity: "a6",
        decision: (typeof decision === "object" && decision !== null
          ? { reviewToken: await tokenOf(store, "a6"), ...decision }
          : decision) as ReviewDecision
      })
    ).rejects.toThrow(TypeError);
    expect(await store.getOperation("a6")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it("each field of a decision is read once: a getter that changes its answer can't slip past validation", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a8");
    let reads = 0;
    const shifty = {
      get decision() {
        reads += 1;
        return reads === 1 ? "approved" : "maybe";
      },
      reviewer: "alice",
      reviewToken: await tokenOf(store, "a8")
    };
    const result = await reviewEffect(store, contract, { identity: "a8", decision: shifty as ReviewDecision });
    expect(reads).toBe(1);
    expect(result.review?.decision).toBe("approved");
  });

  it("times with an offset are recorded in one canonical UTC form", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "a9");
    const result = await decideThenRun(store, contract, "a9", {
        decision: "approved",
        reviewer: "alice",
        decidedAt: "2026-10-01T17:30:00+05:00",
        expiresAt: "2099-01-01T05:00:00.5+05:00"
      });
    expect(result.review).toMatchObject({ decidedAt: "2026-10-01T12:30:00.000Z", expiresAt: "2099-01-01T00:00:00.500Z" });
  });

  it("runEffect() refuses the reviewDecision field corrobo 0.3 took, and nothing is recorded or executed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "a7");
    const before = await store.getOperation("a7");
    for (const reviewDecision of ["approved", "rejected"]) {
      await expect(
        runEffect(store, contract, { identity: "a7", intent, reviewDecision } as unknown as Parameters<typeof runEffect>[2])
      ).rejects.toThrow(/reviewEffect/);
    }
    expect(await store.getOperation("a7")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });
});

describe("approvals are checked before every attempt", () => {
  it("an approval that expires before a later attempt sends it back to review instead of executing", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const revalidated: number[] = [];
    const contract = makeContract(ledger, {
      revalidate: ({ attemptNumber }) => {
        revalidated.push(attemptNumber);
        return { decision: "proceed" };
      }
    });
    await awaitingReview(store, contract, "e1");

    ledger.respondNotAppliedOnce(); // attempt 1 gets a response: not applied, RETRY
    const first = await decideThenRun(store, contract, "e1", { decision: "approved", reviewer: "alice", expiresAt: store.iso(60_000) });
    expect(first.disposition).toBe("RETRY");

    store.time += 60_000;
    const second = await runEffect(store, contract, { identity: "e1", intent });
    expect(second).toMatchObject({
      status: "AWAITING_REVIEW",
      disposition: "REVIEW",
      evidenceState: "NOT_APPLIED",
      dispositionReason: { code: "APPROVAL_EXPIRED" }
    });
    expect(second.attempts).toHaveLength(1);
    expect(revalidated).toEqual([1]); // corrobo's own check stopped it; revalidate() never saw an expired approval
    expect(ledger.credits).toEqual([]);

    const renewed = await decideThenRun(store, contract, "e1", { decision: "approved", reviewer: "bob", expiresAt: store.iso(60_000) });
    expect(renewed.disposition).toBe("COMPLETE");
    expect(renewed.attempts[1].check?.approval?.reviewer).toBe("bob");
    expect(ledger.count("e1")).toBe(1);
  });

  it("an approval that expires while revalidate() runs doesn't allow the attempt, and the attempt starts at the time it was checked", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let slow = true;
    const contract = makeContract(ledger, {
      revalidate: () => {
        if (slow) store.time += 2_000; // the policy service takes two seconds
        return { decision: "proceed" };
      }
    });
    await awaitingReview(store, contract, "e2");
    const result = await decideThenRun(store, contract, "e2", { decision: "approved", reviewer: "alice", expiresAt: store.iso(1_000) });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_EXPIRED" } });
    expect(result.attempts).toEqual([]);
    expect(ledger.credits).toEqual([]);

    slow = false;
    const renewed = await decideThenRun(store, contract, "e2", { decision: "approved", reviewer: "alice", expiresAt: store.iso(1_000) });
    expect(renewed.disposition).toBe("COMPLETE");
    expect(renewed.attempts[0].startedAt).toBe(renewed.attempts[0].check?.checkedAt);
    expect(ledger.count("e2")).toBe(1);
  });

  it.each([
    ["before its first attempt", false],
    ["after an attempt that asked for a retry", true]
  ])("an operation approved by corrobo 0.3.x (no recorded decision) needs a new review %s", async (_label, withRetry) => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    // What a 0.3.x approval left behind: OPEN, the review reason, and no record of the decision.
    await store.createOperation({
      identity: { id: "legacy", operationType: "payments/refund" },
      intent,
      status: "OPEN",
      reviewReason: { code: "POLICY_REVIEW_REQUIRED", summary: "needs review" }
    });
    if (withRetry) {
      ledger.respondNotAppliedOnce();
      const record = await store.getOperation("legacy");
      await store.reserveAttempt("legacy", { attemptNumber: 1, startedAt: store.iso() }, record!.version);
      const reserved = await store.getOperation("legacy");
      await ledger.credit("legacy"); // the not-applied response
      await store.updateLatestAttempt(
        "legacy",
        {
          status: "RESOLVED",
          attemptNumber: 1,
          startedAt: store.iso(),
          updatedAt: store.iso(),
          transport: { ok: true, evidence: { applied: false } },
          observations: [{ status: "observed", data: 0, authoritative: true, source: "ledger", observedAt: store.iso() }],
          evidenceState: "NOT_APPLIED",
          evidenceReason: { code: "NONE", summary: "none" },
          disposition: "RETRY",
          dispositionReason: { code: "SAFE_RETRY", summary: "retry" }
        },
        "OPEN",
        reserved!.version
      );
    }

    const result = await runEffect(store, contract, { identity: "legacy", intent });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_NOT_RECORDED" } });
    expect(ledger.credits).toEqual([]);

    const approved = await decideThenRun(store, contract, "legacy", { decision: "approved", reviewer: "alice" });
    expect(approved.disposition).toBe("COMPLETE");
    expect(ledger.count("legacy")).toBe(1);
  });

  it("revalidate() receives the approval and can enforce approver policy (no self-approval)", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const approvals: (RecordedReview | null)[] = [];
    const contract = makeContract(ledger, {
      revalidate: ({ approval, context }) => {
        approvals.push(approval);
        return approval?.reviewer === context?.actor
          ? { decision: "requiresReview", reason: { code: "SELF_APPROVAL", summary: "The requester can't approve their own refund." } }
          : { decision: "proceed" };
      }
    });
    await awaitingReview(store, contract, "p1");

    const self = await decideThenRun(store, contract, "p1", { decision: "approved", reviewer: "dave" }, { context: { actor: "dave" } });
    expect(self).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "SELF_APPROVAL" } });
    expect(ledger.credits).toEqual([]);

    const other = await decideThenRun(store, contract, "p1", { decision: "approved", reviewer: "erin" }, { context: { actor: "dave" } });
    expect(other.disposition).toBe("COMPLETE");
    expect(approvals.map((a) => a?.reviewer)).toEqual(["dave", "erin"]);
    expect(ledger.count("p1")).toBe(1);
  });

  it("revalidate() gets approval null when the operation never went through review", async () => {
    const seen: unknown[] = [];
    const contract = {
      ...makeContract(makeLedger(), {
        revalidate: ({ approval }) => {
          seen.push(approval);
          return { decision: "proceed" };
        }
      }),
      authorize: undefined
    };
    const result = await runEffect(new ClockStore(), contract, { identity: "p2", intent });
    expect(result.disposition).toBe("COMPLETE");
    expect(result.review).toBeNull();
    expect(seen).toEqual([null]);
    expect(result.attempts[0].check?.approval).toBeUndefined();
  });

  it("an approval whose intent no longer matches the recorded one (the fingerprint rules changed) goes back to review", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const v1 = makeContract(ledger);
    await awaitingReview(store, v1, "m1");
    ledger.respondNotAppliedOnce();
    await decideThenRun(store, v1, "m1", { decision: "approved", reviewer: "alice" });

    // A new deploy fingerprints intents differently (ignoring memo); the old approval's
    // fingerprint no longer names the recorded intent under the current rules.
    const v2 = makeContract(ledger, {
      fingerprintIntent: (i) => JSON.stringify({ orderId: i.orderId, amountCents: i.amountCents })
    });
    const second = await runEffect(store, v2, { identity: "m1", intent });
    expect(second).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_INTENT_MISMATCH" } });
    expect(ledger.credits).toEqual([]);
  });

  it("a crash after the approval is recorded but before the attempt: the next call checks the approval again", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "c1");
    // Simulate: the approval was recorded (status OPEN, review set), then the process died.
    const record = await store.getOperation("c1");
    await store.updateOperation(
      "c1",
      {
        status: "OPEN",
        review: {
          decision: "approved",
          reviewer: "alice",
          decidedAt: store.iso(),
          expiresAt: store.iso(1_000),
          intentFingerprint: fingerprintIntent(contract, intent),
          recordedAt: store.iso(),
          reviewToken: record!.reviewEpisode!.token,
          attemptCount: 0
        }
      },
      record!.version
    );
    store.time += 1_000;
    const result = await runEffect(store, contract, { identity: "c1", intent });
    expect(result.dispositionReason.code).toBe("APPROVAL_EXPIRED");
    expect(ledger.credits).toEqual([]);
  });
});

describe("reviewEffect(): deciding is separate from acting", () => {
  it("records the decision and does nothing else: no execute, no observe; runEffect() then makes the attempt", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let observes = 0;
    const base = makeContract(ledger);
    const contract = { ...base, observe: async (input: Parameters<typeof base.observe>[0]) => (observes++, base.observe(input)) };
    await awaitingReview(store, contract, "s1");

    const decided = await reviewEffect(store, contract, { identity: "s1", decision: { decision: "approved", reviewToken: await tokenOf(store, "s1"), reviewer: "alice" } });
    expect(decided).toMatchObject({
      status: "OPEN",
      disposition: null,
      dispositionReason: { code: "REVIEW_APPROVED" },
      attempts: [],
      review: { reviewer: "alice", attemptCount: 0 }
    });
    expect(decided.dispositionReason.summary).toContain("not attempted yet");
    expect(ledger.credits).toEqual([]);
    expect(observes).toBe(0);

    const done = await runEffect(store, contract, { identity: "s1", intent });
    expect(done.disposition).toBe("COMPLETE");
    expect(ledger.count("s1")).toBe(1);
  });

  it("while another call holds the operation it throws OperationBusyError and records nothing", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "s2");
    const before = await store.getOperation("s2");
    const lock = await store.tryAcquireLock("s2");
    try {
      await expect(
        reviewEffect(store, contract, { identity: "s2", decision: { decision: "approved", reviewToken: await tokenOf(store, "s2"), reviewer: "alice" } })
      ).rejects.toBeInstanceOf(OperationBusyError);
    } finally {
      await lock?.release();
    }
    expect(await store.getOperation("s2")).toEqual(before);
  });

  it("a decision on an operation that isn't awaiting review is refused loudly (ReviewNotAcceptedError), and nothing is recorded", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = { ...makeContract(ledger), authorize: undefined };
    await runEffect(store, contract, { identity: "s3", intent });
    const before = await store.getOperation("s3");
    const refused = reviewEffect(store, contract, { identity: "s3", decision: { decision: "approved", reviewToken: "t", reviewer: "alice" } });
    await expect(refused).rejects.toBeInstanceOf(ReviewNotAcceptedError);
    await expect(refused).rejects.toMatchObject({
      code: "NOT_AWAITING_REVIEW",
      current: { status: "CLOSED", disposition: "COMPLETE", review: null }
    });
    expect(await store.getOperation("s3")).toEqual(before);
    expect(ledger.count("s3")).toBe(1);
  });

  it("an unknown operation, or one of another operation type, is refused", async () => {
    const store = new ClockStore();
    const contract = makeContract(makeLedger());
    const decision: ReviewDecision = { decision: "approved", reviewer: "alice", reviewToken: "t" };
    await expect(reviewEffect(store, contract, { identity: "nope", decision })).rejects.toThrow(/no operation "nope"/);
    await expect(
      reviewEffect(store, contract, { identity: { id: "x", operationType: "other/type" }, decision })
    ).rejects.toThrow(/operationType/);
  });

  it("runEffect() refuses a decision object: decisions go through reviewEffect()", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "s4");
    const before = await store.getOperation("s4");
    await expect(
      runEffect(store, contract, {
        identity: "s4",
        intent,
        reviewDecision: { decision: "approved", reviewer: "agent" }
      } as unknown as Parameters<typeof runEffect>[2])
    ).rejects.toThrow(/reviewEffect/);
    expect(await store.getOperation("s4")).toEqual(before);
    expect(ledger.credits).toEqual([]);
  });

  it("approved after an attempt that got a not-applied response: the next runEffect() re-observes first, so an effect that appeared meanwhile isn't repeated", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let observes = 0;
    let reviewed = false;
    const base = makeContract(ledger, {
      revalidate: ({ attemptNumber }) => (attemptNumber === 1 || reviewed ? { decision: "proceed" } : { decision: "requiresReview" })
    });
    const contract = { ...base, authorize: undefined, observe: async (input: Parameters<typeof base.observe>[0]) => (observes++, base.observe(input)) };

    ledger.respondNotAppliedOnce();
    expect((await runEffect(store, contract, { identity: "s5", intent })).disposition).toBe("RETRY");
    expect((await runEffect(store, contract, { identity: "s5", intent })).status).toBe("AWAITING_REVIEW");

    ledger.credits.push("s5"); // the effect appears while the operation waits for review
    reviewed = true;
    const decided = await reviewEffect(store, contract, { identity: "s5", decision: { decision: "approved", reviewToken: await tokenOf(store, "s5"), reviewer: "alice" } });
    expect(decided.review?.attemptCount).toBe(1);
    expect(decided).toMatchObject({ status: "OPEN", disposition: null, dispositionReason: { code: "REVIEW_APPROVED" } });
    expect(decided.retryNotBefore).toBeNull();

    observes = 0;
    const result = await runEffect(store, contract, { identity: "s5", intent });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(observes).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(ledger.count("s5")).toBe(1);
  });

  it("a concurrent write while the decision is being recorded is OperationBusyError, and the decision isn't recorded", async () => {
    class RacingStore extends ClockStore {
      raced = false;
      override async updateOperation(...args: Parameters<ClockStore["updateOperation"]>) {
        if (!this.raced && args[1].review) {
          this.raced = true; // another pass writes first (its lock was lost, say)
          const current = await this.getOperation(args[0]);
          await super.updateOperation(args[0], { reviewReason: { code: "OTHER", summary: "other" } }, current!.version);
        }
        return super.updateOperation(...args);
      }
    }
    const store = new RacingStore();
    const contract = makeContract(makeLedger());
    await awaitingReview(store, contract, "s6");
    await expect(
      reviewEffect(store, contract, { identity: "s6", decision: { decision: "approved", reviewToken: await tokenOf(store, "s6"), reviewer: "alice" } })
    ).rejects.toBeInstanceOf(OperationBusyError);
    const record = await store.getOperation("s6");
    expect(record?.review).toBeUndefined();
    expect(record?.status).toBe("AWAITING_REVIEW");
  });

  it("a review record without attemptCount is treated as recent: the next runEffect() re-observes first", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    let observes = 0;
    const base = makeContract(ledger);
    const contract = { ...base, authorize: undefined, observe: async (input: Parameters<typeof base.observe>[0]) => (observes++, base.observe(input)) };
    ledger.respondNotAppliedOnce();
    await runEffect(store, contract, { identity: "s7", intent }); // attempt 1: not applied, RETRY
    const record = await store.getOperation("s7");
    const { attemptCount: _dropped, ...withoutCount } = {
      decision: "approved" as const,
      reviewer: "alice",
      decidedAt: store.iso(),
      intentFingerprint: fingerprintIntent(contract, intent),
      recordedAt: store.iso(),
      reviewToken: "t",
      attemptCount: 1
    };
    await store.updateOperation("s7", { review: withoutCount as RecordedReview }, record!.version);

    ledger.credits.push("s7"); // the effect appeared
    observes = 0;
    const result = await runEffect(store, contract, { identity: "s7", intent });
    expect(result).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(observes).toBe(1);
    expect(ledger.count("s7")).toBe(1);
  });

  it("an approval on record without a reviewer isn't honored: it needs a new review", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await awaitingReview(store, contract, "s8");
    const record = await store.getOperation("s8");
    await store.updateOperation(
      "s8",
      {
        status: "OPEN",
        review: {
          decision: "approved",
          reviewer: null as unknown as string,
          decidedAt: store.iso(),
          intentFingerprint: fingerprintIntent(contract, intent),
          recordedAt: store.iso(),
          reviewToken: "t",
          attemptCount: 0
        }
      },
      record!.version
    );
    const result = await runEffect(store, contract, { identity: "s8", intent });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_NOT_RECORDED" } });
    expect(ledger.credits).toEqual([]);
  });
});

describe("review tokens: a decision answers one review", () => {
  /** Review 1 approved by B, then revalidate() sends it to review again (review 2). */
  async function secondReview(store: ClockStore, ledger: ReturnType<typeof makeLedger>) {
    let reviews = 0;
    const contract = makeContract(ledger, {
      revalidate: ({ approval }) => {
        if (approval?.reviewer === "B" && reviews === 0) {
          reviews += 1;
          return { decision: "requiresReview", reason: { code: "AMOUNT_CHANGED_UPSTREAM", summary: "look again" } };
        }
        return { decision: "proceed" };
      }
    });
    const first = await runEffect(store, contract, { identity: "t1", intent });
    store.time += 60_000;
    await reviewEffect(store, contract, {
      identity: "t1",
      decision: { decision: "approved", reviewer: "B", reviewToken: first.reviewToken! }
    });
    store.time += 60_000;
    const second = await runEffect(store, contract, { identity: "t1", intent });
    expect(second.status).toBe("AWAITING_REVIEW");
    return { contract, first, second };
  }

  it("a decision made on an earlier review's screen can't approve a later review of the same operation (stale token)", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const { contract, first, second } = await secondReview(store, ledger);
    expect(second.reviewToken).not.toBe(first.reviewToken);

    // Reviewer A's screen still shows review 1; A decided before review 2 even began.
    const stale = reviewEffect(store, contract, {
      identity: "t1",
      decision: { decision: "approved", reviewer: "A", reviewToken: first.reviewToken!, decidedAt: store.iso(-90_000) }
    });
    await expect(stale).rejects.toBeInstanceOf(ReviewNotAcceptedError);
    await expect(stale).rejects.toMatchObject({ code: "STALE_REVIEW_TOKEN", current: { status: "AWAITING_REVIEW" } });

    const result = await runEffect(store, contract, { identity: "t1", intent });
    expect(result.status).toBe("AWAITING_REVIEW");
    expect(ledger.credits).toEqual([]);
    expect((await store.getOperation("t1"))?.review?.reviewer).toBe("B");
  });

  it("a decision dated before the current review began is refused even with the current token", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const { contract, second } = await secondReview(store, ledger);
    await expect(
      reviewEffect(store, contract, {
        identity: "t1",
        decision: { decision: "approved", reviewer: "A", reviewToken: second.reviewToken!, decidedAt: store.iso(-90_000) }
      })
    ).rejects.toMatchObject({ code: "DECIDED_BEFORE_REVIEW_OPENED" });
    expect(ledger.credits).toEqual([]);

    await reviewEffect(store, contract, {
      identity: "t1",
      decision: { decision: "approved", reviewer: "A", reviewToken: second.reviewToken! }
    });
    const done = await runEffect(store, contract, { identity: "t1", intent });
    expect(done.disposition).toBe("COMPLETE");
    expect(done.review).toMatchObject({ reviewer: "A", reviewToken: second.reviewToken });
    expect(ledger.count("t1")).toBe(1);
  });

  it("each review gets a new token (and generation), only while AWAITING_REVIEW, distinct across operations", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const { contract, first, second } = await secondReview(store, ledger);
    const episode = (await store.getOperation("t1"))?.reviewEpisode;
    expect(episode).toMatchObject({ generation: 2, token: second.reviewToken, openedAt: store.iso() });
    expect(first.reviewToken).toMatch(/^[0-9a-f]{32}$/);

    const other = await runEffect(store, contract, { identity: "t1-other", intent });
    expect(other.reviewToken).not.toBe(first.reviewToken);
    await expect(
      reviewEffect(store, contract, {
        identity: "t1-other",
        decision: { decision: "approved", reviewer: "A", reviewToken: second.reviewToken! }
      })
    ).rejects.toMatchObject({ code: "STALE_REVIEW_TOKEN" });

    await reviewEffect(store, contract, {
      identity: "t1",
      decision: { decision: "approved", reviewer: "A", reviewToken: second.reviewToken! }
    });
    const done = await runEffect(store, contract, { identity: "t1", intent });
    expect(done.reviewToken).toBeNull();
  });

  it("an expired approval opens a new review: the old token no longer answers it", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    const first = await runEffect(store, contract, { identity: "t2", intent });
    ledger.respondNotAppliedOnce();
    await reviewEffect(store, contract, {
      identity: "t2",
      decision: { decision: "approved", reviewer: "A", reviewToken: first.reviewToken!, expiresAt: store.iso(1_000) }
    });
    await runEffect(store, contract, { identity: "t2", intent }); // attempt 1: not applied
    store.time += 1_000;
    const expired = await runEffect(store, contract, { identity: "t2", intent });
    expect(expired).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_EXPIRED" } });
    expect(expired.reviewToken).not.toBe(first.reviewToken);
    await expect(
      reviewEffect(store, contract, {
        identity: "t2",
        decision: { decision: "approved", reviewer: "A", reviewToken: first.reviewToken! }
      })
    ).rejects.toMatchObject({ code: "STALE_REVIEW_TOKEN" });
    expect(ledger.credits).toEqual([]);
  });

  it("an operation that went to review before tokens existed gets one on its next runEffect()", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await store.createOperation({
      identity: { id: "t3", operationType: "payments/refund" },
      intent,
      status: "AWAITING_REVIEW",
      reviewReason: { code: "POLICY_REVIEW_REQUIRED", summary: "needs review" }
    });
    const waiting = await runEffect(store, contract, { identity: "t3", intent });
    expect(waiting.reviewToken).toMatch(/^[0-9a-f]{32}$/);
    expect((await store.getOperation("t3"))?.reviewEpisode?.generation).toBe(1);
    await reviewEffect(store, contract, {
      identity: "t3",
      decision: { decision: "approved", reviewer: "A", reviewToken: waiting.reviewToken! }
    });
    expect((await runEffect(store, contract, { identity: "t3", intent })).disposition).toBe("COMPLETE");
    expect(ledger.count("t3")).toBe(1);
  });

  it("an approval recorded without a token (corrobo 0.4.0) isn't honored after upgrading: a new review opens", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    const waiting = await runEffect(store, contract, { identity: "t4", intent });
    const record = await store.getOperation("t4");
    // What 0.4.0 left: approved, OPEN, a reviewer, no reviewToken (and, here, no episode either).
    await store.updateOperation(
      "t4",
      {
        status: "OPEN",
        reviewEpisode: null,
        review: {
          decision: "approved",
          reviewer: "A",
          decidedAt: store.iso(),
          intentFingerprint: fingerprintIntent(contract, intent),
          recordedAt: store.iso(),
          attemptCount: 0
        } as unknown as RecordedReview
      },
      record!.version
    );
    store.time += 1_000;
    const result = await runEffect(store, contract, { identity: "t4", intent });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_NOT_RECORDED" } });
    expect(result.reviewToken).toMatch(/^[0-9a-f]{32}$/);
    expect(result.reviewToken).not.toBe(waiting.reviewToken);
    expect(ledger.credits).toEqual([]);
  });

  it("a review already answered can't be answered again, even if the operation is put back to review without a new one", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    const first = await runEffect(store, contract, { identity: "t5", intent });
    ledger.respondNotAppliedOnce();
    await reviewEffect(store, contract, {
      identity: "t5",
      decision: { decision: "approved", reviewer: "B", reviewToken: first.reviewToken! }
    });
    await runEffect(store, contract, { identity: "t5", intent }); // attempt 1: not applied

    // A 0.4.0 worker sends it back to review, leaving the answered episode in place.
    const record = await store.getOperation("t5");
    await store.updateOperation(
      "t5",
      { status: "AWAITING_REVIEW", reviewReason: { code: "OLD_WORKER", summary: "look again" } },
      record!.version
    );
    expect((await store.getOperation("t5"))?.reviewEpisode?.token).toBe(first.reviewToken);

    // Before runEffect() opens a new review, the answered token is refused...
    await expect(
      reviewEffect(store, contract, {
        identity: "t5",
        decision: { decision: "approved", reviewer: "A", reviewToken: first.reviewToken! }
      })
    ).rejects.toMatchObject({ code: "STALE_REVIEW_TOKEN" });
    // ...and runEffect() opens a new one, whose token is the only one that counts.
    const reopened = await runEffect(store, contract, { identity: "t5", intent });
    expect(reopened.reviewToken).not.toBe(first.reviewToken);
    expect((await store.getOperation("t5"))?.reviewEpisode?.generation).toBe(2);
    await expect(
      reviewEffect(store, contract, {
        identity: "t5",
        decision: { decision: "approved", reviewer: "A", reviewToken: first.reviewToken! }
      })
    ).rejects.toMatchObject({ code: "STALE_REVIEW_TOKEN" });
    expect(ledger.credits).toEqual([]);
  });

  it("a review a 0.4.0 worker answered (no token) and then reopened can't be answered with its old token", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    const first = await runEffect(store, contract, { identity: "t6", intent });
    store.time += 1_000;
    // A 0.4.0 worker approves review 1 (recording no token)...
    let record = await store.getOperation("t6");
    await store.updateOperation(
      "t6",
      {
        status: "OPEN",
        review: {
          decision: "approved",
          reviewer: "B",
          decidedAt: store.iso(),
          intentFingerprint: fingerprintIntent(contract, intent),
          recordedAt: store.iso(),
          attemptCount: 0
        } as unknown as RecordedReview
      },
      record!.version
    );
    // ...then sends it back to review without opening a new one.
    store.time += 1_000;
    record = await store.getOperation("t6");
    await store.updateOperation("t6", { status: "AWAITING_REVIEW" }, record!.version);

    await expect(
      reviewEffect(store, contract, {
        identity: "t6",
        decision: { decision: "approved", reviewer: "A", reviewToken: first.reviewToken! }
      })
    ).rejects.toMatchObject({ code: "STALE_REVIEW_TOKEN" });
    const reopened = await runEffect(store, contract, { identity: "t6", intent });
    expect(reopened.reviewToken).not.toBe(first.reviewToken);
    expect(ledger.credits).toEqual([]);
  });
});

describe("maxApprovalAgeMs: approvals age out", () => {
  function agedContract(ledger: ReturnType<typeof makeLedger>, maxApprovalAgeMs: number) {
    return { ...makeContract(ledger), maxApprovalAgeMs };
  }

  it("an approval without expiresAt stops covering attempts once it is older than maxApprovalAgeMs", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = agedContract(ledger, 60_000);
    const waiting = await runEffect(store, contract, { identity: "g1", intent });
    ledger.respondNotAppliedOnce();
    await reviewEffect(store, contract, {
      identity: "g1",
      decision: { decision: "approved", reviewer: "A", reviewToken: waiting.reviewToken! }
    });
    expect((await runEffect(store, contract, { identity: "g1", intent })).disposition).toBe("RETRY");

    store.time += 60_000;
    const aged = await runEffect(store, contract, { identity: "g1", intent });
    expect(aged).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_EXPIRED" } });
    expect(aged.dispositionReason.metadata).toMatchObject({ because: "the contract's maxApprovalAgeMs of 60000" });
    expect(ledger.credits).toEqual([]);
  });

  it("the earlier of expiresAt and maxApprovalAgeMs wins, and age counts from decidedAt when that is earlier", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = agedContract(ledger, 60_000);
    const waiting = await runEffect(store, contract, { identity: "g2", intent });
    store.time += 30_000;
    // Decided 20s after the review opened, recorded 10s later, with a generous expiresAt.
    await reviewEffect(store, contract, {
      identity: "g2",
      decision: {
        decision: "approved",
        reviewer: "A",
        reviewToken: waiting.reviewToken!,
        decidedAt: store.iso(-10_000),
        expiresAt: store.iso(3_600_000)
      }
    });
    store.time += 50_000; // 60s after decidedAt, 50s after recording
    const result = await runEffect(store, contract, { identity: "g2", intent });
    expect(result).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_EXPIRED" } });
    expect(ledger.credits).toEqual([]);
  });

  it("an approval already older than maxApprovalAgeMs when it arrives is refused", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = agedContract(ledger, 60_000);
    const waiting = await runEffect(store, contract, { identity: "g3", intent });
    store.time += 120_000;
    await expect(
      reviewEffect(store, contract, {
        identity: "g3",
        decision: { decision: "approved", reviewer: "A", reviewToken: waiting.reviewToken!, decidedAt: store.iso(-61_000) }
      })
    ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_EXPIRED" });
  });

  it("within maxApprovalAgeMs the approval works as usual; an invalid maxApprovalAgeMs fails closed", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = agedContract(ledger, 60_000);
    const waiting = await runEffect(store, contract, { identity: "g4", intent });
    await reviewEffect(store, contract, {
      identity: "g4",
      decision: { decision: "approved", reviewer: "A", reviewToken: waiting.reviewToken! }
    });
    store.time += 59_000;
    expect((await runEffect(store, contract, { identity: "g4", intent })).disposition).toBe("COMPLETE");

    const bad = agedContract(ledger, -1);
    const waitingBad = await runEffect(store, bad, { identity: "g5", intent });
    await expect(
      reviewEffect(store, bad, { identity: "g5", decision: { decision: "approved", reviewer: "A", reviewToken: waitingBad.reviewToken! } })
    ).rejects.toThrow(/maxApprovalAgeMs/);
    expect(ledger.count("g5")).toBe(0);
  });

  it("a review opened in the same millisecond a 0.4.0 approval was recorded still has a usable token (found by the model test)", async () => {
    const store = new ClockStore();
    const ledger = makeLedger();
    const contract = makeContract(ledger);
    await runEffect(store, contract, { identity: "t7", intent });
    const record = await store.getOperation("t7");
    // A 0.4.0 worker approves without a token at time T...
    await store.updateOperation(
      "t7",
      {
        status: "OPEN",
        review: {
          decision: "approved",
          reviewer: "legacy",
          decidedAt: store.iso(),
          intentFingerprint: fingerprintIntent(contract, intent),
          recordedAt: store.iso(),
          attemptCount: 0
        } as unknown as RecordedReview
      },
      record!.version
    );
    // ...and 0.5 refuses it and opens a new review, also at time T.
    const waiting = await runEffect(store, contract, { identity: "t7", intent });
    expect(waiting).toMatchObject({ status: "AWAITING_REVIEW", dispositionReason: { code: "APPROVAL_NOT_RECORDED" } });
    expect(waiting.reviewToken).toMatch(/^[0-9a-f]{32}$/);
    await reviewEffect(store, contract, {
      identity: "t7",
      decision: { decision: "approved", reviewer: "A", reviewToken: waiting.reviewToken! }
    });
    expect((await runEffect(store, contract, { identity: "t7", intent })).disposition).toBe("COMPLETE");
    expect(ledger.count("t7")).toBe(1);
  });
});
