import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import { defineContract, reconciled } from "../src/core/helpers";
import type { EffectStore } from "../src/core/store";

/** A provider that stays "pending" for a long time, and a reconcile() that reports what it found. */
function pendingContract(state: { polls: number; settleAfter: number }, effect: (n: number) => unknown) {
  return defineContract<{ n: number }>()({
    operationType: "history/test",
    retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
    execute: async () => ({ id: "x_1" }),
    observe: async () => {
      state.polls += 1;
      return state.polls >= state.settleAfter
        ? { status: "observed", data: state.polls, authoritative: true, source: "provider", observedAt: new Date().toISOString() }
        : { status: "pending", data: state.polls, authoritative: true, source: "provider", observedAt: new Date().toISOString() };
    },
    reconcile: ({ observation }) => ({
      ...(observation.status === "pending"
        ? reconciled("PENDING", "SETTLING", "not final")
        : reconciled("APPLIED", "DONE", "done")),
      observedEffect: effect(state.polls)
    })
  });
}

async function pollUntilDone(store: EffectStore, id: string, polls: number, effect: (n: number) => unknown) {
  const state = { polls: 0, settleAfter: polls };
  const contract = pendingContract(state, effect);
  let result = await runEffect(store, contract, { identity: id, intent: { n: 1 } });
  while (result.evidenceState === "PENDING") result = await runEffect(store, contract, { identity: id, intent: { n: 1 } });
  return result;
}

describe("observation history and observedEffect", () => {
  it("a long PENDING keeps the first observation and the most recent ones, at most 20", async () => {
    const result = await pollUntilDone(new InMemoryStore(), "h1", 50, (n) => ({ receipt: `r_${n}` }));
    expect(result.disposition).toBe("COMPLETE");
    const attempt = result.attempts[0];
    if (attempt.status !== "RESOLVED") throw new Error("expected resolved");
    expect(attempt.observations).toHaveLength(20);
    expect(attempt.observations.map((o) => (o as { data: number }).data)).toEqual([1, ...Array.from({ length: 19 }, (_, i) => 32 + i)]);
    expect(attempt.observedEffect).toEqual({ receipt: "r_50" });
  });

  it("an observedEffect that isn't JSON-serializable is left out, and the pass still completes", async () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const result = await pollUntilDone(new InMemoryStore(), "h2", 1, () => circular);
    expect(result.disposition).toBe("COMPLETE");
    const attempt = result.attempts[0];
    expect(attempt.status === "RESOLVED" && "observedEffect" in attempt).toBe(false);
  });
});

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("observation history and observedEffect (Postgres)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await PostgresStore.migrate(pool);
    await pool.query("DELETE FROM corrobo_operations WHERE id LIKE 'pg-h%'");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("is bounded and persisted, and read back by another process", async () => {
    await pollUntilDone(new PostgresStore(pool, { acknowledgePersistence: true }), "pg-h1", 30, (n) => ({ receipt: `r_${n}` }));
    const other = new Pool({ connectionString });
    try {
      const record = await new PostgresStore(other, { acknowledgePersistence: true }).getOperation("pg-h1");
      const attempt = record?.attempts[0];
      if (attempt?.status !== "RESOLVED") throw new Error("expected resolved");
      expect(attempt.observations).toHaveLength(20);
      expect(attempt.observedEffect).toEqual({ receipt: "r_30" });
    } finally {
      await other.end();
    }
  });
});
