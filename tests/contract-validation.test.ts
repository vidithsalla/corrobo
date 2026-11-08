import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect, reviewEffect } from "../src/core/runtime";
import { defineContract, observed, reconciled } from "../src/core/helpers";

/**
 * A contract whose settings would make corrobo unsafe or unable to finish is refused before
 * anything runs: no record, no execute(). (A negative maxInFlightMs allowed an immediate retry
 * while the first request could still land; a non-finite one threw only after the effect,
 * leaving the attempt stuck as RESERVED.)
 */
function baseContract(executed: string[]) {
  return defineContract<{ n: number }>()({
    operationType: "validation/test",
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    maxInFlightMs: 1_000,
    execute: async ({ identity }) => {
      executed.push(identity.id);
      return {};
    },
    observe: async () => observed(0, { source: "s", authoritative: true }),
    reconcile: () => reconciled("NOT_APPLIED", "NONE", "none")
  });
}

describe("contract validation", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a negative maxInFlightMs", { maxInFlightMs: -1 }],
    ["a NaN maxInFlightMs", { maxInFlightMs: Number.NaN }],
    ["an infinite maxInFlightMs", { maxInFlightMs: Number.POSITIVE_INFINITY }],
    ["a string maxInFlightMs", { maxInFlightMs: "5000" }],
    ["a negative maxApprovalAgeMs", { maxApprovalAgeMs: -5 }],
    ["maxAttempts 0", { retryPolicy: { maxAttempts: 0, retryOnNotApplied: true } }],
    ["a fractional maxAttempts", { retryPolicy: { maxAttempts: 1.5, retryOnNotApplied: true } }],
    ["a non-boolean retryOnNotApplied", { retryPolicy: { maxAttempts: 2, retryOnNotApplied: "yes" } }],
    ["no retryPolicy", { retryPolicy: undefined }],
    ["an empty operationType", { operationType: "" }],
    ["a non-function revalidate", { revalidate: true }]
  ])("%s is refused before anything runs", async (_label, override) => {
    const executed: string[] = [];
    const store = new InMemoryStore();
    const contract = { ...baseContract(executed), ...override } as unknown as ReturnType<typeof baseContract>;
    await expect(runEffect(store, contract, { identity: "v1", intent: { n: 1 } })).rejects.toThrow(TypeError);
    await expect(
      reviewEffect(store, contract, { identity: "v1", decision: { decision: "approved", reviewer: "a", reviewToken: "t" } })
    ).rejects.toThrow(TypeError);
    expect(await store.getOperation("v1")).toBeNull();
    expect(executed).toEqual([]);
  });

  it("a valid contract, including maxInFlightMs 0 and maxAttempts 1, runs", async () => {
    const executed: string[] = [];
    const contract = { ...baseContract(executed), maxInFlightMs: 0, retryPolicy: { maxAttempts: 1, retryOnNotApplied: false } };
    const result = await runEffect(new InMemoryStore(), contract, { identity: "v2", intent: { n: 1 } });
    expect(result.disposition).toBe("INVESTIGATE");
    expect(executed).toEqual(["v2"]);
  });
});

describe("settlement window recorded with the attempt", () => {
  class ClockStore extends InMemoryStore {
    time = Date.parse("2026-10-02T12:00:00.000Z");
    async now() {
      return new Date(this.time);
    }
  }

  function ledgerContract(credits: string[], maxInFlightMs: number | undefined, held: { landed: boolean }) {
    return defineContract<{ n: number }>()({
      operationType: "window/test",
      retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
      ...(maxInFlightMs !== undefined ? { maxInFlightMs } : {}),
      execute: async ({ identity }) => {
        if (!held.landed) throw new Error("timed out"); // the first request is held in flight
        credits.push(identity.id);
        return {};
      },
      observe: async ({ identity }) => observed(credits.filter((c) => c === identity.id).length, { source: "l", authoritative: true }),
      reconcile: ({ observation }) =>
        observation.status === "observed" && observation.data > 0 ? reconciled("APPLIED", "A", "a") : reconciled("NOT_APPLIED", "N", "n")
    });
  }

  it("a deploy that shortens maxInFlightMs doesn't let an attempt sent under the longer window be retried early", async () => {
    // Version A (60s window) sends the request and crashes before recording the outcome, so the
    // attempt stays RESERVED with no retryNotBefore. Version B (5s window) recovers it 6s later.
    class CrashOnce extends ClockStore {
      crash = true;
      override async updateLatestAttempt(...args: Parameters<InMemoryStore["updateLatestAttempt"]>) {
        if (this.crash) {
          this.crash = false;
          throw new Error("process died");
        }
        return super.updateLatestAttempt(...args);
      }
    }
    const store = new CrashOnce();
    const credits: string[] = [];
    const held = { landed: false };
    await expect(runEffect(store, ledgerContract(credits, 60_000, held), { identity: "w1", intent: { n: 1 } })).rejects.toThrow(
      "process died"
    );
    expect((await store.getOperation("w1"))?.attempts[0]).toMatchObject({ status: "RESERVED", maxInFlightMs: 60_000 });

    store.time += 6_000;
    held.landed = true;
    const recovered = await runEffect(store, ledgerContract(credits, 5_000, held), { identity: "w1", intent: { n: 1 } });
    expect(recovered.disposition).toBe("RETRY");
    expect(recovered.retryNotBefore).toBe(new Date(Date.parse("2026-10-02T12:00:00.000Z") + 60_000).toISOString());
    const again = await runEffect(store, ledgerContract(credits, 5_000, held), { identity: "w1", intent: { n: 1 } });
    expect(again.disposition).toBe("RETRY");
    expect(credits).toEqual([]); // nothing re-sent inside the window the request was sent under

    // The original request lands at 30s; after 60s the re-check finds it, nothing is re-sent.
    credits.push("w1");
    store.time += 60_000;
    const settled = await runEffect(store, ledgerContract(credits, 5_000, held), { identity: "w1", intent: { n: 1 } });
    expect(settled).toMatchObject({ evidenceState: "APPLIED", disposition: "COMPLETE" });
    expect(credits).toEqual(["w1"]);
  });

  it("a deploy that removes maxInFlightMs makes the open attempt INVESTIGATE, as the new contract declares", async () => {
    const store = new ClockStore();
    const credits: string[] = [];
    const held = { landed: false };
    await runEffect(store, ledgerContract(credits, 5_000, held), { identity: "w2", intent: { n: 1 } });
    store.time += 10_000;
    const later = await runEffect(store, ledgerContract(credits, undefined, held), { identity: "w2", intent: { n: 1 } });
    expect(later.disposition).toBe("INVESTIGATE");
    expect(credits).toEqual([]);
  });
});

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("settlement window recorded with the attempt (Postgres)", () => {
  it("is persisted on the attempt and read back by another process", async () => {
    const pool = new Pool({ connectionString });
    try {
      await PostgresStore.migrate(pool);
      await pool.query("DELETE FROM corrobo_operations WHERE id = 'pg-w1'");
      const contract = defineContract<{ n: number }>()({
        operationType: "window/pg",
        retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
        maxInFlightMs: 42_000,
        execute: async () => {
          throw new Error("timed out");
        },
        observe: async () => observed(0, { source: "s", authoritative: true }),
        reconcile: () => reconciled("NOT_APPLIED", "N", "n")
      });
      await runEffect(new PostgresStore(pool, { acknowledgePersistence: true }), contract, { identity: "pg-w1", intent: { n: 1 } });
      const other = new Pool({ connectionString });
      try {
        const record = await new PostgresStore(other, { acknowledgePersistence: true }).getOperation("pg-w1");
        expect(record?.attempts[0]).toMatchObject({ status: "RESOLVED", maxInFlightMs: 42_000, disposition: "RETRY" });
      } finally {
        await other.end();
      }
    } finally {
      await pool.end();
    }
  });
});

describe("contract validation keeps what 0.5.0 accepted", () => {
  it("maxAttempts: Infinity (retry a confirmed not-applied without limit) is still allowed", async () => {
    const executed: string[] = [];
    const contract = { ...baseContract(executed), retryPolicy: { maxAttempts: Number.POSITIVE_INFINITY, retryOnNotApplied: true } };
    const result = await runEffect(new InMemoryStore(), contract, { identity: "v3", intent: { n: 1 } });
    expect(result.disposition).toBe("RETRY");
    expect(executed).toEqual(["v3"]);
  });

  it("an unlimited maxAttempts is recorded as \"unlimited\" in the reason, so every store keeps the same value", async () => {
    const executed: string[] = [];
    const contract = { ...baseContract(executed), retryPolicy: { maxAttempts: Number.POSITIVE_INFINITY, retryOnNotApplied: false } };
    const result = await runEffect(new InMemoryStore(), contract, { identity: "v4", intent: { n: 1 } });
    expect(result.disposition).toBe("INVESTIGATE");
    expect(result.dispositionReason.metadata).toMatchObject({ maxAttempts: "unlimited", retryable: false });
  });
});
