import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    // The Postgres-backed test files share one physical scratch database and TRUNCATE it
    // around their tests. Running test files in parallel let two files' TRUNCATEs and
    // inserts interleave and stomp on each other — a shared-fixture problem, not a bug in
    // the code under test. Sequential file execution keeps that isolated.
    fileParallelism: false
  }
});
