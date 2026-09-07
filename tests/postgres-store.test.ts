import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

// Runs only when a local Postgres test database is configured. See docs/v0.1-spec.md
// and README for how to start one; the verification gate reports explicitly if this
// suite was skipped rather than silently passing.
describe.skipIf(!connectionString)("PostgresStore", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await PostgresStore.migrate(pool);
    await pool.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists an operation and reloads it via a fresh pool, simulating a process restart", async () => {
    const store = new PostgresStore(pool);
    const contract: EffectContract<{ n: number }, unknown, unknown> = {
      operationType: "test/pg",
      capabilities: {
        nativeIdempotency: false,
        callerGeneratedIdentity: true,
        optimisticConcurrency: false,
        convergence: false
      },
      retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },
      async execute() {
        return { done: true };
      },
      async observe() {
        return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    };

    const identity = { id: "pg-op-1", operationType: contract.operationType };
    const result = await runEffect(store, contract, { identity, intent: { n: 1 } });
    expect(result.disposition).toBe("COMPLETE");

    const freshPool = new Pool({ connectionString });
    const freshStore = new PostgresStore(freshPool);
    const reloaded = await freshStore.getOperation("pg-op-1");
    expect(reloaded?.status).toBe("CLOSED");
    expect(reloaded?.attempts[0]?.evidenceState).toBe("APPLIED");
    expect(reloaded?.intent).toEqual({ n: 1 });
    await freshPool.end();
  });

  it("rejects creating a duplicate operation identity", async () => {
    const store = new PostgresStore(pool);
    await store.createOperation({ identity: { id: "pg-dup", operationType: "t" }, intent: {}, status: "OPEN" });
    await expect(
      store.createOperation({ identity: { id: "pg-dup", operationType: "t" }, intent: {}, status: "OPEN" })
    ).rejects.toThrow(/already exists/);
  });

  it("supports the PENDING -> re-observe -> APPLIED lifecycle durably, across separate calls", async () => {
    const store = new PostgresStore(pool);
    let observeCall = 0;
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/pg-pending",
      capabilities: {
        nativeIdempotency: false,
        callerGeneratedIdentity: true,
        optimisticConcurrency: false,
        convergence: true
      },
      retryPolicy: { maxAttempts: 3, retryableEvidenceStates: ["NOT_APPLIED"] },
      async execute() {
        return { ok: true };
      },
      async observe() {
        observeCall += 1;
        if (observeCall === 1) {
          return { status: "pending", authoritative: true, source: "t", observedAt: new Date().toISOString() };
        }
        return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: ({ observation }) =>
        observation.status === "pending"
          ? { evidenceState: "PENDING", reason: { code: "WAIT", summary: "wait" } }
          : { evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } }
    };
    const identity = { id: "pg-pending-1", operationType: contract.operationType };
    const r1 = await runEffect(store, contract, { identity, intent: {} });
    expect(r1.evidenceState).toBe("PENDING");
    const r2 = await runEffect(store, contract, { identity, intent: {} });
    expect(r2.evidenceState).toBe("APPLIED");
    expect(observeCall).toBe(2);
  });
});
