import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";
import { runEffect } from "../src/core/runtime";
import type { EffectContract } from "../src/core/types";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

const SECRET_TOKEN = "test-secret-do-not-store";
const SECRET_EMAIL = "person@example.com";

/** Shaped like a real HTTP client error (Axios and friends attach exactly this kind of
 *  request/response context to their error objects) — the realistic case this fix targets. */
class RealisticHttpClientError extends Error {
  config = {
    url: "https://api.example.com/charge",
    headers: { Authorization: `Bearer ${SECRET_TOKEN}` }
  };
  response = {
    data: { customerEmail: SECRET_EMAIL, cardLast4: "4242" }
  };
  constructor(message: string) {
    super(message);
  }
}

describe.skipIf(!connectionString)("PostgresStore excludes error.raw from persisted JSON", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await PostgresStore.migrate(pool);
    await pool.query("TRUNCATE corrobo_operations");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function rawPersistedJson(identityId: string): Promise<string> {
    const result = await pool.query<{ attempts: string }>(
      "SELECT attempts::text AS attempts FROM corrobo_operations WHERE id = $1",
      [identityId]
    );
    return result.rows[0]?.attempts ?? "";
  }

  it("a transport error's raw object never reaches persisted Postgres JSON", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/sanitize-transport",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        throw new RealisticHttpClientError("Request failed with status 401");
      },
      async observe() {
        return { status: "observation_failed", error: { message: "no read-back possible" }, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "UNKNOWN", reason: { code: "READBACK_UNAVAILABLE", summary: "unknown" } })
    };

    const identity = { id: "sanitize-transport-1", operationType: contract.operationType };
    const result = await runEffect(store, contract, { identity, intent: {} });

    // The operation still completes through its expected reconciliation path.
    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");

    const persisted = await rawPersistedJson(identity.id);
    expect(persisted).toContain("Request failed with status 401"); // ordinary message: kept
    expect(persisted).not.toContain(SECRET_TOKEN);
    expect(persisted).not.toContain(SECRET_EMAIL);
    expect(persisted).not.toContain("Authorization");
    expect(persisted).not.toContain("cardLast4");
    expect(persisted).not.toContain('"config"');
  });

  it("an observation error's raw object never reaches persisted Postgres JSON", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/sanitize-observation",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        throw new Error("execute also failed, ambiguously");
      },
      async observe() {
        throw new RealisticHttpClientError("read-back request failed with status 401");
      },
      reconcile: ({ observation }) =>
        observation.status === "observation_failed"
          ? { evidenceState: "UNKNOWN", reason: { code: "READBACK_UNAVAILABLE", summary: "unknown" } }
          : { evidenceState: "NOT_APPLIED", reason: { code: "X", summary: "x" } }
    };

    const identity = { id: "sanitize-observation-1", operationType: contract.operationType };
    const result = await runEffect(store, contract, { identity, intent: {} });

    expect(result.evidenceState).toBe("UNKNOWN");
    expect(result.disposition).toBe("INVESTIGATE");

    const persisted = await rawPersistedJson(identity.id);
    expect(persisted).toContain("read-back request failed with status 401"); // ordinary message: kept
    expect(persisted).not.toContain(SECRET_TOKEN);
    expect(persisted).not.toContain(SECRET_EMAIL);
    expect(persisted).not.toContain("Authorization");
    expect(persisted).not.toContain("cardLast4");
    expect(persisted).not.toContain('"config"');
  });

  it("does not mutate the caller's original error object", async () => {
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const originalError = new RealisticHttpClientError("boom");
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/sanitize-no-mutation",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        throw originalError;
      },
      async observe() {
        return { status: "observation_failed", error: { message: "n/a" }, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "UNKNOWN", reason: { code: "X", summary: "x" } })
    };

    await runEffect(store, contract, {
      identity: { id: "sanitize-no-mutation-1", operationType: contract.operationType },
      intent: {}
    });

    // The exact object thrown by the caller's own execute() must be untouched.
    expect(originalError.config.headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(originalError.response.data.customerEmail).toBe(SECRET_EMAIL);
  });

  it("a legitimately-named unrelated field is not accidentally stripped", async () => {
    // Guards against an overzealous implementation that scans for a field literally named
    // "raw" anywhere in the object graph, rather than only at transport.error.raw /
    // observation.error.raw specifically.
    const store = new PostgresStore(pool, { acknowledgePersistence: true });
    const contract: EffectContract<{ raw: string }, unknown, { raw: string }> = {
      operationType: "test/sanitize-unrelated-raw-field",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute({ intent }) {
        return { raw: intent.raw }; // an application field that happens to be named "raw"
      },
      async observe() {
        return { status: "observed", data: { raw: "unrelated-application-data" }, authoritative: true, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "APPLIED", reason: { code: "OK", summary: "ok" } })
    };

    const identity = { id: "sanitize-unrelated-raw-1", operationType: contract.operationType };
    await runEffect(store, contract, { identity, intent: { raw: "keep-me" } });

    const persisted = await rawPersistedJson(identity.id);
    expect(persisted).toContain("keep-me");
    expect(persisted).toContain("unrelated-application-data");
  });
});

describe("InMemoryStore keeps the full in-memory error.raw behavior", () => {
  // Thrown as a plain object rather than an Error subclass: InMemoryStore copies records via
  // structuredClone() for copy-safety (unrelated to this change), and structuredClone has a
  // platform limitation where custom properties on Error *subclass* instances are dropped
  // during cloning (verified directly — a real, pre-existing structuredClone behavior, not
  // something this change introduces or is expected to work around). Plain objects survive
  // structuredClone fully, which is what this test demonstrates: InMemoryStore's own
  // in-memory raw-error passthrough is otherwise completely unaffected by this change.
  const rawErrorShape = {
    message: "boom",
    config: { headers: { Authorization: `Bearer ${SECRET_TOKEN}` } },
    response: { data: { customerEmail: SECRET_EMAIL } }
  };

  it("still exposes the raw error value via the in-memory EffectResult", async () => {
    const store = new InMemoryStore();
    const contract: EffectContract<Record<string, never>, unknown, unknown> = {
      operationType: "test/inmemory-raw-preserved",
      capabilities: { nativeIdempotency: false, callerGeneratedIdentity: true, optimisticConcurrency: false, convergence: false },
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      async execute() {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw rawErrorShape;
      },
      async observe() {
        return { status: "observation_failed", error: { message: "n/a" }, source: "t", observedAt: new Date().toISOString() };
      },
      reconcile: () => ({ evidenceState: "UNKNOWN", reason: { code: "X", summary: "x" } })
    };

    const identity = { id: "inmemory-raw-1", operationType: contract.operationType };
    const result = await runEffect(store, contract, { identity, intent: {} });

    const latest = result.attempts[0];
    expect(latest.status).toBe("RESOLVED");
    const transport = latest.status === "RESOLVED" ? latest.transport : undefined;
    expect(transport?.ok).toBe(false);
    const raw = transport && !transport.ok ? (transport.error.raw as typeof rawErrorShape) : undefined;
    expect(raw?.config.headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
    expect(raw?.response.data.customerEmail).toBe(SECRET_EMAIL);
  });
});
