import type { AttemptRecord, OperationIdentity, OperationRecord, OperationStatus, ReasonCode } from "./types";

export interface NewOperationInput {
  identity: OperationIdentity;
  intent: unknown;
  status: OperationStatus;
  reviewReason?: ReasonCode;
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
}
