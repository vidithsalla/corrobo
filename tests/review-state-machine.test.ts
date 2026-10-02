import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import { OperationBusyError, ReviewNotAcceptedError, reviewEffect, runEffect } from "../src/core/runtime";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { CoordinatedStore, EffectStore, OperationLock } from "../src/core/store";
import type { EffectResult, ReviewDecision, RevalidationResult } from "../src/core/types";

/**
 * Model-based test of the review flow. Each seed drives random sequences of runEffect(),
 * reviewEffect(), revalidate() outcomes, transport outcomes (a response that applied nothing,
 * a dropped request, a request held in flight that may land late), clock jumps, crashes at
 * store write points, and calls made while another caller holds the operation's lock.
 *
 * An oracle, kept separately from corrobo's record, says what should be allowed, and every
 * execute() and every accepted or refused decision is checked against it:
 *
 * - at most one external effect per operation (counted on the fake ledger);
 * - execute() never runs after the operation closed or was rejected;
 * - with revalidate(), execute() runs only after revalidate() said proceed in that same call;
 * - an operation that has ever needed review executes only under an approval accepted after it
 *   last entered review, and before that approval's effective expiry;
 * - reviewEffect() accepts a decision only if it answers the review currently open (the token
 *   the latest AWAITING_REVIEW result reported), isn't dated before that review began, and isn't
 *   already expired; and it does accept every such decision (unless the operation is busy);
 * - reviewEffect() never executes; results report a review token exactly while awaiting review;
 *   CLOSED is terminal.
 *
 * A failure prints the seed and the action trace. Re-run one seed with CORROBO_MODEL_SEED=<n>.
 */

const MAX_IN_FLIGHT_MS = 5_000;
const MAX_ATTEMPTS = 4;

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
    next,
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

class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "SimulatedCrash";
  }
}

type Transport = "applies" | "respondsNotApplied" | "drops" | "holds";
type RevalidateBehavior = "proceed" | "requiresReview" | "reject" | "throws" | "invalid" | "slowProceed";

interface OpModel {
  id: string;
  needsReviewAtCreation: boolean;
  everNeededReview: boolean;
  enteredReviewAt: number; // event index of the latest entry into review
  reviewEntries: number;
  awaiting: boolean;
  currentToken: string | null;
  tokensSeen: string[];
  approval: { at: number; expiresAtMs: number; reviewer: string } | null;
  rejected: boolean;
  closed: boolean;
  revalidatedProceed: boolean;
  lastExecuteAt: number; // event index of the latest execute(), -1 if none
  lastObserveAt: number; // event index of the latest observe(), -1 if none
}

interface World {
  time: number;
  event: number;
  ledger: Map<string, number>;
  held: { id: string; landBy: number }[];
  nextTransport: Transport;
  nextRevalidate: RevalidateBehavior;
  crash: "afterReserve" | "beforeResolve" | null;
  executes: number;
  trace: string[];
  violations: string[];
  stats: Record<string, number>;
}

/** Coverage counters, so a run that never reaches the interesting states can't pass quietly. */
function count(world: World, key: string) {
  world.stats[key] = (world.stats[key] ?? 0) + 1;
}

/** Wraps a store so it reads the virtual clock and crashes on demand, in the lock's store too. */
function instrument(inner: EffectStore, world: World): EffectStore {
  const wrapCoordinated = (s: CoordinatedStore): CoordinatedStore =>
    new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "now") return async () => new Date(world.time);
        if (prop === "reserveAttempt") {
          return async (...args: Parameters<CoordinatedStore["reserveAttempt"]>) => {
            const record = await target.reserveAttempt(...args);
            if (world.crash === "afterReserve") {
              world.crash = null;
              throw new SimulatedCrash("after the attempt was reserved");
            }
            return record;
          };
        }
        if (prop === "updateLatestAttempt") {
          return async (...args: Parameters<CoordinatedStore["updateLatestAttempt"]>) => {
            if (world.crash === "beforeResolve") {
              world.crash = null;
              throw new SimulatedCrash("before the outcome was saved");
            }
            return target.updateLatestAttempt(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  const outer = wrapCoordinated(inner) as EffectStore;
  return new Proxy(outer, {
    get(target, prop, receiver) {
      if (prop === "tryAcquireLock") {
        return async (id: string): Promise<OperationLock | null> => {
          const lock = await inner.tryAcquireLock(id);
          return lock ? { store: wrapCoordinated(lock.store), release: () => lock.release() } : null;
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

function makeContract(world: World, ops: Map<string, OpModel>, options: { maxApprovalAgeMs?: number; withRevalidate: boolean }) {
  const violation = (msg: string) => world.violations.push(`event ${world.event}: ${msg}`);
  return defineContract<{ ref: string }, { actor: string }>()({
    operationType: "model/refund",
    retryPolicy: { maxAttempts: MAX_ATTEMPTS, retryOnNotApplied: true },
    maxInFlightMs: MAX_IN_FLIGHT_MS,
    ...(options.maxApprovalAgeMs !== undefined ? { maxApprovalAgeMs: options.maxApprovalAgeMs } : {}),
    authorize: (intent) => ({ requiresReview: ops.get(intent.ref)!.needsReviewAtCreation }),
    ...(options.withRevalidate
      ? {
          revalidate: ({ identity }): RevalidationResult => {
            const op = ops.get(identity.id)!;
            const behavior = world.nextRevalidate;
            world.trace.push(`    revalidate -> ${behavior}`);
            switch (behavior) {
              case "proceed":
                op.revalidatedProceed = true;
                return { decision: "proceed" };
              case "slowProceed":
                world.time += 3_000; // slow policy service: an approval may expire meanwhile
                op.revalidatedProceed = true;
                return { decision: "proceed" };
              case "requiresReview":
                return { decision: "requiresReview" };
              case "reject":
                return { decision: "reject" };
              case "throws":
                throw new Error("policy service down");
              case "invalid":
                return { decision: "maybe" } as unknown as RevalidationResult;
            }
          }
        }
      : {}),
    execute: async ({ identity }) => {
      world.executes += 1;
      const op = ops.get(identity.id)!;
      // --- the oracle's checks, at the moment of the external call ---
      if (op.closed) violation(`${op.id}: execute() after the operation was observed CLOSED`);
      if (op.rejected) violation(`${op.id}: execute() after a rejection was accepted`);
      if (options.withRevalidate && !op.revalidatedProceed) {
        violation(`${op.id}: execute() without revalidate() saying proceed in this call`);
      }
      op.revalidatedProceed = false;
      if (op.everNeededReview) {
        if (!op.approval) violation(`${op.id}: execute() for an operation that needed review, with no accepted approval`);
        else if (op.approval.at < op.enteredReviewAt) {
          violation(`${op.id}: execute() under an approval accepted before the operation last entered review`);
        } else if (world.time >= op.approval.expiresAtMs) {
          violation(`${op.id}: execute() at ${world.time} under an approval that expired at ${op.approval.expiresAtMs}`);
        }
        // An approval that came after an earlier attempt: time passed while it waited, so the
        // external system must have been looked at again before anything is re-sent.
        if (op.approval && op.lastExecuteAt >= 0 && op.approval.at > op.lastExecuteAt && op.lastObserveAt < op.approval.at) {
          violation(`${op.id}: execute() after an approval that followed attempts, without observing again first`);
        }
      }
      op.lastExecuteAt = world.event;
      const transport = world.nextTransport;
      world.trace.push(`    execute -> ${transport}`);
      count(world, "execute");
      if (op.everNeededReview) count(world, "execute under an approval");
      if (op.reviewEntries >= 2) count(world, "execute after a re-review");
      switch (transport) {
        case "applies":
          world.ledger.set(identity.id, (world.ledger.get(identity.id) ?? 0) + 1);
          return { ok: true };
        case "respondsNotApplied":
          return { ok: false };
        case "drops":
          throw new Error("connection reset before the request was sent");
        case "holds":
          world.held.push({ id: identity.id, landBy: world.time + MAX_IN_FLIGHT_MS });
          throw new Error("timed out");
      }
    },
    observe: async ({ identity }) => {
      ops.get(identity.id)!.lastObserveAt = world.event;
      return observed(world.ledger.get(identity.id) ?? 0, { source: "ledger", authoritative: true });
    },
    reconcile: ({ observation }) => {
      if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "no read");
      if (observation.data === 0) return reconciled("NOT_APPLIED", "NONE", "none");
      if (observation.data === 1) return reconciled("APPLIED", "ONE", "one");
      return reconciled("CONFLICTED", "MANY", "more than one");
    }
  });
}

/** Runs one seed; returns the violations found (empty when everything held). */
async function runSeed(
  seed: number,
  makeStore: () => Promise<EffectStore>,
  steps: number
): Promise<{ violations: string[]; trace: string[]; stats: Record<string, number> }> {
  const r = prng(seed);
  const world: World = {
    time: Date.parse("2026-10-02T12:00:00.000Z"),
    event: 0,
    ledger: new Map(),
    held: [],
    nextTransport: "applies",
    nextRevalidate: "proceed",
    crash: null,
    executes: 0,
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
      needsReviewAtCreation: r.chance(0.6),
      everNeededReview: false,
      enteredReviewAt: -1,
      reviewEntries: 0,
      awaiting: false,
      currentToken: null,
      tokensSeen: [],
      approval: null,
      rejected: false,
      closed: false,
      revalidatedProceed: false,
      lastExecuteAt: -1,
      lastObserveAt: -1
    });
  }
  const maxApprovalAgeMs = r.chance(0.5) ? r.int(4_000, 20_000) : undefined;
  const withRevalidate = r.chance(0.8);
  const contract = makeContract(world, ops, { maxApprovalAgeMs, withRevalidate });
  const store = instrument(await makeStore(), world);
  world.trace.push(`seed ${seed}: maxApprovalAgeMs=${maxApprovalAgeMs ?? "none"} revalidate=${withRevalidate}`);

  // readOnly: the call didn't hold the lock (another caller did), so it could only report the
  // record. It can't open a review, so after a 0.4.0 reopen it honestly has no token to give.
  const observeResult = (op: OpModel, result: EffectResult<unknown>, readOnly = false) => {
    if (op.closed && result.status !== "CLOSED") violation(`${op.id}: status ${result.status} after CLOSED`);
    if (result.status === "AWAITING_REVIEW") {
      if (!result.reviewToken && !readOnly) violation(`${op.id}: AWAITING_REVIEW without a reviewToken`);
      if (!op.awaiting || op.currentToken !== result.reviewToken) {
        // Entered (or re-entered) review since the oracle last looked.
        if (op.awaiting && op.currentToken && result.reviewToken && op.currentToken !== result.reviewToken) {
          // A new review opened while the oracle thought one was open: legitimate only if the old
          // one was answered or replaced (a decision, or a remint); the oracle just follows.
        }
        op.everNeededReview = true;
        op.enteredReviewAt = world.event;
        op.reviewEntries += 1;
        op.awaiting = true;
        op.currentToken = result.reviewToken;
        if (result.reviewToken && !op.tokensSeen.includes(result.reviewToken)) op.tokensSeen.push(result.reviewToken);
      }
    } else {
      if (result.reviewToken !== null) violation(`${op.id}: reviewToken ${result.reviewToken} while ${result.status}`);
      op.awaiting = false;
    }
    if (result.status === "CLOSED") op.closed = true;
  };

  for (let step = 0; step < steps; step++) {
    world.event += 1;
    const op = ops.get(r.pick([...ops.keys()]))!;
    const action = r.weighted({ run: 45, review: 30, advance: 15, land: 10, legacyReopen: 3, legacyApprove: 3 });

    // A corrobo 0.4.0 worker still running during a rolling upgrade (it takes the same lock):
    // it can send an operation back to review without opening a new review, and approve
    // without a token. Neither may let anything execute that no current decision authorized.
    if (action === "legacyReopen" || action === "legacyApprove") {
      const lock = await store.tryAcquireLock(op.id);
      if (!lock) continue;
      try {
        const record = await lock.store.getOperation(op.id);
        if (action === "legacyReopen" && record?.status === "OPEN") {
          await lock.store.updateOperation(
            op.id,
            { status: "AWAITING_REVIEW", reviewReason: { code: "LEGACY_REVIEW", summary: "0.4.0 worker" } },
            record.version
          );
          world.trace.push(`#${world.event} legacy 0.4.0 worker reopens review on ${op.id} (no new review episode)`);
          count(world, "legacy reopen");
          op.everNeededReview = true;
          op.enteredReviewAt = world.event;
          op.reviewEntries += 1;
          op.awaiting = true;
          op.currentToken = null; // no valid token until corrobo opens a new review
        } else if (action === "legacyApprove" && record?.status === "AWAITING_REVIEW") {
          await lock.store.updateOperation(
            op.id,
            {
              status: "OPEN",
              review: {
                decision: "approved",
                reviewer: "legacy",
                decidedAt: new Date(world.time).toISOString(),
                intentFingerprint: JSON.stringify({ ref: op.id }),
                recordedAt: new Date(world.time).toISOString(),
                attemptCount: record.attempts.length
              } as never
            },
            record.version
          );
          world.trace.push(`#${world.event} legacy 0.4.0 worker approves ${op.id} without a token`);
          count(world, "legacy approve");
          op.awaiting = false; // not an approval the oracle accepts
          op.currentToken = null;
        }
      } finally {
        await lock.release();
      }
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
      for (const h of landing) world.ledger.set(h.id, (world.ledger.get(h.id) ?? 0) + 1);
      if (landing.length) count(world, "late landing");
      world.trace.push(`#${world.event} land ${landing.map((h) => h.id).join(",") || "(nothing in flight)"}`);
      continue;
    }

    const busy = r.chance(0.06);
    const heldLock = busy ? await store.tryAcquireLock(op.id) : null;

    if (action === "run") {
      world.nextTransport = r.weighted({ applies: 45, respondsNotApplied: 20, drops: 15, holds: 20 });
      world.nextRevalidate = r.weighted({ proceed: 55, requiresReview: 15, reject: 4, throws: 10, invalid: 4, slowProceed: 12 });
      world.crash = r.chance(0.1) ? r.pick(["afterReserve", "beforeResolve"] as const) : null;
      op.revalidatedProceed = false;
      const actor = r.pick(["agent", "worker", "alice"]);
      world.trace.push(
        `#${world.event} run ${op.id} actor=${actor} transport=${world.nextTransport} revalidate=${world.nextRevalidate} crash=${world.crash ?? "no"}${busy ? " (lock held)" : ""}`
      );
      try {
        const result = await runEffect(store, contract, { identity: op.id, intent: { ref: op.id }, context: { actor } });
        world.trace.push(`    -> ${result.status} ${result.disposition ?? "-"} ${result.dispositionReason.code}`);
        count(world, `run: ${result.dispositionReason.code}`);
        if (result.status === "AWAITING_REVIEW" && op.awaiting === false && op.everNeededReview) count(world, "re-entered review");
        observeResult(op, result, busy);
      } catch (err) {
        if (!(err instanceof SimulatedCrash)) throw err;
        world.trace.push(`    -> crashed (${(err as Error).message})`);
        count(world, "crash");
      } finally {
        world.crash = null;
      }
    } else {
      // review: what a review screen might send
      const record = await store.getOperation(op.id);
      const other = [...ops.values()].find((o) => o !== op)!;
      const tokenSource = r.weighted({ current: 55, stale: 20, otherOp: 10, garbage: 15 });
      const token =
        tokenSource === "current"
          ? (op.currentToken ?? "none-yet")
          : tokenSource === "stale"
            ? (r.pick(op.tokensSeen.length ? op.tokensSeen : ["none-yet"]))
            : tokenSource === "otherOp"
              ? (other.currentToken ?? "none-yet")
              : "f".repeat(32);
      const kind = r.weighted({ approved: 85, rejected: 15 });
      const openedAtMs = record?.reviewEpisode ? Date.parse(record.reviewEpisode.openedAt) : null;
      const decidedAtChoice = r.weighted({ omitted: 60, now: 20, beforeReview: 20 });
      const decidedAtMs =
        decidedAtChoice === "omitted" ? null : decidedAtChoice === "now" ? world.time : (openedAtMs ?? world.time) - r.int(1, 5_000);
      const expiresChoice = kind === "approved" ? r.weighted({ none: 50, later: 40, past: 10 }) : "none";
      const expiresAtMs =
        expiresChoice === "none" ? null : expiresChoice === "later" ? world.time + r.int(500, 15_000) : world.time - 1;
      const reviewer = r.pick(["alice", "bob", "carol"]);
      const decision: ReviewDecision = {
        decision: kind,
        reviewer,
        reviewToken: token,
        ...(decidedAtMs !== null ? { decidedAt: new Date(decidedAtMs).toISOString() } : {}),
        ...(expiresAtMs !== null && (decidedAtMs === null || expiresAtMs > decidedAtMs)
          ? { expiresAt: new Date(expiresAtMs).toISOString() }
          : {})
      };
      world.trace.push(
        `#${world.event} review ${op.id} ${kind} by ${reviewer} token=${tokenSource} decidedAt=${decidedAtChoice} expires=${decision.expiresAt ? expiresChoice : "none"}${busy ? " (lock held)" : ""}`
      );

      // What the oracle expects: is this a decision corrobo must accept?
      const recordedAtMs = world.time;
      const effectiveExpiry = Math.min(
        decision.expiresAt ? Date.parse(decision.expiresAt) : Infinity,
        maxApprovalAgeMs !== undefined ? Math.min(decidedAtMs ?? recordedAtMs, recordedAtMs) + maxApprovalAgeMs : Infinity
      );
      const answersOpenReview =
        op.awaiting && record?.status === "AWAITING_REVIEW" && token === op.currentToken && token === record?.reviewEpisode?.token;
      const valid =
        answersOpenReview &&
        (decidedAtMs === null || openedAtMs === null || decidedAtMs >= openedAtMs) &&
        (kind === "rejected" || effectiveExpiry > recordedAtMs);

      const executesBefore = world.executes;
      try {
        const result = await reviewEffect(store, contract, { identity: op.id, decision });
        world.trace.push(`    -> accepted: ${result.status} ${result.dispositionReason.code}`);
        count(world, `review accepted: ${kind}`);
        if (busy) violation(`${op.id}: a decision was recorded while another caller held the lock`);
        if (!valid) violation(`${op.id}: accepted a decision the oracle says answers no open review (token=${tokenSource}, decidedAt=${decidedAtChoice})`);
        if (world.executes !== executesBefore) violation(`${op.id}: reviewEffect() executed something`);
        op.awaiting = false;
        op.currentToken = null;
        if (kind === "approved") op.approval = { at: world.event, expiresAtMs: effectiveExpiry, reviewer };
        else {
          op.rejected = true;
          op.closed = true;
        }
        observeResult(op, result);
      } catch (err) {
        if (err instanceof OperationBusyError) {
          world.trace.push(`    -> busy`);
          count(world, "review busy");
          if (!busy) violation(`${op.id}: OperationBusyError with no other caller holding the lock`);
        } else if (!record && err instanceof Error && /no operation/.test(err.message)) {
          world.trace.push(`    -> refused (no operation yet)`);
        } else if (err instanceof ReviewNotAcceptedError) {
          world.trace.push(`    -> refused (${err.code})`);
          count(world, `review refused: ${err.code}`);
          if (valid && !busy) violation(`${op.id}: refused a valid decision for the open review (${err.code})`);
        } else {
          throw err;
        }
      }
    }
    await heldLock?.release();

    for (const [id, count] of world.ledger) {
      if (count > 1) violation(`${id}: ${count} external effects`);
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
      if (process.env.CORROBO_MODEL_STATS) require("node:fs").writeFileSync(process.env.CORROBO_MODEL_STATS, JSON.stringify(totals, null, 2));
      // The run must actually reach the states the invariants are about.
      for (const key of [
        "execute",
        "execute under an approval",
        "execute after a re-review",
        "re-entered review",
        "crash",
        "late landing",
        "review accepted: approved",
        "review accepted: rejected",
        "review busy",
        "review refused: STALE_REVIEW_TOKEN",
        "review refused: DECIDED_BEFORE_REVIEW_OPENED",
        "review refused: NOT_AWAITING_REVIEW",
        "review refused: APPROVAL_ALREADY_EXPIRED",
        "run: APPROVAL_EXPIRED",
        "run: REVALIDATION_REQUIRES_REVIEW",
        "run: REVALIDATION_FAILED",
        "run: REVALIDATION_REJECTED",
        "run: APPROVAL_NOT_RECORDED",
        "legacy reopen",
        "legacy approve"
      ]) {
        expect(totals[key] ?? 0, `coverage: ${key}`).toBeGreaterThanOrEqual(10);
      }
    }
  }, 600_000);
});

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("review flow: model-based (PostgresStore)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
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
  }, 180_000);
});
