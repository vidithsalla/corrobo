/**
 * Core types for corrobo.
 *
 * Evidence state = what the available evidence establishes about the world.
 * Recovery disposition = what is safe to do next.
 * These are deliberately kept as two separate vocabularies (see docs/v0.1-spec.md, section F).
 */

export type EvidenceState = "APPLIED" | "NOT_APPLIED" | "CONFLICTED" | "PENDING" | "UNKNOWN";

export type RecoveryDisposition = "COMPLETE" | "RETRY" | "REPLAN" | "REVIEW" | "INVESTIGATE";

export type OperationStatus = "AWAITING_REVIEW" | "OPEN" | "CLOSED";

export interface OperationIdentity {
  /** Caller-generated, globally unique for this operation's attempt series. */
  id: string;
  operationType: string;
}

export interface ReasonCode {
  code: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export type TransportOutcome<Evidence> =
  | { ok: true; evidence: Evidence }
  | { ok: false; error: { message: string; raw?: unknown } };

export type ObservationResult<Observation> =
  | { status: "observed"; data: Observation; authoritative: boolean; source: string; observedAt: string }
  | { status: "pending"; authoritative: boolean; source: string; observedAt: string; data?: Observation }
  | { status: "observation_failed"; error: { message: string; raw?: unknown }; source: string; observedAt: string };

/**
 * Describes capabilities of an OPERATION TYPE, not a vendor/integration as a whole —
 * the pressure test found idempotency/versioning support can differ between two
 * operations on the same API (e.g. GitHub merge_pull_request vs. update_issue).
 * Informational/diagnostic; the actual retry decision is driven by RetryPolicy.
 */
export interface OperationCapabilities {
  nativeIdempotency: boolean;
  callerGeneratedIdentity: boolean;
  optimisticConcurrency: boolean;
  /** PENDING is an expected, normal outcome for this operation type (e.g. async/declarative systems). */
  convergence: boolean;
}

/**
 * Only NOT_APPLIED is ever a candidate for automatic RETRY — APPLIED always completes,
 * CONFLICTED always replans, PENDING never carries a disposition, and UNKNOWN always
 * investigates. There is deliberately no way to configure any of those into an automatic
 * retry: a field that looked like it accepted "any evidence state" but silently honored only
 * one was worse than a narrower, honest boolean.
 */
export interface RetryPolicy {
  maxAttempts: number;
  retryOnNotApplied: boolean;
}

export interface ReconciliationResult {
  evidenceState: EvidenceState;
  reason: ReasonCode;
  observedEffect?: unknown;
}

export interface AuthorizationResult {
  requiresReview: boolean;
  reason?: ReasonCode;
}

export interface ExecuteInput<Intent> {
  intent: Intent;
  identity: OperationIdentity;
  attemptNumber: number;
}

export interface ObserveInput<Intent, Evidence> {
  intent: Intent;
  identity: OperationIdentity;
  transport: TransportOutcome<Evidence>;
  /**
   * When this attempt was reserved/started (ISO timestamp) — before execute() was ever
   * called. Lets a contract reason about time-bounded evidence validity (e.g. a payment
   * provider's idempotency-key replay window) without corrobo inventing a generic
   * "freshness" concept it can't honestly define for every API.
   */
  attemptStartedAt: string;
}

export interface ReconcileInput<Intent, Observation, Evidence> {
  intent: Intent;
  transport: TransportOutcome<Evidence>;
  observation: ObservationResult<Observation>;
}

export interface EffectContract<Intent, Observation, Evidence> {
  operationType: string;
  capabilities: OperationCapabilities;
  retryPolicy: RetryPolicy;
  /**
   * Policy gate evaluated BEFORE execute() is ever called. Returning requiresReview:true
   * produces disposition REVIEW directly — this is a known action needing authorization,
   * never a reconciliation outcome.
   */
  authorize?(intent: Intent): AuthorizationResult | Promise<AuthorizationResult>;
  execute(input: ExecuteInput<Intent>): Promise<Evidence>;
  observe(input: ObserveInput<Intent, Evidence>): Promise<ObservationResult<Observation>>;
  reconcile(input: ReconcileInput<Intent, Observation, Evidence>): ReconciliationResult;
  /**
   * Optional deterministic fingerprint of an intent, used to detect a reused operation
   * identity being applied to a logically different intent (see runtime.ts). Defaults to a
   * stable, key-sorted JSON serialization (src/core/fingerprint.ts) when omitted — provide
   * this only if that default would treat two meaningfully-different intents as equal, or
   * two meaningfully-equal intents as different, for this operation type.
   */
  fingerprintIntent?(intent: Intent): string;
}

/** An attempt whose outcome is not yet known — persisted BEFORE execute() is ever called. */
export interface ReservedAttempt {
  status: "RESERVED";
  attemptNumber: number;
  startedAt: string;
  updatedAt: string;
}

/** An attempt whose outcome has been established via execute()/observe()/reconcile(). */
export interface ResolvedAttempt {
  status: "RESOLVED";
  attemptNumber: number;
  startedAt: string;
  updatedAt: string;
  transport: TransportOutcome<unknown>;
  /** More than one entry only when re-observed while evidenceState was PENDING. */
  observations: ObservationResult<unknown>[];
  evidenceState: EvidenceState;
  /** Why the evidence state was determined (from reconcile()). */
  evidenceReason: ReasonCode;
  /** null exactly when evidenceState is PENDING: no action is safe to recommend yet. */
  disposition: RecoveryDisposition | null;
  /** Why that disposition was chosen (from decideDisposition()). */
  dispositionReason: ReasonCode;
}

/**
 * An attempt's lifecycle: RESERVED durably records that execution is about to be attempted,
 * before any external call happens, specifically so a restart can never mistake "we reserved
 * this attempt but don't know what happened" for "this was never attempted." It resolves to
 * RESOLVED in place (see EffectStore.updateLatestAttempt) once execute()/observe()/reconcile()
 * have run. This lifecycle is an internal/store concern — it does not add a sixth evidence
 * state or disposition.
 */
export type AttemptRecord = ReservedAttempt | ResolvedAttempt;

export interface ReservedAttemptInput {
  attemptNumber: number;
  startedAt: string;
}

export interface OperationRecord {
  identity: OperationIdentity;
  intent: unknown;
  status: OperationStatus;
  /** Set only when status is (or was) AWAITING_REVIEW — no attempt exists yet to carry this reason. */
  reviewReason?: ReasonCode;
  attempts: AttemptRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface EffectRequest<Intent> {
  identity: OperationIdentity;
  intent: Intent;
  /** Set on a subsequent call to resolve an operation left AWAITING_REVIEW. */
  reviewDecision?: "approved" | "rejected";
}

export interface EffectResult<Observation> {
  identity: OperationIdentity;
  status: OperationStatus;
  evidenceState: EvidenceState | null;
  disposition: RecoveryDisposition | null;
  evidenceReason: ReasonCode | null;
  dispositionReason: ReasonCode;
  observation: ObservationResult<Observation> | null;
  attempts: AttemptRecord[];
}
