import { describe, expect, it } from "vitest";
import { decideDisposition } from "../src/core/disposition";
import type { RetryPolicy } from "../src/core/types";

const retryPolicy: RetryPolicy = { maxAttempts: 3, retryOnNotApplied: true };

describe("decideDisposition", () => {
  it("APPLIED -> COMPLETE", () => {
    const result = decideDisposition({ evidenceState: "APPLIED", attemptNumber: 1, retryPolicy });
    expect(result.disposition).toBe("COMPLETE");
  });

  it("CONFLICTED -> REPLAN", () => {
    const result = decideDisposition({ evidenceState: "CONFLICTED", attemptNumber: 1, retryPolicy });
    expect(result.disposition).toBe("REPLAN");
  });

  it("UNKNOWN -> INVESTIGATE, never RETRY", () => {
    const result = decideDisposition({ evidenceState: "UNKNOWN", attemptNumber: 1, retryPolicy });
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("PENDING -> no disposition (null), not treated as failure", () => {
    const result = decideDisposition({ evidenceState: "PENDING", attemptNumber: 1, retryPolicy });
    expect(result.disposition).toBeNull();
    expect(result.reason.code).toBe("AWAITING_CONVERGENCE");
  });

  it("NOT_APPLIED with attempts remaining and retry allowed -> RETRY", () => {
    const result = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 1, retryPolicy });
    expect(result.disposition).toBe("RETRY");
  });

  it("NOT_APPLIED with retry exhausted -> INVESTIGATE, represented conservatively", () => {
    const exhausted: RetryPolicy = { maxAttempts: 1, retryOnNotApplied: true };
    const result = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 1, retryPolicy: exhausted });
    expect(result.disposition).toBe("INVESTIGATE");
    expect(result.reason.metadata).toMatchObject({ attemptNumber: 1, maxAttempts: 1 });
  });

  it("NOT_APPLIED not declared retryable for this operation type -> INVESTIGATE, not RETRY", () => {
    const noRetry: RetryPolicy = { maxAttempts: 5, retryOnNotApplied: false };
    const result = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 1, retryPolicy: noRetry });
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("UNKNOWN cannot be configured into RETRY — retryOnNotApplied only affects NOT_APPLIED", () => {
    const alwaysRetry: RetryPolicy = { maxAttempts: 5, retryOnNotApplied: true };
    const result = decideDisposition({ evidenceState: "UNKNOWN", attemptNumber: 1, retryPolicy: alwaysRetry });
    expect(result.disposition).toBe("INVESTIGATE");
  });

  it("PENDING cannot be configured into RETRY — it never carries a disposition", () => {
    const alwaysRetry: RetryPolicy = { maxAttempts: 5, retryOnNotApplied: true };
    const result = decideDisposition({ evidenceState: "PENDING", attemptNumber: 1, retryPolicy: alwaysRetry });
    expect(result.disposition).toBeNull();
  });

  it("is deterministic: identical input always produces identical output", () => {
    const a = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 2, retryPolicy });
    const b = decideDisposition({ evidenceState: "NOT_APPLIED", attemptNumber: 2, retryPolicy });
    expect(a).toEqual(b);
  });
});
