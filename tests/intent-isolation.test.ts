import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import type { EffectStore } from "../src/core/store";
import { reviewEffect, runEffect } from "../src/core/runtime";
import { defineContract, observed, reconciled } from "../src/core/helpers";

/**
 * Every hook gets its own copy of the intent, so no hook (and no change to the caller's object)
 * can alter what execute() sends or what was approved. Reported with reproductions in #46.
 */

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;
let pool: Pool | undefined;

function storeCases(): [string, () => Promise<EffectStore>][] {
  const cases: [string, () => Promise<EffectStore>][] = [["InMemoryStore", async () => new InMemoryStore()]];
  if (connectionString) {
    cases.push([
      "PostgresStore",
      async () => {
        pool ??= new Pool({ connectionString });
        await PostgresStore.migrate(pool);
        await pool.query("DELETE FROM corrobo_operations WHERE operation_type = 'ledger/credit'");
        return new PostgresStore(pool, { acknowledgePersistence: true });
      }
    ]);
  }
  return cases;
}

afterAll(async () => {
  await pool?.end();
});

type Credit = { amountCents: number };

describe.each(storeCases())("%s: hooks can't change the intent another hook receives", (_name, makeStore) => {
  it("revalidate() mutating its intent doesn't change the approved amount execute() sends", async () => {
    const store = await makeStore();
    const ledger: number[] = [];
    const contract = defineContract<Credit>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      authorize: () => ({ requiresReview: true }),
      revalidate: ({ intent }) => {
        intent.amountCents = 500_000;
        return { decision: "proceed" };
      },
      execute: async ({ intent }) => {
        ledger.push(intent.amountCents);
      },
      observe: async () => observed(ledger[0], { source: "ledger", authoritative: true }),
      reconcile: ({ intent, observation }) =>
        observation.status === "observed" && observation.data === intent.amountCents
          ? reconciled("APPLIED", "MATCH", "Matches the intent")
          : reconciled("UNKNOWN", "MISMATCH", "Does not match")
    });
    const waiting = await runEffect(store, contract, { identity: "credit-1", intent: { amountCents: 5_000 } });
    await reviewEffect(store, contract, {
      identity: "credit-1",
      decision: { decision: "approved", reviewToken: waiting.reviewToken!, reviewer: "alice" }
    });
    const done = await runEffect(store, contract, { identity: "credit-1", intent: { amountCents: 5_000 } });
    expect(ledger).toEqual([5_000]);
    expect(done.disposition).toBe("COMPLETE");
    expect((await store.getOperation("credit-1"))!.intent).toEqual({ amountCents: 5_000 });
  });

  it("authorize() mutating its intent doesn't change the first attempt", async () => {
    const store = await makeStore();
    const ledger: number[] = [];
    const contract = defineContract<Credit>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      authorize: (intent) => {
        intent.amountCents = 500_000;
        return { requiresReview: false };
      },
      execute: async ({ intent }) => {
        ledger.push(intent.amountCents);
      },
      observe: async () => observed(ledger[0], { source: "ledger", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "DONE", "Done")
    });
    await runEffect(store, contract, { identity: "credit-2", intent: { amountCents: 5_000 } });
    expect(ledger).toEqual([5_000]);
    expect((await store.getOperation("credit-2"))!.intent).toEqual({ amountCents: 5_000 });
  });

  it("the caller changing its own object while runEffect() is running doesn't reach execute()", async () => {
    const store = await makeStore();
    const ledger: number[] = [];
    const intent = { amountCents: 5_000 };
    const contract = defineContract<Credit>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      authorize: async () => {
        intent.amountCents = 500_000; // the caller's code, running while corrobo awaits
        return { requiresReview: false };
      },
      execute: async ({ intent: received }) => {
        ledger.push(received.amountCents);
      },
      observe: async () => observed(ledger[0], { source: "ledger", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "DONE", "Done")
    });
    await runEffect(store, contract, { identity: "credit-3", intent });
    expect(ledger).toEqual([5_000]);
  });

  it("execute() mutating its intent doesn't change what observe() and reconcile() receive", async () => {
    const store = await makeStore();
    const seen: number[] = [];
    const contract = defineContract<Credit>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      execute: async ({ intent }) => {
        intent.amountCents = 1;
      },
      observe: async ({ intent }) => (seen.push(intent.amountCents), observed(5_000, { source: "ledger", authoritative: true })),
      reconcile: ({ intent, observation }) => {
        seen.push(intent.amountCents);
        return observation.status === "observed" && observation.data === intent.amountCents
          ? reconciled("APPLIED", "MATCH", "Matches the intent")
          : reconciled("UNKNOWN", "MISMATCH", "Does not match");
      }
    });
    const result = await runEffect(store, contract, { identity: "credit-4", intent: { amountCents: 5_000 } });
    expect(seen).toEqual([5_000, 5_000]);
    expect(result.disposition).toBe("COMPLETE");
  });

  it("revalidate() editing the record it's given doesn't change corrobo's own approval check", async () => {
    const store = await makeStore();
    const ledger: number[] = [];
    const contract = defineContract<Credit>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      authorize: () => ({ requiresReview: true }),
      revalidate: ({ record }) => {
        (record.intent as Credit).amountCents = 500_000;
        if (record.reviewEpisode) record.reviewEpisode.token = "edited";
        return { decision: "proceed" };
      },
      execute: async ({ intent }) => {
        ledger.push(intent.amountCents);
      },
      observe: async () => observed(ledger[0], { source: "ledger", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "DONE", "Done")
    });
    const waiting = await runEffect(store, contract, { identity: "credit-5", intent: { amountCents: 5_000 } });
    await reviewEffect(store, contract, {
      identity: "credit-5",
      decision: { decision: "approved", reviewToken: waiting.reviewToken!, reviewer: "alice" }
    });
    const result = await runEffect(store, contract, { identity: "credit-5", intent: { amountCents: 5_000 } });
    expect(result.disposition).toBe("COMPLETE");
    expect(ledger).toEqual([5_000]);
    expect((await store.getOperation("credit-5"))!.intent).toEqual({ amountCents: 5_000 });
  });
});

describe("what hooks receive", () => {
  it("with the default fingerprint, a Date in the intent still arrives as a Date, in a copy of its own", async () => {
    const when = new Date("2026-11-07T12:00:00.000Z");
    const received: unknown[] = [];
    const contract = defineContract<{ when: Date }>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      execute: async ({ intent }) => {
        received.push(intent.when);
      },
      observe: async () => observed(1, { source: "ledger", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "DONE", "Done")
    });
    await runEffect(new InMemoryStore(), contract, { identity: "d1", intent: { when } });
    expect(received[0]).toBeInstanceOf(Date);
    expect((received[0] as Date).toISOString()).toBe(when.toISOString());
    expect(received[0]).not.toBe(when);
  });

  it("with a custom fingerprint, a hook's mutation doesn't reach execute() either", async () => {
    const ledger: number[] = [];
    const contract = defineContract<Credit & { note: string }>()({
      operationType: "ledger/credit",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      fingerprintIntent: (i) => String(i.amountCents),
      authorize: (intent) => {
        intent.amountCents = 500_000;
        return { requiresReview: false };
      },
      execute: async ({ intent }) => {
        ledger.push(intent.amountCents);
      },
      observe: async () => observed(ledger[0], { source: "ledger", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "DONE", "Done")
    });
    await runEffect(new InMemoryStore(), contract, { identity: "f1", intent: { amountCents: 5_000, note: "n" } });
    expect(ledger).toEqual([5_000]);
  });
});
