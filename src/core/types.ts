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
 * Informational only: the runtime never reads it (the retry decision is driven by RetryPolicy,
 * and late landings by maxInFlightMs). Useful as documentation of the operation for reviewers
 * and tooling; optional on EffectContract.
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
  /**
   * What reconcile() found, for the record (a receipt, the refund it located). Stored on the
   * attempt (ResolvedAttempt.observedEffect) when it's JSON-serializable; otherwise left out,
   * never failing the pass.
   */
  observedEffect?: unknown;
}

export interface AuthorizationResult {
  requiresReview: boolean;
  reason?: ReasonCode;
}

export interface AuthorizeInput<Context> {
  identity: OperationIdentity;
  /** EffectRequest.context from the call that creates the operation. Never stored. */
  context: Context | undefined;
}

/**
 * revalidate()'s answer before an attempt:
 * - `proceed`: make the attempt now.
 * - `requiresReview`: don't; the operation goes to AWAITING_REVIEW (disposition REVIEW) until a
 *   reviewer approves it, and revalidate() runs again before the attempt is made.
 * - `reject`: don't, ever. The operation is CLOSED with disposition REPLAN: if the action is
 *   still wanted, it needs a fresh decision and a new identity.
 */
export interface RevalidationResult {
  decision: "proceed" | "requiresReview" | "reject";
  reason?: ReasonCode;
}

/**
 * A reviewer's decision on an operation left AWAITING_REVIEW, passed to reviewEffect() (issue
 * #28). corrobo records it, binds it to the recorded intent and enforces `expiresAt`;
 * establishing that `reviewer` really is who they say, and may approve this, is your app's job
 * (before calling reviewEffect(), and in revalidate()).
 */
export interface ReviewDecision {
  decision: "approved" | "rejected";
  /**
   * The token of the review this decision answers: `EffectResult.reviewToken` from the result
   * that reported AWAITING_REVIEW, kept with whatever the reviewer was shown. Required. Each
   * time an operation goes to review it gets a new token, bound to the operation, that review
   * and the recorded intent, so a decision made on an earlier review screen can't approve a
   * later review of the same operation.
   */
  reviewToken: string;
  /** Who decided, as your app identifies them (a user id, an email). Required, non-empty. */
  reviewer: string;
  /** When they decided (RFC 3339 with Z or an offset). Defaults to when corrobo records it. */
  decidedAt?: string;
  /**
   * Approvals only (RFC 3339 with Z or an offset): no attempt whose recorded start time is at
   * or after this is made; it goes back to review with APPROVAL_EXPIRED. The start time is the
   * store-clock reading taken just before the attempt is reserved, so execute() itself is called
   * a reservation write later. Leave margin if that matters.
   */
  expiresAt?: string;
  /**
   * The fingerprint of the intent the reviewer was shown: `fingerprintIntent(contract, intent)`.
   * When given and it differs from the recorded intent's, the decision is refused (throws) and
   * nothing changes, so an approval of what was on screen can't apply to something else.
   */
  intentFingerprint?: string;
  note?: string;
}

/** A review decision as corrobo recorded it on the operation (OperationRecord.review). */
export interface RecordedReview {
  decision: "approved" | "rejected";
  reviewer: string;
  decidedAt: string;
  expiresAt?: string;
  note?: string;
  /** Fingerprint of the recorded intent this decision applies to. */
  intentFingerprint: string;
  /** When corrobo recorded it, from the store's clock when it has one. */
  recordedAt: string;
  /** The review this decision answered (ReviewEpisode.token). */
  reviewToken: string;
  /**
   * How many attempts were recorded when the decision was. When an approval follows earlier
   * attempts, the next runEffect() re-observes the latest one before executing again: time
   * passed while the operation waited for review.
   */
  attemptCount: number;
}

/**
 * One period of an operation awaiting review. A new one begins every time the operation goes to
 * review (authorize() at creation, revalidate() asking for review, an approval that expired or
 * can't be attributed), and only a decision carrying its token is accepted.
 */
export interface ReviewEpisode {
  /** Opaque. Bound to this operation, this episode and the recorded intent. */
  token: string;
  /** 1 the first time the operation awaited review, +1 each time after. */
  generation: number;
  /** When this review began, from the store's clock. A decision dated earlier was made for something else. */
  openedAt: string;
  /**
   * A decision without a token (recorded by corrobo 0.4.0) that was on record when this review
   * opened. It is moved here, out of OperationRecord.review, because it predates this review and
   * never answers it; kept for the audit trail. Any tokenless decision on the record after that
   * was written later, so it answers this review.
   */
  supersededDecision?: TokenlessReview;
}

/** A decision recorded by corrobo 0.4.0, which kept no review token (or reviewer, or attempt count, in some records). */
export type TokenlessReview = Omit<RecordedReview, "reviewToken" | "reviewer" | "attemptCount"> & {
  reviewToken?: undefined;
  reviewer: string | null;
  attemptCount?: number;
};

/** What reviewEffect() takes: which operation, and the reviewer's decision on it. */
export interface ReviewRequest {
  /** The operation's identity, exactly as runEffect() was given it (a string id or the object form). */
  identity: OperationIdentity | string;
  decision: ReviewDecision;
}

export interface RevalidateInput<Intent, Context> {
  intent: Intent;
  identity: OperationIdentity;
  /** The attempt about to be made: 1 for the first. */
  attemptNumber: number;
  /**
   * The approval this operation is proceeding under, if it went through review (already
   * checked by corrobo against the recorded intent and its expiresAt). Check your own approver
   * policy here: who may approve what, whether the approver is the requester, and so on.
   */
  approval: RecordedReview | null;
  /** The operation as recorded right now (earlier attempts, status). Changing it changes nothing. */
  record: OperationRecord;
  /**
   * EffectRequest.context from THIS call, which may not be whoever started the operation (by
   * attempt 2 it may be a background worker). Never stored or fingerprinted.
   */
  context: Context | undefined;
}

/**
 * What was checked before an attempt: revalidate()'s result, and/or corrobo's own checks of the
 * approval (APPROVAL_EXPIRED, APPROVAL_INTENT_MISMATCH). Recorded whenever the contract has
 * revalidate() or the operation went through review. `failed` means revalidate() threw or
 * returned something that isn't a RevalidationResult: nothing was executed and the operation
 * stays OPEN, so a later call checks again.
 */
export interface PreExecuteCheck {
  outcome: "proceed" | "requiresReview" | "reject" | "failed";
  reason: ReasonCode;
  /** The approval in force when the check ran, if the operation went through review. */
  approval?: RecordedReview;
  /** The attempt this check was for. */
  attemptNumber: number;
  /** From the store's clock when it has one (see CoordinatedStore.now). */
  checkedAt: string;
}

/** A check that stopped an attempt, as kept on the operation (no attempt exists to carry it). */
export interface BlockingCheck extends PreExecuteCheck {
  outcome: "requiresReview" | "reject" | "failed";
  /**
   * The record version this check was written at. It explains the operation's current state
   * only while OperationRecord.version still equals it; any later write supersedes it.
   */
  recordVersion: number;
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

export interface EffectContract<Intent, Observation, Evidence, Context = unknown> {
  operationType: string;
  /** Optional, informational description of the operation type (see OperationCapabilities). */
  capabilities?: OperationCapabilities;
  retryPolicy: RetryPolicy;
  /**
   * Routing decision made once, when the operation is first recorded: does this action need
   * human sign-off before anything is executed? Returning requiresReview:true produces
   * disposition REVIEW directly — a known action needing authorization, never a
   * reconciliation outcome. Whether it is still valid to act at the moment of each attempt is
   * revalidate()'s question, not this one's.
   */
  authorize?(intent: Intent, input: AuthorizeInput<Context>): AuthorizationResult | Promise<AuthorizationResult>;
  /**
   * Runs under the operation's lock immediately before EVERY attempt, including the first
   * (after an approval, and after a RETRY's settlement check), and before the attempt is
   * reserved: "is it still valid to do this now?" (the order may have been cancelled, the
   * caller's scope may have changed, an approval may have expired). It only ever gates a new
   * execute(); it never blocks finding out what an earlier attempt did, so a late landing is
   * still recognized as APPLIED even if revalidate() would now say no.
   *
   * If it throws (or returns something invalid), nothing is executed and the operation stays
   * OPEN with reason REVALIDATION_FAILED. The result is recorded: on the attempt when it
   * proceeds, on the operation (OperationRecord.blockedBy) when it doesn't.
   *
   * It narrows the window between deciding and acting; it can't close it. State can still
   * change between revalidate() and execute(), so use the provider's conditional writes
   * (a version or ETag precondition) where it has them.
   */
  revalidate?(input: RevalidateInput<Intent, Context>): RevalidationResult | Promise<RevalidationResult>;
  execute(input: ExecuteInput<Intent>): Promise<Evidence>;
  observe(input: ObserveInput<Intent, Evidence>): Promise<ObservationResult<Observation>>;
  reconcile(input: ReconcileInput<Intent, Observation, Evidence>): ReconciliationResult;
  /**
   * Optional deterministic fingerprint of an intent, used to detect a reused operation
   * identity being applied to a logically different intent (see runtime.ts). Defaults to a
   * stable, key-sorted JSON serialization (src/core/fingerprint.ts) when omitted — provide
   * this only if that default would treat two meaningfully-different intents as equal, or
   * two meaningfully-equal intents as different, for this operation type.
   *
   * With a custom fingerprint, once the operation is recorded every later call acts on the
   * recorded intent (as the store returns it: from PostgresStore, its JSON form), never on the
   * later request's: two intents your fingerprint calls equal are the same operation, and the
   * one that was recorded (and reviewed) is the one executed.
   */
  fingerprintIntent?(intent: Intent): string;
  /**
   * Upper bound, in milliseconds, on how long after an attempt starts its effect could still
   * land at the external system — at least your execute() client timeout plus any
   * provider-side processing delay. The attempt's start is read just before its reservation is
   * written, so include a margin for that write too. Consulted only when evidence is NOT_APPLIED but execute()
   * failed at the transport level (or its outcome was never recorded because the process
   * died): a timed-out request may still be in flight, so an immediate "not applied"
   * observation does not yet prove it never will be.
   *
   * - Omitted: that case resolves to INVESTIGATE, never an automatic RETRY.
   * - Set: RETRY is allowed, but not before `attemptStartedAt + maxInFlightMs`; the next
   *   runEffect() after that point re-observes first (catching a late landing) before
   *   executing again.
   * - `0`: only honest when re-executing is deduplicated by the provider (e.g. an idempotency
   *   key that stays the same across attempts) or the request provably never left the process.
   */
  maxInFlightMs?: number;
  /**
   * The longest an approval for this operation type is good for, in milliseconds, counted from
   * when it was decided (or recorded, if that was earlier). It applies whether or not the
   * decision has its own `expiresAt` (the earlier of the two wins), so a review screen that
   * forgets to set one can't produce an approval that never expires. An approval that ages out
   * before an attempt sends the operation back to review (APPROVAL_EXPIRED). Omit it to let
   * approvals without `expiresAt` cover every later attempt.
   */
  maxApprovalAgeMs?: number;
}

/** An attempt whose outcome is not yet known — persisted BEFORE execute() is ever called. */
export interface ReservedAttempt {
  status: "RESERVED";
  attemptNumber: number;
  startedAt: string;
  updatedAt: string;
  /** What was checked before this attempt (see PreExecuteCheck), when anything was. */
  check?: PreExecuteCheck;
  /**
   * The contract's maxInFlightMs when this attempt started. Settlement for this attempt never
   * uses a shorter window, even if a later deploy declares one (a request already in flight
   * can still take as long as the window it was sent under).
   */
  maxInFlightMs?: number;
}

/** An attempt whose outcome has been established via execute()/observe()/reconcile(). */
export interface ResolvedAttempt {
  status: "RESOLVED";
  attemptNumber: number;
  startedAt: string;
  updatedAt: string;
  transport: TransportOutcome<unknown>;
  /**
   * More than one entry only when re-observed (while PENDING, or settling before a retry). Kept
   * bounded: the first observation and the most recent ones (at most 20 in all), so an
   * operation that stays PENDING for a long time doesn't grow its record without limit.
   */
  observations: ObservationResult<unknown>[];
  /** reconcile()'s observedEffect from the latest observation, when it was JSON-serializable. */
  observedEffect?: unknown;
  evidenceState: EvidenceState;
  /** Why the evidence state was determined (from reconcile()). */
  evidenceReason: ReasonCode;
  /** null exactly when evidenceState is PENDING: no action is safe to recommend yet. */
  disposition: RecoveryDisposition | null;
  /** Why that disposition was chosen (from decideDisposition()). */
  dispositionReason: ReasonCode;
  /**
   * Set only with disposition RETRY when the NOT_APPLIED evidence was observed while the
   * failed execute() could still have been in flight (see EffectContract.maxInFlightMs).
   * runEffect() will not execute again before this time, and re-observes first after it.
   */
  retryNotBefore?: string;
  /** What was checked before this attempt (see PreExecuteCheck), when anything was. */
  check?: PreExecuteCheck;
  /**
   * The contract's maxInFlightMs when this attempt started. Settlement for this attempt never
   * uses a shorter window, even if a later deploy declares one (a request already in flight
   * can still take as long as the window it was sent under).
   */
  maxInFlightMs?: number;
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
  /** Must be stored on the reserved attempt when present. */
  check?: PreExecuteCheck;
  /** Must be stored on the reserved attempt when present (see ReservedAttempt.maxInFlightMs). */
  maxInFlightMs?: number;
}

export interface OperationRecord {
  identity: OperationIdentity;
  intent: unknown;
  status: OperationStatus;
  /** Set only when status is (or was) AWAITING_REVIEW — no attempt exists yet to carry this reason. */
  reviewReason?: ReasonCode;
  attempts: AttemptRecord[];
  /** The most recent check that stopped an attempt (see BlockingCheck.recordVersion). */
  blockedBy?: BlockingCheck;
  /** The latest review decision, when the operation went through review. */
  review?: RecordedReview;
  /** The current (or latest) review, when the operation has awaited review. */
  reviewEpisode?: ReviewEpisode;
  createdAt: string;
  updatedAt: string;
  /**
   * Optimistic-concurrency version: 0 when created, +1 on every successful write. Every store
   * write must name the version it read (see CoordinatedStore), so a caller whose lock was
   * lost mid-pass can never overwrite what another caller has since recorded.
   */
  version: number;
}

/**
 * What runEffect() takes. It has no way to approve anything: review decisions are recorded with
 * reviewEffect() (corrobo 0.3's `reviewDecision` field was removed in 0.4).
 */
export interface EffectRequest<Intent, Context = unknown> {
  /**
   * The operation's stable identity. A string is shorthand for
   * `{ id, operationType: contract.operationType }`; if you pass the object form, its
   * operationType must equal the contract's.
   */
  identity: OperationIdentity | string;
  intent: Intent;
  /**
   * Who is calling and with what scope, for authorize() and revalidate() to check. Per call:
   * not stored, not part of the intent's fingerprint.
   */
  context?: Context;
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
  /** Earliest time a RETRY may proceed (see ResolvedAttempt.retryNotBefore); null otherwise. */
  retryNotBefore: string | null;
  /** The latest review decision on this operation (OperationRecord.review), or null. */
  review: RecordedReview | null;
  /**
   * While AWAITING_REVIEW: the token a decision on this review must carry (ReviewDecision.
   * reviewToken). Keep it with what you show the reviewer. null otherwise.
   */
  reviewToken: string | null;
}
