import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

/**
 * Simulates a process dying between execute() actually running and corrobo persisting the
 * resolved outcome: reserve an attempt directly against the store (bypassing runEffect, which
 * would go on to call execute()/observe()/resolve in one uninterrupted pass), optionally
 * mutate an external side-effect counter to represent "the real effect already happened,
 * corrobo just never recorded it," and never resolve the attempt. A fresh Pool/PostgresStore
 * then stands in for a restarted process.
 */
describe.skipIf(!connectionString)("crash recovery: reserved-but-unresolved attempts", () => {
  let poolA: Pool;

  beforeAll(async () => {
    poolA = new Pool({ connectionString });
    await PostgresStore.migrate(poolA);
  });

  beforeEach(async () => {
    await poolA.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await poolA.end();
  });

  function makeContract(external: { mutationCount: number; observationFails?: boolean }) {
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/crash-recovery",
      capabilities: {
        nativeIdempotency: false,
        callerGeneratedIdentity: true,
        optimisticConcurrency: false,
        convergence: false
      },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      async execute() {
        external.mutationCount += 1;
        return { done: true };
      },
      async observe() {
        if (external.observationFails) {
          throw new Error("read-back unavailable");
        }
        return {
          status: "observed",
          data: { done: external.mutationCount > 0 },
          authoritative: true,
          source: "t",
          observedAt: new Date().toISOString()
        };
      },
      reconcile: ({ observation }) => {
        if (observation.status === "observation_failed") {
          return { evidenceState: "UNKNOWN", reason: { code: "READBACK_UNAVAILABLE", summary: "read-back failed" } };
        }
        const data = observation.status === "observed" ? (observation.data as { done: boolean }) : undefined;
        return data?.done
          ? { evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "ABSENT", summary: "absent" } };
      }
    };
    return contract;
  }

  it("a reserved attempt exists before execute() is ever called", async () => {
    const store = new PostgresStore(poolA, { acknowledgePersistence: true });
    let sawReservedInsideExecute = false;

    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/reservation-order",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      async execute({ identity, attemptNumber }) {
        const record = await store.getOperation(identity.id);
        const latest = record?.attempts[record.attempts.length - 1];
        sawReservedInsideExecute = latest?.status === "RESERVED" && latest.attemptNumber === attemptNumber;
        return { done: true };
      },
      async observe() {
        return { status: "observed", data: { done: true }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    };

    await runEffect(store, contract, {
      identity: { id: "crash-order-1", operationType: contract.operationType },
      intent: {}
    });
    expect(sawReservedInsideExecute).toBe(true);
  });

  it("crash after the effect occurred but before resolution: restart observes first, finds APPLIED, does not re-execute", async () => {
    const external = { mutationCount: 0 };
    const contract = makeContract(external);
    const identity = { id: "crash-applied-1", operationType: contract.operationType };

    // Simulate the crashed process: it created the operation, reserved attempt 1, the real
    // side effect happened (mutationCount becomes 1) — but it died before ever calling
    // updateLatestAttempt, so nothing beyond the reservation is durably recorded.
    await poolA.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, attempts) VALUES ($1, $2, '{}'::jsonb, 'OPEN', '[]'::jsonb)`,
      [identity.id, identity.operationType]
    );
    const reserveStore = new PostgresStore(poolA, { acknowledgePersistence: true });
    await reserveStore.reserveAttempt(identity.id, { attemptNumber: 1, startedAt: new Date().toISOString() });
    external.mutationCount = 1; // the real effect already happened, corrobo just doesn't know it

    // "Restart": a fresh pool and store, exactly like a new process.
    const poolB = new Pool({ connectionString });
    const storeB = new PostgresStore(poolB, { acknowledgePersistence: true });

    const result = await runEffect(storeB, contract, { identity, intent: {} });

    expect(external.mutationCount).toBe(1); // execute() was NOT called again
    expect(result.evidenceState).toBe("APPLIED");
    expect(result.disposition).toBe("COMPLETE");
    expect(result.attempts).toHaveLength(1); // resolved in place, not appended as a second attempt

    await poolB.end();
  });

  it("crash before the effect occurred: restart observes NOT_APPLIED and retry is allowed only per policy", async () => {
    const external = { mutationCount: 0 };
    const contract = makeContract(external);
    const identity = { id: "crash-not-applied-1", operationType: contract.operationType };

    await poolA.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, attempts) VALUES ($1, $2, '{}'::jsonb, 'OPEN', '[]'::jsonb)`,
      [identity.id, identity.operationType]
    );
    const reserveStore = new PostgresStore(poolA, { acknowledgePersistence: true });
    await reserveStore.reserveAttempt(identity.id, { attemptNumber: 1, startedAt: new Date().toISOString() });
    // external.mutationCount stays 0: the crash happened before execute() ever ran for real.

    const poolB = new Pool({ connectionString });
    const storeB = new PostgresStore(poolB, { acknowledgePersistence: true });

    const result = await runEffect(storeB, contract, { identity, intent: {} });
    expect(result.evidenceState).toBe("NOT_APPLIED");
    expect(result.disposition).toBe("RETRY");
    expect(external.mutationCount).toBe(0);

    // A subsequent call is now a genuine, fresh attempt — allowed because retryOnNotApplied is true.
    const retried = await runEffect(storeB, contract, { identity, intent: {} });
    expect(retried.evidenceState).toBe("APPLIED");
    expect(retried.disposition).toBe("COMPLETE");
    expect(external.mutationCount).toBe(1);

    await poolB.end();
  });

  it("crash + observation cannot resolve either way: honestly UNKNOWN / INVESTIGATE, no blind re-execution", async () => {
    const external = { mutationCount: 1, observationFails: true }; // effect happened, but we can't confirm it
    const contract = makeContract(external);
    const identity = { id: "crash-unknown-1", operationType: contract.operationType };

    await poolA.query(
      `INSERT INTO corrobo_operations (id, operation_type, intent, status, attempts) VALUES ($1, $2, '{}'::jsonb, 'OPEN', '[]'::jsonb)`,
      [identity.id, identity.operationType]
    );
    const reserveStore = new PostgresStore(poolA, { acknowledgePersistence: true });
    await reserveStore.reserveAttempt(identity.id, { attemptNumber: 1, startedAt: new Date().toISOString() });

    const poolB = new Pool({ connectionString });
    const storeB = new PostgresStore(poolB, { acknowledgePersistence: true });

    const result = await runEffect(storeB, contract, { identity, intent: {} });
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");
    expect(external.mutationCount).toBe(1); // never incremented again — execute() was not re-run

    await poolB.end();
  });
});
