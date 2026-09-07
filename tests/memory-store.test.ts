import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import type { AttemptRecord } from "../src/core/types";

const nowIso = () => new Date().toISOString();

function sampleAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptNumber: 1,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    transport: { ok: true, evidence: { httpStatus: 200 } },
    observations: [{ status: "observed", data: { ok: true }, authoritative: true, source: "t", observedAt: nowIso() }],
    evidenceState: "APPLIED",
    evidenceReason: { code: "OK", summary: "ok" },
    disposition: "COMPLETE",
    dispositionReason: { code: "EFFECT_CONFIRMED", summary: "ok" },
    ...overrides
  };
}

describe("InMemoryStore", () => {
  it("returns null for an unknown identity", async () => {
    const store = new InMemoryStore();
    expect(await store.getOperation("nope")).toBeNull();
  });

  it("creates and retrieves an operation", async () => {
    const store = new InMemoryStore();
    const created = await store.createOperation({
      identity: { id: "a", operationType: "t" },
      intent: { x: 1 },
      status: "OPEN"
    });
    expect(created.attempts).toEqual([]);
    const fetched = await store.getOperation("a");
    expect(fetched?.intent).toEqual({ x: 1 });
  });

  it("rejects creating the same identity twice", async () => {
    const store = new InMemoryStore();
    await store.createOperation({ identity: { id: "dup", operationType: "t" }, intent: {}, status: "OPEN" });
    await expect(
      store.createOperation({ identity: { id: "dup", operationType: "t" }, intent: {}, status: "OPEN" })
    ).rejects.toThrow(/already exists/);
  });

  it("appends attempts and updates status", async () => {
    const store = new InMemoryStore();
    await store.createOperation({ identity: { id: "b", operationType: "t" }, intent: {}, status: "OPEN" });
    const updated = await store.appendAttempt("b", sampleAttempt(), "CLOSED");
    expect(updated.attempts).toHaveLength(1);
    expect(updated.status).toBe("CLOSED");
  });

  it("updateLatestAttempt replaces only the last attempt", async () => {
    const store = new InMemoryStore();
    await store.createOperation({ identity: { id: "c", operationType: "t" }, intent: {}, status: "OPEN" });
    await store.appendAttempt("c", sampleAttempt({ evidenceState: "PENDING", disposition: null }), "OPEN");
    const resolved = await store.updateLatestAttempt("c", sampleAttempt({ evidenceState: "APPLIED", disposition: "COMPLETE" }), "CLOSED");
    expect(resolved.attempts).toHaveLength(1);
    expect(resolved.attempts[0].evidenceState).toBe("APPLIED");
    expect(resolved.status).toBe("CLOSED");
  });

  it("returned records are copies — mutating them does not affect the store", async () => {
    const store = new InMemoryStore();
    const created = await store.createOperation({ identity: { id: "d", operationType: "t" }, intent: {}, status: "OPEN" });
    (created as { status: string }).status = "CLOSED";
    const fetched = await store.getOperation("d");
    expect(fetched?.status).toBe("OPEN");
  });
});
