import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import type { EffectStore } from "../src/core/store";
import { reviewEffect, runEffect } from "../src/core/runtime";
import { fingerprintIntent } from "../src/core/fingerprint";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import { createRefundContract } from "../examples/stripe-refund/contract";
import { FakeStripeClient } from "../examples/stripe-refund/fake-stripe-client";

/** Hooks' answers are checked, never trusted to be well-formed (found in the 0.5.1 Codex review). */

function base(executed: string[]) {
  return defineContract<{ n: number }>()({
    operationType: "hooks/test",
    retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
    execute: async ({ identity }) => {
      executed.push(identity.id);
      return {};
    },
    observe: async () => observed(1, { source: "s", authoritative: true }),
    reconcile: () => reconciled("APPLIED", "A", "a")
  });
}

describe("authorize() results are validated", () => {
  it.each<[string, unknown]>([
    ["{} (no requiresReview)", {}],
    ["requiresReview: 0", { requiresReview: 0 }],
    ["requiresReview: \"false\"", { requiresReview: "false" }],
    ["undefined", undefined],
    ["a reason without a summary", { requiresReview: true, reason: { code: "X" } }]
  ])("%s throws before anything is recorded or executed (a malformed answer never skips review)", async (_label, answer) => {
    const executed: string[] = [];
    const store = new InMemoryStore();
    const contract = { ...base(executed), authorize: () => answer as never };
    await expect(runEffect(store, contract, { identity: "a1", intent: { n: 1 } })).rejects.toThrow(/authorize\(\)/);
    expect(await store.getOperation("a1")).toBeNull();
    expect(executed).toEqual([]);
  });

  it("a getter that throws on the result is refused the same way", async () => {
    const executed: string[] = [];
    const store = new InMemoryStore();
    const contract = {
      ...base(executed),
      authorize: () =>
        ({
          get requiresReview(): boolean {
            throw new Error("boom");
          }
        }) as never
    };
    await expect(runEffect(store, contract, { identity: "a2", intent: { n: 1 } })).rejects.toThrow(TypeError);
    expect(executed).toEqual([]);
  });
});

describe("reconcile() failures don't strand an attempt", () => {
  it.each<[string, () => unknown]>([
    ["throws", () => {
      throw new Error("bug in reconcile");
    }],
    ["returns an unknown evidence state", () => ({ evidenceState: "MAYBE", reason: { code: "X", summary: "x" } })],
    ["returns nothing", () => undefined],
    ["has an observedEffect getter that throws", () => ({
      evidenceState: "APPLIED",
      reason: { code: "A", summary: "a" },
      get observedEffect() {
        throw new Error("getter");
      }
    })]
  ])("reconcile() that %s after execute() records UNKNOWN / INVESTIGATE and closes, instead of throwing forever", async (_label, reconcile) => {
    const executed: string[] = [];
    const store = new InMemoryStore();
    const contract = { ...base(executed), reconcile: reconcile as never };
    const result = await runEffect(store, contract, { identity: "r1", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", evidenceState: "UNKNOWN", disposition: "INVESTIGATE" });
    expect(result.evidenceReason?.code).toBe("RECONCILE_FAILED");
    expect(result.attempts[0].status).toBe("RESOLVED");
    const again = await runEffect(store, contract, { identity: "r1", intent: { n: 1 } });
    expect(again.disposition).toBe("INVESTIGATE");
    expect(executed).toEqual(["r1"]);
  });
});

describe("custom fingerprints act on the stored (JSON) form from the first call", () => {
  it("authorize() and execute() see the same values that are recorded, even if toJSON() differs from the object", async () => {
    const seen: { authorize?: unknown; execute?: unknown } = {};
    const contract = defineContract<{ orderId: string; amountCents: number }>()({
      operationType: "hooks/custom",
      retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
      fingerprintIntent: (i) => JSON.stringify({ orderId: i.orderId }),
      authorize: (intent) => ((seen.authorize = intent.amountCents), { requiresReview: false }),
      execute: async ({ intent }) => ((seen.execute = intent.amountCents), {}),
      observe: async () => observed(1, { source: "s", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "A", "a")
    });
    const sneaky = { orderId: "1", amountCents: 100, toJSON: () => ({ orderId: "1", amountCents: 100_000 }) };
    const store = new InMemoryStore();
    await runEffect(store, contract, { identity: "c1", intent: sneaky });
    const recorded = (await store.getOperation("c1"))?.intent as { amountCents: number };
    expect(seen).toEqual({ authorize: recorded.amountCents, execute: recorded.amountCents });
  });
});

describe("the Stripe example after upgrading from 0.5.0", () => {
  it("an unlabeled refund of the same amount (made before refunds were labeled) means absence can't be proven: UNKNOWN, no second refund", async () => {
    const client = new FakeStripeClient();
    client.seedCharge("ch_20", 10_000);
    // 0.5.0's version of the example created this refund without the corrobo_operation label.
    // Its idempotency key has since expired (Stripe keeps keys ~24h), so a retry wouldn't be deduplicated.
    await client.refunds.create({ charge: "ch_20", amount: 5000 }, { idempotencyKey: "expired-key" });
    client.scheduleFault("ch_20", { createFailures: 1, mode: "beforeCommit" }); // and the crash-recovery read-back runs now
    const store = new InMemoryStore();
    const contract = createRefundContract({ client });
    const result = await runEffect(store, contract, { identity: "refund-20", intent: { chargeId: "ch_20", amountCents: 5000 } });
    expect(result).toMatchObject({ evidenceState: "UNKNOWN", disposition: "INVESTIGATE" });
    expect(result.evidenceReason?.code).toBe("UNLABELED_REFUND_PRESENT");
    expect(client.createdRefundCount).toBe(1);
  });
});

describe("the exported fingerprintIntent() matches what runEffect() recorded, with a custom fingerprint", () => {
  it("an approval carrying fingerprintIntent(contract, intent) of the request's own object is accepted, even when its toJSON() differs", async () => {
    const executed: string[] = [];
    const contract = defineContract<{ orderId: string; amountCents: number }>()({
      operationType: "hooks/custom-review",
      retryPolicy: { maxAttempts: 2, retryOnNotApplied: true },
      fingerprintIntent: (i) => JSON.stringify({ orderId: i.orderId, amountCents: i.amountCents }),
      authorize: () => ({ requiresReview: true, reason: { code: "R", summary: "review" } }),
      execute: async ({ identity }) => (executed.push(identity.id), {}),
      observe: async () => observed(1, { source: "s", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "A", "a")
    });
    const intent = { orderId: "1", amountCents: 100, toJSON: () => ({ orderId: "1", amountCents: 250 }) };
    const store = new InMemoryStore();
    const pending = await runEffect(store, contract, { identity: "f1", intent });
    expect(pending.status).toBe("AWAITING_REVIEW");
    const recorded = (await store.getOperation("f1"))?.intent;
    expect(fingerprintIntent(contract, intent)).toBe(fingerprintIntent(contract, recorded as typeof intent));
    await reviewEffect(store, contract, {
      identity: "f1",
      decision: { decision: "approved", reviewer: "r", reviewToken: pending.reviewToken!, intentFingerprint: fingerprintIntent(contract, intent) }
    });
    expect((await runEffect(store, contract, { identity: "f1", intent })).disposition).toBe("COMPLETE");
    expect(executed).toEqual(["f1"]);
  });
});

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

/** Hook output JSON can't store (a cycle, a BigInt, a function) must not make the write after execute() fail forever. */
function unstorableCases(): [string, () => unknown][] {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  return [
    ["a cycle", () => cyclic],
    ["a BigInt", () => ({ n: 10n })],
    ["a function", () => ({ fn: () => 1 })],
    ["a Proxy", () => new Proxy({ a: 1 }, {})]
  ];
}

/** observe() answers that aren't observations at all. */
function malformedObservations(): [string, unknown][] {
  return [
    ["null", null],
    ["undefined", undefined],
    ["{}", {}],
    ["a string", "observed"],
    ["an unknown status", { status: "done", data: 1, authoritative: true, source: "s", observedAt: "t" }],
    ["observation_failed without an error", { status: "observation_failed", source: "s", observedAt: "t" }]
  ];
}

function storeCases(): [string, () => Promise<EffectStore>][] {
  const cases: [string, () => Promise<EffectStore>][] = [["InMemoryStore", async () => new InMemoryStore()]];
  if (connectionString) cases.push(["PostgresStore", async () => pgStore()]);
  return cases;
}

let pool: Pool | undefined;
async function pgStore(): Promise<EffectStore> {
  pool ??= new Pool({ connectionString });
  await PostgresStore.migrate(pool);
  await pool.query("DELETE FROM corrobo_operations WHERE operation_type = 'hooks/test'");
  return new PostgresStore(pool, { acknowledgePersistence: true });
}

describe("hook output that can't be stored doesn't strand an attempt", () => {
  afterAll(async () => {
    await pool?.end();
  });

  const cases = storeCases().flatMap(([storeName, makeStore]) =>
    unstorableCases().map(([label, value]) => [storeName, label, makeStore, value] as const)
  );

  it.each(cases)("%s: reconcile() reason metadata with %s is recorded as a note; the attempt resolves", async (_store, label, makeStore, value) => {
    const executed: string[] = [];
    const store = await makeStore();
    const contract = {
      ...base(executed),
      reconcile: () => ({ evidenceState: "APPLIED" as const, reason: { code: "A", summary: "a", metadata: value() as never } })
    };
    const result = await runEffect(store, contract, { identity: "m1", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", disposition: "COMPLETE" });
    // JSON can't hold a cycle or a BigInt at all, so a note replaces it; a function is dropped
    // and a Proxy copied as plain data, as Postgres would store them.
    if (label === "a cycle" || label === "a BigInt") expect(result.evidenceReason?.metadata).toHaveProperty("unstorable");
    else expect(result.evidenceReason?.metadata).not.toHaveProperty("unstorable");
    expect(executed).toEqual(["m1"]);
  });

  it.each(cases)("%s: observe() data with %s counts as a failed observation (UNKNOWN), not a write that fails forever", async (_store, _label, makeStore, value) => {
    const executed: string[] = [];
    const store = await makeStore();
    const contract = {
      ...base(executed),
      observe: async () => observed(value() as never, { source: "s", authoritative: true }),
      reconcile: ({ observation }: { observation: { status: string } }) =>
        observation.status === "observation_failed" ? reconciled("UNKNOWN", "U", "u") : reconciled("APPLIED", "A", "a")
    };
    const result = await runEffect(store, contract, { identity: "o1", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", evidenceState: "UNKNOWN", disposition: "INVESTIGATE" });
    expect(result.attempts[0].status).toBe("RESOLVED");
    expect(executed).toEqual(["o1"]);
  });

  const malformed = storeCases().flatMap(([storeName, makeStore]) =>
    malformedObservations().map(([label, value]) => [storeName, label, makeStore, value] as const)
  );

  it.each(malformed)("%s: observe() returning %s counts as a failed observation (UNKNOWN), not a write that fails forever", async (_store, _label, makeStore, value) => {
    const executed: string[] = [];
    const store = await makeStore();
    const contract = {
      ...base(executed),
      observe: async () => value as never,
      reconcile: ({ observation }: { observation: { status: string } }) =>
        observation.status === "observation_failed" ? reconciled("UNKNOWN", "U", "u") : reconciled("APPLIED", "A", "a")
    };
    const result = await runEffect(store, contract, { identity: "v1", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", evidenceState: "UNKNOWN", disposition: "INVESTIGATE" });
    expect(result.attempts[0].status).toBe("RESOLVED");
    expect(executed).toEqual(["v1"]);
  });

  it.each(storeCases())("%s: an observation whose status getter answers differently later is stored as first read; the attempt resolves", async (_store, makeStore) => {
    const executed: string[] = [];
    const store = await makeStore();
    let reads = 0;
    const contract = {
      ...base(executed),
      observe: async () =>
        ({
          get status() {
            reads++;
            if (reads > 1) throw new Error("read twice");
            return "observed";
          },
          data: 1,
          authoritative: true,
          source: "s",
          observedAt: new Date().toISOString()
        }) as never,
      reconcile: () => reconciled("APPLIED", "A", "a")
    };
    const result = await runEffect(store, contract, { identity: "g1", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", disposition: "COMPLETE" });
    expect(result.attempts[0].status).toBe("RESOLVED");
    expect((result.attempts[0] as { observations: { status: string }[] }).observations[0].status).toBe("observed");
    expect(executed).toEqual(["g1"]);
  });

  it.each<[string, string]>([
    ["U+0000", "a\u0000b"],
    ["an unpaired surrogate", "a\uD800b"]
  ])("PostgresStore: hook output containing %s is stored with U+FFFD in its place; the attempt resolves", async (_label, text) => {
    if (!connectionString) return;
    const executed: string[] = [];
    const store = await pgStore();
    const contract = {
      ...base(executed),
      observe: async () => observed({ text, [text]: 1 }, { source: text, authoritative: true }),
      reconcile: () => ({ evidenceState: "APPLIED" as const, reason: { code: "A", summary: text, metadata: { text } }, observedEffect: { text } })
    };
    const result = await runEffect(store, contract, { identity: "u1", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", disposition: "COMPLETE" });
    const attempt = (await store.getOperation("u1"))!.attempts[0] as { status: string; observations: { data: unknown }[]; evidenceReason: { summary: string } };
    expect(attempt.status).toBe("RESOLVED");
    expect(attempt.evidenceReason.summary).toBe("a\uFFFDb");
    expect(attempt.observations[0].data).toEqual({ text: "a\uFFFDb", "a\uFFFDb": 1 });
    expect(executed).toEqual(["u1"]);
  });

  it("PostgresStore: observe() throwing an error whose message contains U+0000 still resolves the attempt", async () => {
    if (!connectionString) return;
    const executed: string[] = [];
    const store = await pgStore();
    const contract = {
      ...base(executed),
      observe: async () => {
        throw new Error("down\u0000");
      },
      reconcile: () => reconciled("UNKNOWN", "U", "u")
    };
    const result = await runEffect(store, contract, { identity: "u2", intent: { n: 1 } });
    expect(result).toMatchObject({ status: "CLOSED", disposition: "INVESTIGATE" });
    expect((await store.getOperation("u2"))!.attempts[0].status).toBe("RESOLVED");
  });

  it("InMemoryStore: an error.raw that observe() returns itself is kept by reference, not copied", async () => {
    class HttpError extends Error {
      config = { url: "https://example.test" };
    }
    const raw = new HttpError("503");
    const executed: string[] = [];
    const store = new InMemoryStore();
    const contract = {
      ...base(executed),
      observe: async () =>
        ({ status: "observation_failed", error: { message: "503", raw }, source: "s", observedAt: new Date().toISOString() }) as never,
      reconcile: () => reconciled("UNKNOWN", "U", "u")
    };
    await runEffect(store, contract, { identity: "w1", intent: { n: 1 } });
    const attempt = (await store.getOperation("w1"))!.attempts[0] as { observations: { error: { raw: unknown } }[] };
    expect(attempt.observations[0].error.raw).toBe(raw);
  });

  it.each(storeCases())("%s: observe() returning observation_failed with an Error as its error keeps the error's message", async (_store, makeStore) => {
    const executed: string[] = [];
    const store = await makeStore();
    let seen: string | undefined;
    const contract = {
      ...base(executed),
      observe: async () => ({ status: "observation_failed", error: new Error("503 from provider"), source: "s", observedAt: new Date().toISOString() }) as never,
      reconcile: ({ observation }: { observation: { status: string; error?: { message: string } } }) => {
        seen = observation.error?.message;
        return reconciled("UNKNOWN", "U", "u");
      }
    };
    const result = await runEffect(store, contract, { identity: "e1", intent: { n: 1 } });
    expect(seen).toBe("503 from provider");
    const attempt = result.attempts[0] as { observations: { error: { message: string } }[] };
    expect(attempt.observations[0].error.message).toBe("503 from provider");
  });
});
