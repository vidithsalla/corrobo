import type { AttemptRecord, OperationIdentity, OperationRecord, OperationStatus, ReasonCode } from "./types";

export interface NewOperationInput {
  identity: OperationIdentity;
  intent: unknown;
  status: OperationStatus;
  reviewReason?: ReasonCode;
}

export interface OperationLock {
  /** Must be called exactly once, however the pass concludes (success or throw). */
  release(): Promise<void>;
}

/**
 * Minimal persistence surface for the reliability lifecycle. Deliberately narrow:
 * operation identity, intent, attempts, and their outcomes — not an audit platform.
 */
export interface EffectStore {
  getOperation(identityId: string): Promise<OperationRecord | null>;

  /** Must fail (or be a no-op returning the existing record) if identityId already exists. */
  createOperation(input: NewOperationInput): Promise<OperationRecord>;

  appendAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord>;

  /** Replaces the latest attempt's observation list/evidence/disposition — used for re-observing a PENDING operation. */
  updateLatestAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord>;

  setStatus(identityId: string, status: OperationStatus): Promise<OperationRecord>;

  /**
   * Non-blocking attempt to become the sole coordinator of this operation identity for the
   * duration of one runEffect() pass. Returns null immediately if another caller already
   * holds it — callers MUST NOT wait/retry internally; the loser returns the operation's
   * current recorded state (or an "in progress" placeholder) and it is up to the application
   * to call run() again if it needs a fresher answer. Must survive a crash without leaving a
   * permanent lock: PostgresStore uses a session-scoped advisory lock (released automatically
   * if the connection dies), InMemoryStore uses an in-process mutex (no cross-process meaning).
   */
  tryAcquireLock(identityId: string): Promise<OperationLock | null>;
}
