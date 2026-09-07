import type { EvidenceState, ReasonCode, RecoveryDisposition, RetryPolicy } from "./types";

export interface DecideDispositionInput {
  evidenceState: EvidenceState;
  attemptNumber: number;
  retryPolicy: RetryPolicy;
}

export interface DecideDispositionResult {
  disposition: RecoveryDisposition | null;
  reason: ReasonCode;
}

function reason(code: string, summary: string, metadata?: Record<string, unknown>): ReasonCode {
  return metadata ? { code, summary, metadata } : { code, summary };
}

/**
 * Pure, deterministic mapping from evidence state to recovery disposition.
 * This is the ONLY place that mapping happens — no other code should infer
 * a disposition from evidence state directly.
 */
export function decideDisposition(input: DecideDispositionInput): DecideDispositionResult {
  const { evidenceState, attemptNumber, retryPolicy } = input;

  switch (evidenceState) {
    case "APPLIED":
      return {
        disposition: "COMPLETE",
        reason: reason("EFFECT_CONFIRMED", "Authoritative observation confirms the intended effect.")
      };

    case "CONFLICTED":
      return {
        disposition: "REPLAN",
        reason: reason(
          "STATE_CONFLICT",
          "Authoritative state diverged from what the plan assumed; a new plan is required, not a retry of this operation."
        )
      };

    case "UNKNOWN":
      return {
        disposition: "INVESTIGATE",
        reason: reason(
          "EVIDENCE_INSUFFICIENT",
          "Available evidence cannot establish whether the effect occurred. Retrying blindly would risk a duplicate."
        )
      };

    case "PENDING":
      return {
        disposition: null,
        reason: reason(
          "AWAITING_CONVERGENCE",
          "The effect is acknowledged but not yet confirmed. Re-observe later; do not retry or treat as failure."
        )
      };

    case "NOT_APPLIED": {
      const retryable = retryPolicy.retryableEvidenceStates.includes("NOT_APPLIED");
      const hasAttemptsRemaining = attemptNumber < retryPolicy.maxAttempts;
      if (retryable && hasAttemptsRemaining) {
        return {
          disposition: "RETRY",
          reason: reason(
            "SAFE_RETRY",
            "Evidence shows the effect did not occur and this operation type is safe to retry."
          )
        };
      }
      return {
        disposition: "INVESTIGATE",
        reason: reason(
          "RETRY_NOT_SAFE_OR_EXHAUSTED",
          "The effect did not occur, but retry is exhausted or not permitted for this operation type.",
          { attemptNumber, maxAttempts: retryPolicy.maxAttempts, retryable }
        )
      };
    }
  }
}
