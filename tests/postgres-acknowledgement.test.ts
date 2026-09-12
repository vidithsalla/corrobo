import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InMemoryStore } from "../src/stores/memory";
import { PostgresStore } from "../src/stores/postgres";

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("PostgresStore requires explicit persistence acknowledgement", () => {
  it("constructs normally with { acknowledgePersistence: true }", () => {
    const pool = new Pool({ connectionString });
    expect(() => new PostgresStore(pool, { acknowledgePersistence: true })).not.toThrow();
    void pool.end();
  });

  it("throws a clear error when the options object is missing entirely", () => {
    const pool = new Pool({ connectionString });
    // Cast through `any` to simulate a plain-JS/untyped caller bypassing TypeScript's
    // compile-time requirement — the runtime check must still catch this.
    const Ctor = PostgresStore as unknown as new (p: Pool) => PostgresStore;
    expect(() => new Ctor(pool)).toThrow(/acknowledgePersistence/);
    void pool.end();
  });

  it("throws a clear error when acknowledgePersistence is false", () => {
    const pool = new Pool({ connectionString });
    const Ctor = PostgresStore as unknown as new (p: Pool, o: { acknowledgePersistence: boolean }) => PostgresStore;
    expect(() => new Ctor(pool, { acknowledgePersistence: false })).toThrow(/acknowledgePersistence/);
    void pool.end();
  });

  it("throws a clear error when the options object is malformed (missing the key)", () => {
    const pool = new Pool({ connectionString });
    const Ctor = PostgresStore as unknown as new (p: Pool, o: Record<string, unknown>) => PostgresStore;
    expect(() => new Ctor(pool, {})).toThrow(/acknowledgePersistence/);
    void pool.end();
  });

  it("the thrown message explains what is persisted and how to opt in", () => {
    const pool = new Pool({ connectionString });
    const Ctor = PostgresStore as unknown as new (p: Pool) => PostgresStore;
    try {
      new Ctor(pool);
      throw new Error("expected constructor to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/intent/);
      expect(message).toMatch(/does not automatically expire/);
      expect(message).toMatch(/acknowledgePersistence: true/);
    }
    void pool.end();
  });

  it("PostgresStore.migrate() remains usable without any acknowledgement", async () => {
    const pool = new Pool({ connectionString });
    await expect(PostgresStore.migrate(pool)).resolves.toBeUndefined();
    await pool.end();
  });
});

describe("InMemoryStore requires no acknowledgement of any kind", () => {
  it("constructs with zero arguments and zero permission gates", () => {
    expect(() => new InMemoryStore()).not.toThrow();
  });
});
