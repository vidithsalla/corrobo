import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import { OperationBusyError, ReviewNotAcceptedError, reviewEffect, runEffect } from "../src/core/runtime";
import { fingerprintIntent } from "../src/core/fingerprint";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { CoordinatedStore, EffectStore, OperationLock } from "../src/core/store";
import type { EffectResult, RecordedReview, ReviewDecision, RevalidationResult } from "../src/core/types";

/**
 * Model-based test of the review flow.
 *
 * Each seed drives random sequences of runEffect(), reviewEffect(), revalidate() verdicts,
 * transport outcomes (applied; a response that applied nothing; dropped; held in flight and
 * possibly landing late), observation outcomes (normal, failing, pending, conflicting), clock
 * jumps, crashes at store writes, calls made while another caller holds the lock, genuinely
 * concurrent calls, operations left by corrobo 0.3.x/0.4.0, and a 0.4.0 worker still running
 * during a rolling upgrade.
 *
 * The oracle is the point. It is built from the test's own inputs, never from corrobo's record:
 * it knows when authorize() asked for review, which revalidate() verdict it handed out, which
 * decisions it sent and when, which review tokens it was shown and when each review began.
 * Corrobo's results and records are only ever checked against it. (The one exception: after a
 * genuinely concurrent pair of calls, the oracle re-reads the review state from the record,
 * because it can't know which call won; its effect, overlap and authorization checks, made at
 * the moment of each execute(), stay independent.) It asserts:
 *
 * - effects: at most one effect from corrobo per operation (counted on the fake ledger); no two
 *   execute()s of one operation overlap; attempts are numbered 1..maxAttempts, consecutively;
 * - authorization: execute() never runs after the operation closed, was rejected, or while its
 *   last evidence was PENDING; with revalidate(), only right after revalidate() said proceed in
 *   that call; for an operation that has ever needed review (including from authorize() at
 *   creation, independently of what corrobo reports), only under an approval the oracle saw
 *   accepted after the latest review began, before its effective expiry; an approval after
 *   earlier attempts re-observes first; recovery after a crash observes before anything else;
 * - ordering: revalidate() at most once per call, never after the call observed the effect;
 * - revalidate() input: the right attempt number, this call's context, the intent, and exactly
 *   the approval the oracle accepted (or none);
 * - transitions: revalidate() verdicts, authorize(), decisions and expiries produce the
 *   specified states (reject closes; a failure leaves it open; requiresReview or expiry goes to
 *   review; approval opens; rejection closes; nothing enters review without a reason);
 * - review tokens: one stable token per review, never reused across reviews or operations; a
 *   result reports one exactly while a review is open;
 * - decisions: reviewEffect() accepts exactly the decisions that answer the open review (the
 *   current token, not dated before the review began, the right intent, not already expired),
 *   refuses the rest with the specified code, rejects malformed ones as TypeError without
 *   changing anything, never executes, and records exactly what was decided (also on the
 *   attempt it allowed).
 *
 * A failure prints the seed and the action trace. Re-run one seed with CORROBO_MODEL_SEED=<n>;
 * scale with CORROBO_MODEL_SEEDS / CORROBO_MODEL_STEPS; write coverage to CORROBO_MODEL_STATS.
 */

const MAX_IN_FLIGHT_MS = 5_000;
const MAX_ATTEMPTS = 4;
const OPERATION_TYPE = "model/refund";
const START = Date.parse("2026-10-02T12:00:00.000Z");

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    weighted: <T extends string>(table: Record<T, number>): T => {
      const entries = Object.entries(table) as [T, number][];
      let r = next() * entries.reduce((n, [, w]) => n + w, 0);
      for (const [k, w] of entries) if ((r -= w) < 0) return k;
      return entries[entries.length - 1][0];
    }
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "SimulatedCrash";
  }
}

type Transport = "applies" | "respondsNotApplied" | "drops" | "holds";
type ObserveMode = "normal" | "fails" | "pending" | "conflict";
type Verdict = "proceed" | "requiresReview" | "reject" | "throws" | "invalid" | "slowProceed" | "selfCheck";
type Shape = "fresh" | "v03Approved" | "v03ApprovedAfterRetry" | "v03Rejected" | "v04TokenlessApproved";

interface Approval {
  at: number; // event index when the oracle saw it accepted
  token: string;
  reviewer: string;
  expiresAtMs: number;
}

interface OpModel {
  id: string;
  shape: Shape;
  needsReviewAtCreation: boolean;
  created: boolean;
  // review (from the oracle's own knowledge)
  everNeededReview: boolean;
  inReview: boolean;
  reviewOpenedAt: number; // event index the latest review began
  reviewOpenedAtMs: number | null;
  currentToken: string | null;
  generation: number;
  noOpenEpisode: boolean; // awaiting review, but corrobo has no open review yet (legacy)
  unattributedApproval: boolean; // an approval corrobo must not honour (0.3/0.4)
  approval: Approval | null;
  rejected: boolean;
  closed: boolean;
  // attempts
  reservations: number;
  inExecute: number;
  lastEvidence: string | null;
  pendingRecovery: boolean;
  landedSinceObserve: boolean;
  lastExecuteAt: number;
  lastObserveAt: number;
  /** With a custom fingerprint (which ignores memo): the memo of the request that created it. */
  recordedMemo: string | null;
}

interface CallState {
  actor: string;
  log: string[];
  verdict: Verdict | null; // what revalidate() decided in this call, if it was called
  sawEffect: boolean;
  approvalExpiredDuringRevalidate: boolean;
}

interface World {
  time: number;
  event: number;
  ledger: Map<string, number>;
  held: { id: string; landBy: number }[];
  transport: Transport;
  observeMode: ObserveMode;
  verdict: Verdict;
  crash: "afterReserve" | "beforeResolve" | null;
  executes: number;
  call: CallState | null;
  concurrent: boolean;
  tokenOwner: Map<string, { opId: string; generation: number }>;
  /** The contract's current maxInFlightMs (a deploy can change it mid-run). */
  window: number;
  trace: string[];
  violations: string[];
  stats: Record<string, number>;
}

function count(world: World, key: string) {
  world.stats[key] = (world.stats[key] ?? 0) + 1;
}

/** The store under test, with the virtual clock, crash points, and attempt-number checks. */
function instrument(inner: EffectStore, world: World, ops: Map<string, OpModel>): EffectStore {
  const violation = (msg: string) => world.violations.push(`event ${world.event}: ${msg}`);
  const wrap = (s: CoordinatedStore): CoordinatedStore =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "now") return async () => new Date(world.time);
        if (prop === "reserveAttempt") {
          return async (...args: Parameters<CoordinatedStore["reserveAttempt"]>) => {
            const [id, reserved] = args;
            const op = ops.get(id);
            const record = await target.reserveAttempt(...args);
            if (op) {
              if (reserved.attemptNumber !== op.reservations + 1) {
                violation(`${id}: attempt ${reserved.attemptNumber} reserved after ${op.reservations} attempts`);
              }
              if (reserved.attemptNumber > MAX_ATTEMPTS) violation(`${id}: attempt ${reserved.attemptNumber} > maxAttempts ${MAX_ATTEMPTS}`);
              op.reservations = reserved.attemptNumber;
              world.call?.log.push("reserve");
            }
            if (world.crash === "afterReserve") {
              world.crash = null;
              if (op) op.pendingRecovery = true;
              throw new SimulatedCrash("after the attempt was reserved");
            }
            return record;
          };
        }
        if (prop === "updateLatestAttempt") {
          return async (...args: Parameters<CoordinatedStore["updateLatestAttempt"]>) => {
            if (world.crash === "beforeResolve" && world.call?.log.includes("execute")) {
              world.crash = null;
              const op = ops.get(args[0]);
              if (op) op.pendingRecovery = true;
              throw new SimulatedCrash("before the outcome was saved");
            }
            return target.updateLatestAttempt(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  const outer = wrap(inner) as EffectStore;
  return new Proxy(outer, {
    get(target, prop, receiver) {
      if (prop === "tryAcquireLock") {
        return async (id: string): Promise<OperationLock | null> => {
          const lock = await inner.tryAcquireLock(id);
          return lock ? { store: wrap(lock.store), release: () => lock.release() } : null;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

/** Is this approval currently valid, in the oracle's own terms? */
function validApproval(op: OpModel, now: number): Approval | null {
  const a = op.approval;
  if (!a || op.unattributedApproval) return null;
  if (a.at < op.reviewOpenedAt) return null;
  if (now >= a.expiresAtMs) return null;
  return a;
}

type ModelIntent = { ref: string; memo: string };

function makeContract(
  world: World,
  ops: Map<string, OpModel>,
  options: { maxApprovalAgeMs?: number; withRevalidate: boolean; customFingerprint: boolean }
) {
  const violation = (msg: string) => world.violations.push(`event ${world.event}: ${msg}`);
  // With a custom fingerprint, two intents differing only in memo are the same operation, and
  // corrobo must keep acting on the memo it recorded, whatever later requests carry.
  const checkMemo = (where: string, intent: ModelIntent) => {
    const op = ops.get(intent.ref);
    if (op && options.customFingerprint && op.recordedMemo !== null && intent.memo !== op.recordedMemo) {
      violation(`${op.id}: ${where} got memo ${intent.memo}, recorded ${op.recordedMemo}`);
    }
  };
  return defineContract<ModelIntent, { actor: string }>()({
    operationType: OPERATION_TYPE,
    retryPolicy: { maxAttempts: MAX_ATTEMPTS, retryOnNotApplied: true },
    get maxInFlightMs() {
      return world.window;
    },
    ...(options.customFingerprint ? { fingerprintIntent: (intent: ModelIntent) => JSON.stringify({ ref: intent.ref }) } : {}),
    ...(options.maxApprovalAgeMs !== undefined ? { maxApprovalAgeMs: options.maxApprovalAgeMs } : {}),
    authorize: (intent) => ({ requiresReview: ops.get(intent.ref)!.needsReviewAtCreation }),
    ...(options.withRevalidate
      ? {
          revalidate: async ({ identity, intent, attemptNumber, approval, context, record }): Promise<RevalidationResult> => {
            await tick();
            const op = ops.get(identity.id)!;
            const call = world.call;
            if (!world.concurrent && call) {
              call.log.push("revalidate");
              if (call.log.filter((e) => e === "revalidate").length > 1) violation(`${op.id}: revalidate() twice in one call`);
              if (call.sawEffect) violation(`${op.id}: revalidate() after this call observed the effect`);
              if (context?.actor !== call.actor) violation(`${op.id}: revalidate() got context ${JSON.stringify(context)}, call actor ${call.actor}`);
            }
            if (intent.ref !== op.id) violation(`${op.id}: revalidate() got intent ${JSON.stringify(intent)}`);
            checkMemo("revalidate()", intent);
            if (attemptNumber !== op.reservations + 1) violation(`${op.id}: revalidate() for attempt ${attemptNumber} after ${op.reservations} attempts`);
            if (record.identity.id !== op.id) violation(`${op.id}: revalidate() got another record`);
            const expected = validApproval(op, world.time);
            if (!world.concurrent) {
              if (op.everNeededReview && !expected) violation(`${op.id}: revalidate() reached with no valid approval (it should have gone to review)`);
              if ((approval?.reviewToken ?? null) !== (expected?.token ?? null) || (approval?.reviewer ?? null) !== (expected?.reviewer ?? null)) {
                violation(`${op.id}: revalidate() got approval ${approval?.reviewer}/${approval?.reviewToken}, oracle has ${expected?.reviewer}/${expected?.token}`);
              }
            }
            const verdict = world.verdict;
            let decision: "proceed" | "requiresReview" | "reject" | "throw" | "invalid";
            switch (verdict) {
              case "proceed":
                decision = "proceed";
                break;
              case "slowProceed":
                world.time += 3_000; // a slow policy service
                if (expected && world.time >= expected.expiresAtMs && call) call.approvalExpiredDuringRevalidate = true;
                decision = "proceed";
                break;
              case "selfCheck":
                decision = approval && approval.reviewer === context?.actor ? "requiresReview" : "proceed";
                break;
              case "requiresReview":
                decision = "requiresReview";
                break;
              case "reject":
                decision = "reject";
                break;
              case "throws":
                decision = "throw";
                break;
              case "invalid":
                decision = "invalid";
                break;
            }
            world.trace.push(`    revalidate(attempt ${attemptNumber}) -> ${verdict}${decision !== verdict ? `=${decision}` : ""}`);
            if (call && !world.concurrent) {
              call.verdict = decision === "throw" ? "throws" : decision === "invalid" ? "invalid" : (decision as Verdict);
            }
            if (decision === "throw") throw new Error("policy service down");
            if (decision === "invalid") return { decision: "maybe" } as unknown as RevalidationResult;
            return { decision };
          }
        }
      : {}),
    execute: async ({ identity, attemptNumber, intent }) => {
      const op = ops.get(identity.id)!;
      checkMemo("execute()", intent);
      world.executes += 1;
      op.inExecute += 1;
      if (op.inExecute > 1) violation(`${op.id}: two execute() calls at once`);
      const call = world.call;
      // --- authorization, checked at the moment of the external call ---
      if (op.closed) violation(`${op.id}: execute() after the operation closed`);
      if (op.rejected) violation(`${op.id}: execute() after it was rejected`);
      if (op.lastEvidence === "PENDING") violation(`${op.id}: execute() while the last evidence was PENDING`);
      if (op.pendingRecovery) violation(`${op.id}: execute() after a crash, before observing what the crashed attempt did`);
      if (attemptNumber !== op.reservations) violation(`${op.id}: execute(attempt ${attemptNumber}) but ${op.reservations} reserved`);
      // Never re-send while an earlier request could still land (within the window it was sent
      // under), whether or not it ends up landing.
      const inFlight = world.held.find((h) => h.id === op.id && world.time < h.landBy);
      if (inFlight) violation(`${op.id}: execute() at ${world.time} while an earlier request could still land until ${inFlight.landBy}`);
      if (options.withRevalidate && call && !world.concurrent) {
        const n = call.log.length;
        if (call.log[n - 1] !== "reserve" || call.log[n - 2] !== "revalidate" || call.verdict !== "proceed") {
          violation(`${op.id}: execute() not right after revalidate() said proceed (log ${call.log.join(",")}, verdict ${call.verdict})`);
        }
      }
      if (op.everNeededReview) {
        if (!validApproval(op, world.time)) violation(`${op.id}: execute() for an operation that needed review, with no valid approval at ${world.time}`);
        if (op.approval && op.lastExecuteAt >= 0 && op.approval.at > op.lastExecuteAt && op.lastObserveAt < op.approval.at) {
          violation(`${op.id}: execute() after an approval that followed attempts, without observing again first`);
        }
        count(world, "execute under an approval");
        if (op.generation >= 2) count(world, "execute after a second review");
      }
      call?.log.push("execute");
      op.lastExecuteAt = world.event;
      count(world, "execute");
      const transport = world.transport;
      world.trace.push(`    execute(attempt ${attemptNumber}) -> ${transport}`);
      await tick();
      op.inExecute -= 1;
      switch (transport) {
        case "applies":
          world.ledger.set(identity.id, (world.ledger.get(identity.id) ?? 0) + 1);
          return { ok: true };
        case "respondsNotApplied":
          return { ok: false };
        case "drops":
          throw new Error("connection reset before the request was sent");
        case "holds":
          // It can land any time within the window it was sent under, whatever a later deploy says.
          world.held.push({ id: identity.id, landBy: world.time + world.window });
          throw new Error("timed out");
      }
    },
    observe: async ({ identity }) => {
      await tick();
      const op = ops.get(identity.id)!;
      const n = world.ledger.get(identity.id) ?? 0;
      op.lastObserveAt = world.event;
      if (op.pendingRecovery) {
        op.pendingRecovery = false;
        count(world, "crash, then recovery observed first");
      }
      if (op.landedSinceObserve && n > 0) {
        op.landedSinceObserve = false;
        count(world, "late landing found by a later observation");
      }
      world.call?.log.push("observe");
      if (n > 0 && world.call && !world.concurrent) world.call.sawEffect = true;
      const mode = world.observeMode;
      if (mode === "fails") throw new Error("read replica down");
      return observed({ n, mode }, { source: "ledger", authoritative: true });
    },
    reconcile: ({ observation }) => {
      if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "no read");
      const { n, mode } = observation.data;
      if (mode === "conflict") return reconciled("CONFLICTED", "CHANGED_UNDERNEATH", "the order changed underneath");
      if (mode === "pending" && n > 0) return reconciled("PENDING", "SETTLING", "accepted, not final");
      if (n === 0) return reconciled("NOT_APPLIED", "NONE", "none");
      if (n === 1) return reconciled("APPLIED", "ONE", "one");
      return reconciled("CONFLICTED", "MANY", "more than one");
    }
  });
}

/** Writes an operation as corrobo 0.3.x / 0.4.0 left it, so the run starts from real legacy shapes. */
async function seedLegacy(store: EffectStore, op: OpModel, world: World, contract: ReturnType<typeof makeContract>) {
  const identity = { id: op.id, operationType: OPERATION_TYPE };
  const now = new Date(world.time).toISOString();
  const reason = { code: "POLICY_REVIEW_REQUIRED", summary: "needs review (legacy)" };
  op.created = true;
  op.everNeededReview = true;
  op.recordedMemo = "seed";
  if (op.shape === "v03Rejected") {
    await store.createOperation({ identity, intent: { ref: op.id, memo: "seed" }, status: "CLOSED", reviewReason: reason });
    op.rejected = true;
    op.closed = true;
    return;
  }
  const created = await store.createOperation({ identity, intent: { ref: op.id, memo: "seed" }, status: "OPEN", reviewReason: reason });
  op.unattributedApproval = true;
  let version = created.version;
  if (op.shape === "v03ApprovedAfterRetry") {
    const reserved = await store.reserveAttempt(op.id, { attemptNumber: 1, startedAt: now }, version);
    const resolved = await store.updateLatestAttempt(
      op.id,
      {
        status: "RESOLVED",
        attemptNumber: 1,
        startedAt: now,
        updatedAt: now,
        transport: { ok: true, evidence: { ok: false } },
        observations: [{ status: "observed", data: { n: 0, mode: "normal" }, authoritative: true, source: "ledger", observedAt: now }],
        evidenceState: "NOT_APPLIED",
        evidenceReason: { code: "NONE", summary: "none" },
        disposition: "RETRY",
        dispositionReason: { code: "SAFE_RETRY", summary: "retry" }
      },
      "OPEN",
      reserved.version
    );
    version = resolved.version;
    op.lastExecuteAt = 0;
  }
  if (op.shape === "v04TokenlessApproved") {
    await store.updateOperation(
      op.id,
      {
        review: {
          decision: "approved",
          reviewer: "legacy",
          decidedAt: now,
          intentFingerprint: fingerprintIntent(contract, { ref: op.id, memo: "seed" }),
          recordedAt: now,
          attemptCount: 0
        } as unknown as RecordedReview
      },
      version
    );
  }
}

async function runSeed(
  seed: number,
  makeStore: () => Promise<EffectStore>,
  steps: number
): Promise<{ violations: string[]; trace: string[]; stats: Record<string, number> }> {
  const r = prng(seed);
  const world: World = {
    time: START,
    event: 0,
    ledger: new Map(),
    held: [],
    transport: "applies",
    observeMode: "normal",
    verdict: "proceed",
    crash: null,
    executes: 0,
    call: null,
    concurrent: false,
    tokenOwner: new Map(),
    window: MAX_IN_FLIGHT_MS,
    trace: [],
    violations: [],
    stats: {}
  };
  const violation = (msg: string) => world.violations.push(`event ${world.event}: ${msg}`);
  const ops = new Map<string, OpModel>();
  for (const n of [1, 2]) {
    const id = `s${seed}-op${n}`;
    ops.set(id, {
      id,
      shape: r.weighted({ fresh: 70, v03Approved: 8, v03ApprovedAfterRetry: 7, v03Rejected: 6, v04TokenlessApproved: 9 }),
      needsReviewAtCreation: r.chance(0.6),
      created: false,
      everNeededReview: false,
      inReview: false,
      reviewOpenedAt: -1,
      reviewOpenedAtMs: null,
      currentToken: null,
      generation: 0,
      noOpenEpisode: false,
      unattributedApproval: false,
      approval: null,
      rejected: false,
      closed: false,
      reservations: 0,
      inExecute: 0,
      lastEvidence: null,
      pendingRecovery: false,
      landedSinceObserve: false,
      lastExecuteAt: -1,
      lastObserveAt: -1,
      recordedMemo: null
    });
  }
  const maxApprovalAgeMs = r.chance(0.5) ? r.int(3_000, 12_000) : undefined;
  const withRevalidate = r.chance(0.8);
  const customFingerprint = r.chance(0.3);
  const contract = makeContract(world, ops, { maxApprovalAgeMs, withRevalidate, customFingerprint });
  const store = instrument(await makeStore(), world, ops);
  world.trace.push(`seed ${seed}: maxApprovalAgeMs=${maxApprovalAgeMs ?? "none"} revalidate=${withRevalidate} customFingerprint=${customFingerprint}`);
  for (const op of ops.values()) {
    if (op.shape !== "fresh") {
      await seedLegacy(store, op, world, contract);
      op.reservations = op.shape === "v03ApprovedAfterRetry" ? 1 : 0;
      world.trace.push(`  ${op.id} starts as ${op.shape}`);
    }
  }
  // With the default fingerprint every request repeats the recorded memo (anything else would be
  // a different intent); with the custom one, requests vary it and corrobo must ignore that.
  const memoOf = (op: OpModel) => op.recordedMemo ?? "m";
  const requestMemo = (op: OpModel) => (customFingerprint ? r.pick(["a", "b", "c"]) : memoOf(op));
  const fingerprintOf = (ref: string) => fingerprintIntent(contract, { ref, memo: memoOf(ops.get(ref) ?? ([...ops.values()][0])) });

  /** A new review the oracle accepts as begun: a new token, never seen anywhere before. */
  const reviewBegan = (op: OpModel, token: string) => {
    const owner = world.tokenOwner.get(token);
    if (owner) violation(`${op.id}: review token reused (it belonged to ${owner.opId}, review ${owner.generation})`);
    op.generation += 1;
    world.tokenOwner.set(token, { opId: op.id, generation: op.generation });
    op.everNeededReview = true;
    op.inReview = true;
    op.noOpenEpisode = false;
    op.reviewOpenedAt = world.event;
    op.reviewOpenedAtMs = world.time;
    op.currentToken = token;
    if (op.generation >= 2) count(world, "second review began");
  };

  /** Checks a runEffect() result against what the oracle expected of this call. */
  const checkRun = (
    op: OpModel,
    result: EffectResult<unknown>,
    call: CallState,
    opts: { readOnly: boolean; createdNow: boolean }
  ) => {
    if (op.closed && result.status !== "CLOSED") violation(`${op.id}: ${result.status} after it closed`);
    if (result.status !== "AWAITING_REVIEW" && result.reviewToken !== null) violation(`${op.id}: reviewToken while ${result.status}`);
    if (opts.readOnly) {
      // The call didn't hold the lock: it can only report. A token, if any, must be the open one.
      if (result.status === "AWAITING_REVIEW" && result.reviewToken !== null && result.reviewToken !== op.currentToken) {
        violation(`${op.id}: a read-only result reported token ${result.reviewToken}, open review is ${op.currentToken}`);
      }
      if (result.status === "AWAITING_REVIEW" && result.reviewToken === null && !op.noOpenEpisode) {
        violation(`${op.id}: a read-only result reported no token while review ${op.currentToken} is open`);
      }
      return;
    }
    const executed = call.log.includes("execute");
    if (call.verdict === "reject") {
      if (result.status !== "CLOSED" || result.disposition !== "REPLAN") violation(`${op.id}: revalidate() rejected, result ${result.status}/${result.disposition}`);
      op.rejected = true;
    }
    if ((call.verdict === "throws" || call.verdict === "invalid") && (result.status !== "OPEN" || result.dispositionReason.code !== "REVALIDATION_FAILED")) {
      violation(`${op.id}: revalidate() failed, result ${result.status}/${result.dispositionReason.code}`);
    }
    if (call.verdict === "requiresReview" && result.status !== "AWAITING_REVIEW") violation(`${op.id}: revalidate() asked for review, result ${result.status}`);
    if (call.approvalExpiredDuringRevalidate) {
      if (executed) violation(`${op.id}: executed after the approval expired during revalidate()`);
      else if (result.status === "AWAITING_REVIEW") count(world, "approval expired during revalidate(), back to review");
    }
    if (result.status === "AWAITING_REVIEW") {
      const token = result.reviewToken;
      if (token === null) {
        violation(`${op.id}: AWAITING_REVIEW without a reviewToken`);
        return;
      }
      if (op.inReview && op.currentToken === token) return; // the same review, still open
      if (op.inReview && op.currentToken !== null) violation(`${op.id}: new review token ${token} while review ${op.currentToken} was still open`);
      // A new review began: the oracle must know why.
      const expiredApproval = op.approval && !op.unattributedApproval && world.time >= op.approval.expiresAtMs;
      const reason =
        (opts.createdNow && op.needsReviewAtCreation) ||
        call.verdict === "requiresReview" ||
        call.approvalExpiredDuringRevalidate ||
        expiredApproval ||
        op.unattributedApproval ||
        op.noOpenEpisode;
      if (!reason) violation(`${op.id}: entered review with no reason the oracle knows (${result.dispositionReason.code})`);
      if (op.unattributedApproval) {
        if (result.dispositionReason.code === "APPROVAL_NOT_RECORDED") count(world, "legacy approval refused, new review");
        op.unattributedApproval = false;
        op.approval = null;
      }
      reviewBegan(op, token);
    } else {
      if (op.inReview && !executed) violation(`${op.id}: left review (${result.status}) without a decision`);
      op.inReview = false;
      op.currentToken = null;
    }
    if (result.status === "CLOSED") op.closed = true;
    op.lastEvidence = result.evidenceState;
  };

  for (let step = 0; step < steps; step++) {
    world.event += 1;
    const op = ops.get(r.pick([...ops.keys()]))!;
    const action = r.weighted({ run: 40, review: 28, advance: 12, land: 8, concurrent: 6, legacyReopen: 3, legacyApprove: 3, deploy: 6 });

    if (action === "deploy") {
      // A deploy changes the contract's maxInFlightMs; requests already in flight keep theirs.
      const before = world.window;
      // With a request in flight, shrink the window: the case a recorded window must withstand.
      world.window = world.held.length > 0 ? 1_000 : r.pick([1_000, 5_000, 15_000]);
      if (world.window < before && world.held.length > 0) count(world, "deploy shortened the window while a request was in flight");
      world.trace.push(`#${world.event} deploy: maxInFlightMs=${world.window}`);
      count(world, "deploy changed maxInFlightMs");
      continue;
    }

    if (action === "advance") {
      const ms = r.pick([200, 1_000, 3_000, 6_000, 25_000]);
      world.time += ms;
      world.trace.push(`#${world.event} advance ${ms}ms`);
      continue;
    }

    if (action === "land") {
      const landing = world.held.filter((h) => world.time < h.landBy);
      world.held = [];
      for (const h of landing) {
        world.ledger.set(h.id, (world.ledger.get(h.id) ?? 0) + 1);
        ops.get(h.id)!.landedSinceObserve = true;
      }
      world.trace.push(`#${world.event} land ${landing.map((h) => h.id).join(",") || "(nothing in flight)"}`);
      continue;
    }

    if (action === "legacyReopen" || action === "legacyApprove") {
      // A corrobo 0.4.0 worker during a rolling upgrade (same lock, version-checked writes).
      const lock = await store.tryAcquireLock(op.id);
      if (!lock) continue;
      try {
        const record = await lock.store.getOperation(op.id);
        if (action === "legacyReopen" && record?.status === "OPEN") {
          await lock.store.updateOperation(op.id, { status: "AWAITING_REVIEW", reviewReason: { code: "LEGACY", summary: "0.4.0" } }, record.version);
          world.trace.push(`#${world.event} 0.4.0 worker reopens review on ${op.id}`);
          count(world, "legacy reopen");
          op.everNeededReview = true;
          op.inReview = true;
          op.noOpenEpisode = true;
          op.currentToken = null;
          op.reviewOpenedAt = world.event;
          op.reviewOpenedAtMs = world.time;
        } else if (action === "legacyApprove" && record?.status === "AWAITING_REVIEW") {
          await lock.store.updateOperation(
            op.id,
            {
              status: "OPEN",
              review: {
                decision: "approved",
                reviewer: "legacy",
                decidedAt: new Date(world.time).toISOString(),
                intentFingerprint: fingerprintOf(op.id),
                recordedAt: new Date(world.time).toISOString(),
                attemptCount: record.attempts.length
              } as unknown as RecordedReview
            },
            record.version
          );
          world.trace.push(`#${world.event} 0.4.0 worker approves ${op.id} without a token`);
          count(world, "legacy approve");
          op.inReview = false;
          op.noOpenEpisode = false;
          op.currentToken = null;
          op.unattributedApproval = true;
        }
      } finally {
        await lock.release();
      }
      continue;
    }

    if (action === "concurrent") {
      // Two calls genuinely in flight at once (every callback yields, so they interleave).
      const other = r.chance(0.5) ? "run" : "review";
      world.concurrent = true;
      world.transport = r.weighted({ applies: 50, respondsNotApplied: 20, drops: 15, holds: 15 });
      world.observeMode = "normal";
      world.verdict = r.pick(["proceed", "proceed", "requiresReview"] as const);
      world.trace.push(`#${world.event} concurrent run + ${other} on ${op.id}`);
      count(world, `concurrent run + ${other}`);
      const run = () =>
        runEffect(store, contract, { identity: op.id, intent: { ref: op.id, memo: customFingerprint ? "c" : memoOf(op) }, context: { actor: "worker" } }).catch((e) => {
          if (e instanceof SimulatedCrash) return null;
          throw e;
        });
      const review = () =>
        reviewEffect(store, contract, {
          identity: op.id,
          decision: { decision: "approved", reviewer: "bob", reviewToken: op.currentToken ?? "none" }
        }).catch((e) => {
          if (e instanceof OperationBusyError || e instanceof ReviewNotAcceptedError || /no operation/.test(String(e))) return null;
          throw e;
        });
      const tokenBefore = op.currentToken;
      await Promise.all([run(), other === "run" ? run() : review()]);
      world.concurrent = false;
      // Re-read the review state (which call won is unknowable here); see the header comment.
      const record = await store.getOperation(op.id);
      if (record) {
        op.created = true;
        if (op.recordedMemo === null) op.recordedMemo = (record.intent as ModelIntent).memo === "c" || !customFingerprint ? (record.intent as ModelIntent).memo : "c";
        op.reservations = Math.max(op.reservations, record.attempts.length);
        if (record.review?.reviewer === "bob" && record.review.reviewToken === tokenBefore && tokenBefore !== null) {
          op.approval = {
            at: world.event,
            token: tokenBefore,
            reviewer: "bob",
            expiresAtMs: maxApprovalAgeMs !== undefined ? Date.parse(record.review.recordedAt) + maxApprovalAgeMs : Infinity
          };
          op.unattributedApproval = false;
        }
        const awaiting = record.status === "AWAITING_REVIEW";
        const episode = record.reviewEpisode;
        const open = awaiting && episode && record.review?.reviewToken !== episode.token ? episode.token : null;
        if (open && open !== op.currentToken) {
          if (world.tokenOwner.has(open)) op.currentToken = open;
          else reviewBegan(op, open);
        }
        op.inReview = awaiting;
        if (!awaiting) op.currentToken = null;
        if (record.status === "CLOSED") op.closed = true;
        const last = record.attempts[record.attempts.length - 1];
        op.lastEvidence = last && last.status === "RESOLVED" ? last.evidenceState : op.lastEvidence;
      }
      continue;
    }

    const heldLock = r.chance(0.06) ? await store.tryAcquireLock(op.id) : null;
    const readOnly = heldLock !== null;

    if (action === "run") {
      world.transport = r.weighted({ applies: 45, respondsNotApplied: 20, drops: 15, holds: 20 });
      world.observeMode = r.weighted({ normal: 84, fails: 4, pending: 9, conflict: 3 });
      world.verdict = r.weighted({ proceed: 41, requiresReview: 12, reject: 4, throws: 8, invalid: 4, slowProceed: 18, selfCheck: 13 });
      world.crash = r.chance(0.15) ? r.pick(["afterReserve", "beforeResolve", "beforeResolve"] as const) : null;
      // A crash while the request is still in flight is the case a later, shorter deploy window
      // must not shortcut, so make it common.
      if (world.crash === "beforeResolve" && r.chance(0.6)) world.transport = "holds";
      const actor = r.pick(["agent", "worker", "alice", "bob"]);
      const call: CallState = { actor, log: [], verdict: null, sawEffect: false, approvalExpiredDuringRevalidate: false };
      world.call = call;
      const createdNow = !op.created;
      const executesBefore = world.executes;
      world.trace.push(
        `#${world.event} run ${op.id} actor=${actor} transport=${world.transport} observe=${world.observeMode} revalidate=${world.verdict} crash=${world.crash ?? "no"}${readOnly ? " (lock held)" : ""}`
      );
      try {
        const memo = requestMemo(op);
        const createsIt = !op.created && !readOnly;
        if (createsIt) op.recordedMemo = memo; // the request that creates it records its memo
        const result = await runEffect(store, contract, { identity: op.id, intent: { ref: op.id, memo }, context: { actor } });
        if (!readOnly) op.created = true;
        world.trace.push(`    -> ${result.status} ${result.disposition ?? "-"} ${result.dispositionReason.code} [${call.log.join(",")}]`);
        count(world, `run: ${result.dispositionReason.code}`);
        if (readOnly && world.executes !== executesBefore) violation(`${op.id}: a call that didn't hold the lock executed`);
        if (createdNow && !readOnly && op.needsReviewAtCreation && result.status !== "AWAITING_REVIEW") {
          violation(`${op.id}: authorize() asked for review at creation, result ${result.status}`);
        }
        checkRun(op, result, call, { readOnly, createdNow });
        // Audit: the attempt this call made records the approval it ran under.
        if (world.executes !== executesBefore) {
          const latest = (await store.getOperation(op.id))?.attempts.at(-1);
          if (latest?.maxInFlightMs !== world.window) violation(`${op.id}: attempt recorded maxInFlightMs ${latest?.maxInFlightMs}, sent under ${world.window}`);
        }
        if (world.executes !== executesBefore && op.everNeededReview) {
          const record = await store.getOperation(op.id);
          const attempt = record?.attempts[record.attempts.length - 1];
          if (attempt?.check?.approval?.reviewToken !== op.approval?.token) {
            violation(`${op.id}: attempt records approval ${attempt?.check?.approval?.reviewToken}, oracle ${op.approval?.token}`);
          }
        }
      } catch (err) {
        if (!(err instanceof SimulatedCrash)) throw err;
        op.created = true; // crash points all come after the record is created
        world.trace.push(`    -> crashed (${(err as Error).message}) [${call.log.join(",")}]`);
        count(world, "crash");
      } finally {
        world.call = null;
        world.crash = null;
      }
    } else {
      // review: what a review screen might send
      const recordBefore = await store.getOperation(op.id);
      const other = [...ops.values()].find((o) => o !== op)!;
      const previousTokens = [...world.tokenOwner.entries()].filter(([t, o]) => o.opId === op.id && t !== op.currentToken).map(([t]) => t);
      const tokenSource = r.weighted({ current: 55, earlierReview: 15, otherOp: 8, garbage: 10, missing: 2 });
      const token =
        tokenSource === "current"
          ? (op.currentToken ?? "none-yet")
          : tokenSource === "earlierReview"
            ? previousTokens.length
              ? r.pick(previousTokens)
              : "none-yet"
            : tokenSource === "otherOp"
              ? (other.currentToken ?? "none-yet")
              : tokenSource === "garbage"
                ? "f".repeat(32)
                : undefined;
      const kind = r.weighted({ approved: 85, rejected: 15 });
      const decidedAtChoice = r.weighted({ omitted: 55, now: 20, beforeReview: 15, malformed: 3, withNote: 7 });
      const openedAtMs = op.reviewOpenedAtMs;
      const decidedAtMs =
        decidedAtChoice === "omitted" || decidedAtChoice === "malformed"
          ? null
          : decidedAtChoice === "beforeReview"
            ? (openedAtMs ?? world.time) - r.int(1, 5_000)
            : world.time;
      const expiresChoice = kind === "approved" ? r.weighted({ none: 50, later: 40, past: 10 }) : "none";
      const expiresAtMs = expiresChoice === "none" ? null : expiresChoice === "later" ? world.time + r.int(500, 15_000) : world.time - 1;
      const fingerprintChoice = r.weighted({ none: 70, matching: 14, mismatching: 10, wrongType: 3, otherRule: 3 });
      const reviewer = r.pick(["alice", "bob", "carol"]);
      const note = decidedAtChoice === "withNote" ? `checked at ${world.time}` : undefined;
      const decision: Record<string, unknown> = { decision: kind, reviewer };
      if (token !== undefined) decision.reviewToken = token;
      if (decidedAtChoice === "malformed") decision.decidedAt = "yesterday";
      else if (decidedAtMs !== null) decision.decidedAt = new Date(decidedAtMs).toISOString();
      if (expiresAtMs !== null && (decidedAtMs === null || expiresAtMs > decidedAtMs)) decision.expiresAt = new Date(expiresAtMs).toISOString();
      if (note) decision.note = note;
      if (fingerprintChoice === "matching") decision.intentFingerprint = fingerprintOf(op.id);
      if (fingerprintChoice === "mismatching") decision.intentFingerprint = fingerprintOf(other.id);
      if (fingerprintChoice === "otherRule") decision.intentFingerprint = JSON.stringify({ ref: op.id, extra: true });
      if (fingerprintChoice === "wrongType") decision.intentFingerprint = 42;
      world.trace.push(
        `#${world.event} review ${op.id} ${kind} by ${reviewer} token=${tokenSource} decidedAt=${decidedAtChoice} expires=${decision.expiresAt ? expiresChoice : "none"} fingerprint=${fingerprintChoice}${readOnly ? " (lock held)" : ""}`
      );

      // The oracle's expectation, from its own knowledge only.
      const malformed = token === undefined || decidedAtChoice === "malformed" || fingerprintChoice === "wrongType";
      const recordedAtMs = world.time;
      const effectiveExpiry = Math.min(
        decision.expiresAt ? expiresAtMs! : Infinity,
        maxApprovalAgeMs !== undefined ? Math.min(decidedAtMs ?? recordedAtMs, recordedAtMs) + maxApprovalAgeMs : Infinity
      );
      const answersOpenReview = op.inReview && !op.noOpenEpisode && op.currentToken !== null && token === op.currentToken;
      const expected: string =
        !op.created || !answersOpenReview
          ? "refuse:any"
          : decidedAtMs !== null && openedAtMs !== null && decidedAtMs < openedAtMs
            ? "refuse:DECIDED_BEFORE_REVIEW_OPENED"
            : fingerprintChoice === "mismatching" || fingerprintChoice === "otherRule"
              ? "refuse:INTENT_MISMATCH"
              : kind === "approved" && effectiveExpiry <= recordedAtMs
                ? "refuse:APPROVAL_ALREADY_EXPIRED"
                : "accept";

      const executesBefore = world.executes;
      const unchanged = async () => {
        const after = await store.getOperation(op.id);
        if (JSON.stringify(after) !== JSON.stringify(recordBefore)) violation(`${op.id}: a refused decision changed the record`);
      };
      try {
        const result = await reviewEffect(store, contract, { identity: op.id, decision: decision as unknown as ReviewDecision });
        world.trace.push(`    -> accepted: ${result.status} ${result.dispositionReason.code}`);
        count(world, `review accepted: ${kind}`);
        if (readOnly) violation(`${op.id}: a decision was recorded while another caller held the lock`);
        if (malformed) violation(`${op.id}: a malformed decision was accepted`);
        if (expected !== "accept") violation(`${op.id}: accepted a decision the oracle expected refused (${expected}; token=${tokenSource})`);
        if (world.executes !== executesBefore) violation(`${op.id}: reviewEffect() executed something`);
        if (kind === "approved" && (result.status !== "OPEN" || result.dispositionReason.code !== "REVIEW_APPROVED")) {
          violation(`${op.id}: approval accepted, result ${result.status}/${result.dispositionReason.code}`);
        }
        if (kind === "rejected" && result.status !== "CLOSED") violation(`${op.id}: rejection accepted, result ${result.status}`);
        if (result.reviewToken !== null) violation(`${op.id}: reviewToken after a decision`);
        // Audit: exactly what was decided is what was recorded.
        const stored = (await store.getOperation(op.id))?.review as unknown as Record<string, unknown> | undefined;
        const want: Record<string, unknown> = {
          decision: kind,
          reviewer,
          reviewToken: token,
          decidedAt: new Date(decidedAtMs ?? recordedAtMs).toISOString(),
          recordedAt: new Date(recordedAtMs).toISOString(),
          attemptCount: op.reservations,
          intentFingerprint: fingerprintOf(op.id),
          expiresAt: decision.expiresAt,
          note
        };
        for (const [k, v] of Object.entries(want)) {
          if (stored?.[k] !== v) violation(`${op.id}: recorded review.${k} = ${JSON.stringify(stored?.[k])}, decided ${JSON.stringify(v)}`);
        }
        op.inReview = false;
        op.currentToken = null;
        if (kind === "approved") {
          op.approval = { at: world.event, token: token!, reviewer, expiresAtMs: effectiveExpiry };
          op.unattributedApproval = false;
        } else {
          op.rejected = true;
          op.closed = true;
        }
      } catch (err) {
        if (err instanceof OperationBusyError) {
          world.trace.push(`    -> busy`);
          count(world, "review busy");
          if (!readOnly) violation(`${op.id}: OperationBusyError with no other caller holding the lock`);
          await unchanged();
        } else if (err instanceof TypeError) {
          world.trace.push(`    -> TypeError`);
          count(world, "review malformed");
          if (!malformed) violation(`${op.id}: TypeError for a well-formed decision: ${err.message}`);
          await unchanged();
        } else if (!op.created && err instanceof Error && /no operation/.test(err.message)) {
          world.trace.push(`    -> no operation yet`);
        } else if (err instanceof ReviewNotAcceptedError) {
          world.trace.push(`    -> refused (${err.code})`);
          count(world, `review refused: ${err.code}`);
          if (tokenSource === "earlierReview" && err.code === "STALE_REVIEW_TOKEN" && previousTokens.includes(token!)) {
            count(world, "an earlier review's real token refused");
          }
          if (malformed) violation(`${op.id}: malformed decision refused as ${err.code} instead of TypeError`);
          else if (!readOnly && expected === "accept") violation(`${op.id}: refused a decision the oracle expected accepted (${err.code})`);
          else if (!readOnly && expected !== "refuse:any" && err.code !== expected.slice("refuse:".length)) {
            violation(`${op.id}: refused as ${err.code}, oracle expected ${expected.slice("refuse:".length)}`);
          }
          if (recordBefore && err.current.status !== recordBefore.status) violation(`${op.id}: error.current.status ${err.current.status}, record ${recordBefore.status}`);
          await unchanged();
        } else {
          throw err;
        }
      }
    }
    await heldLock?.release();

    for (const [id, n] of world.ledger) {
      if (n > 1) violation(`${id}: ${n} external effects`);
    }
    if (world.violations.length) break;
  }
  return { violations: world.violations, trace: world.trace, stats: world.stats };
}

function report(seed: number, outcome: { violations: string[]; trace: string[] }): string {
  return [
    `seed ${seed} (re-run with CORROBO_MODEL_SEED=${seed}):`,
    ...outcome.violations.map((v) => `  VIOLATION ${v}`),
    "  trace (last 60 lines):",
    ...outcome.trace.slice(-60).map((t) => `  ${t}`)
  ].join("\n");
}

const onlySeed = process.env.CORROBO_MODEL_SEED ? Number(process.env.CORROBO_MODEL_SEED) : undefined;
const seeds = (n: number, offset = 0) => (onlySeed !== undefined ? [onlySeed] : Array.from({ length: n }, (_, i) => i + 1 + offset));

/** Combinations the runs must actually reach (defined by the oracle, not by reason codes alone). */
const REQUIRED_COVERAGE = [
  "execute",
  "execute under an approval",
  "execute after a second review",
  "second review began",
  "approval expired during revalidate(), back to review",
  "an earlier review's real token refused",
  "late landing found by a later observation",
  "crash, then recovery observed first",
  "legacy approval refused, new review",
  "legacy reopen",
  "legacy approve",
  "concurrent run + run",
  "concurrent run + review",
  "review accepted: approved",
  "review accepted: rejected",
  "review busy",
  "review malformed",
  "review refused: STALE_REVIEW_TOKEN",
  "review refused: DECIDED_BEFORE_REVIEW_OPENED",
  "review refused: NOT_AWAITING_REVIEW",
  "review refused: APPROVAL_ALREADY_EXPIRED",
  "review refused: INTENT_MISMATCH",
  "run: APPROVAL_EXPIRED",
  "run: APPROVAL_NOT_RECORDED",
  "run: REVALIDATION_REQUIRES_REVIEW",
  "run: REVALIDATION_FAILED",
  "run: REVALIDATION_REJECTED",
  "run: AWAITING_CONVERGENCE",
  "run: EVIDENCE_INSUFFICIENT",
  "run: STATE_CONFLICT",
  "run: RETRY_NOT_SAFE_OR_EXHAUSTED",
  "deploy changed maxInFlightMs",
  "deploy shortened the window while a request was in flight"
];

describe("review flow: model-based (InMemoryStore)", () => {
  it("holds every invariant across 400 random seeds of 60 steps (CORROBO_MODEL_SEEDS for more)", async () => {
    const failures: string[] = [];
    const totals: Record<string, number> = {};
    for (const seed of seeds(Number(process.env.CORROBO_MODEL_SEEDS ?? 400))) {
      const outcome = await runSeed(seed, async () => new InMemoryStore(), Number(process.env.CORROBO_MODEL_STEPS ?? 60));
      for (const [k, v] of Object.entries(outcome.stats)) totals[k] = (totals[k] ?? 0) + v;
      if (outcome.violations.length) failures.push(report(seed, outcome));
      if (failures.length >= 3) break;
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
    if (onlySeed === undefined) {
      if (process.env.CORROBO_MODEL_STATS) writeFileSync(process.env.CORROBO_MODEL_STATS, JSON.stringify(totals, null, 2));
      for (const key of REQUIRED_COVERAGE) expect(totals[key] ?? 0, `coverage: ${key}`).toBeGreaterThanOrEqual(5);
    }
  }, 600_000);
});

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("review flow: model-based (PostgresStore)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await PostgresStore.migrate(pool);
    await pool.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("holds every invariant across 40 random seeds of 40 steps, persisted through Postgres", async () => {
    const failures: string[] = [];
    for (const seed of seeds(40, 10_000)) {
      const outcome = await runSeed(seed, async () => new PostgresStore(pool, { acknowledgePersistence: true }), 40);
      if (outcome.violations.length) failures.push(report(seed, outcome));
      if (failures.length >= 3) break;
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  }, 300_000);
});
