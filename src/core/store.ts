import type {
  AttemptRecord,
  OperationIdentity,
  OperationRecord,
  OperationStatus,
  ReasonCode,
  ReservedAttemptInput
} from "./types";

export interface NewOperationInput {
  identity: OperationIdentity;
  intent: unknown;
  status: OperationStatus;
  reviewReason?: ReasonCode;
}

/**
 * The store operations a coordinated runEffect() pass actually needs. Exposed both as
 * instance methods on EffectStore itself (for standalone/test use outside a lock) and as
 * OperationLock.store (bound to whatever session/connection holds the lock, so a pass never
 * needs a second connection for its own bookkeeping — see PostgresStore).
 */
export interface CoordinatedStore {
  getOperation(identityId: string): Promise<OperationRecord | null>;

  /** Must fail (or be a no-op returning the existing record) if identityId already exists. */
  createOperation(input: NewOperationInput): Promise<OperationRecord>;

  /**
   * Durably records that an attempt is about to be made, BEFORE execute() is ever called.
   * This is what lets a restart distinguish "never attempted" from "attempted, outcome
   * unknown" — see runtime.ts's crash-recovery path.
   */
  reserveAttempt(identityId: string, reserved: ReservedAttemptInput): Promise<OperationRecord>;

  appendAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord>;

  /** Replaces the latest attempt (RESERVED -> RESOLVED, or re-observing a PENDING attempt). */
  updateLatestAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord>;

  setStatus(identityId: string, status: OperationStatus): Promise<OperationRecord>;
}

export interface OperationLock {
  /** Store operations bound to this lock's session — use these, not the outer store, for the duration of a coordinated pass. */
  store: CoordinatedStore;
  /** Must be called exactly once, however the pass concludes (success or throw). */
  release(): Promise<void>;
}

/**
 * Minimal persistence surface for the reliability lifecycle. Deliberately narrow:
 * operation identity, intent, attempts, and their outcomes — not an audit platform.
 */
export interface EffectStore extends CoordinatedStore {
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
