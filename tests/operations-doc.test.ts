import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresStore } from "../src/stores/postgres";

/** Every SQL block in docs/operations.md must run against the current schema. */
const doc = readFileSync(join(__dirname, "..", "docs", "operations.md"), "utf8");
const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim());

const connectionString = process.env.CORROBO_TEST_DATABASE_URL;

describe("docs/operations.md", () => {
  it("has SQL to check", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(7);
  });
});

describe.skipIf(!connectionString)("docs/operations.md SQL against Postgres", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await PostgresStore.migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(blocks.map((sql, i) => [i + 1, sql] as const))("query %i runs", async (_n, sql) => {
    await expect(pool.query(sql)).resolves.toBeDefined();
  });
});
