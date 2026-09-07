import { decideDisposition } from "./disposition";
import type { EffectStore } from "./store";
import type {
  AttemptRecord,
  EffectContract,
  EffectRequest,
  EffectResult,
  ObservationResult,
  OperationRecord,
  OperationStatus,
  ReasonCode,
  TransportOutcome
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultReviewReason(): ReasonCode {
  return {
    code: "POLICY_REVIEW_REQUIRED",
    summary: "This operation requires human authorization before it will be attempted."
  };
}

/** execute() is caught here — a throw or timeout becomes transport evidence, never an uncaught rejection. */
async function safeExecute<Intent, Evidence>(
  contract: EffectContract<Intent, unknown, Evidence>,
  intent: Intent,
  identity: OperationRecord["identity"],
  attemptNumber: number
): Promise<TransportOutcome<Evidence>> {
  try {
    const evidence = await contract.execute({ intent, identity, attemptNumber });
    return { ok: true, evidence };
  } catch (err) {
    return { ok: false, error: { message: errorMessage(err), raw: err } };
  }
}

/** observe() is caught here — a throw becomes observation_failed, never UNKNOWN by accident being skipped. */
async function safeObserve<Intent, Observation, Evidence>(
  contract: EffectContract<Intent, Observation, Evidence>,
  intent: Intent,
  identity: OperationRecord["identity"],
  transport: TransportOutcome<Evidence>
): Promise<ObservationResult<Observation>> {
  try {
    return await contract.observe({ intent, identity, transport });
  } catch (err) {
    return {
      status: "observation_failed",
      error: { message: errorMessage(err), raw: err },
      source: contract.operationType,
      observedAt: nowIso()
    };
  }
}

function resultFromRecord<Observation>(record: OperationRecord): EffectResult<Observation> {
  const latest = record.attempts[record.attempts.length - 1];
  if (!latest) {
    return {
      identity: record.identity,
      status: record.status,
      evidenceState: null,
      disposition: "REVIEW",
      evidenceReason: null,
      dispositionReason: record.reviewReason ?? defaultReviewReason(),
      observation: null,
      attempts: record.attempts
    };
  }
  const latestObservation = latest.observations[latest.observations.length - 1] ?? null;
  return {
    identity: record.identity,
    status: record.status,
    evidenceState: latest.evidenceState,
    disposition: latest.disposition,
    evidenceReason: latest.evidenceReason,
    dispositionReason: latest.dispositionReason,
    observation: latestObservation as ObservationResult<Observation> | null,
    attempts: record.attempts
  };
}

async function performAttempt<Intent, Observation, Evidence>(
  store: EffectStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  record: OperationRecord,
  intent: Intent
): Promise<EffectResult<Observation>> {
  const attemptNumber = record.attempts.length + 1;
  const startedAt = nowIso();

  const transport = await safeExecute(contract, intent, record.identity, attemptNumber);
  const observation = await safeObserve(contract, intent, record.identity, transport);
  const reconciliation = contract.reconcile({ intent, transport, observation });
  const { disposition, reason: dispositionReason } = decideDisposition({
    evidenceState: reconciliation.evidenceState,
    attemptNumber,
    retryPolicy: contract.retryPolicy
  });

  const attempt: AttemptRecord = {
    attemptNumber,
    startedAt,
    updatedAt: nowIso(),
    transport: transport as TransportOutcome<unknown>,
    observations: [observation as ObservationResult<unknown>],
    evidenceState: reconciliation.evidenceState,
    evidenceReason: reconciliation.reason,
    disposition,
    dispositionReason
  };

  const nextStatus: OperationStatus =
    disposition === "RETRY" || reconciliation.evidenceState === "PENDING" ? "OPEN" : "CLOSED";

  const updated = await store.appendAttempt(record.identity.id, attempt, nextStatus);
  return resultFromRecord(updated);
}

/**
 * Re-observes a PENDING operation WITHOUT re-executing the underlying mutation.
 * Calling run() again for an operation whose latest evidence state is PENDING
 * takes this path, never performAttempt.
 */
async function reObserve<Intent, Observation, Evidence>(
  store: EffectStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  record: OperationRecord,
  intent: Intent,
  latest: AttemptRecord
): Promise<EffectResult<Observation>> {
  const transport = latest.transport as TransportOutcome<Evidence>;
  const observation = await safeObserve(contract, intent, record.identity, transport);
  const reconciliation = contract.reconcile({ intent, transport, observation });
  const { disposition, reason: dispositionReason } = decideDisposition({
    evidenceState: reconciliation.evidenceState,
    attemptNumber: latest.attemptNumber,
    retryPolicy: contract.retryPolicy
  });

  const updatedAttempt: AttemptRecord = {
    ...latest,
    updatedAt: nowIso(),
    observations: [...latest.observations, observation as ObservationResult<unknown>],
    evidenceState: reconciliation.evidenceState,
    evidenceReason: reconciliation.reason,
    disposition,
    dispositionReason
  };

  const nextStatus: OperationStatus =
    disposition === "RETRY" || reconciliation.evidenceState === "PENDING" ? "OPEN" : "CLOSED";

  const updated = await store.updateLatestAttempt(record.identity.id, updatedAttempt, nextStatus);
  return resultFromRecord(updated);
}

/**
 * Runs one lifecycle pass for the given intent/identity. Safe to call repeatedly with the
 * same identity: it only invokes execute() when doing so is actually safe (see docs/v0.1-spec.md).
 */
export async function runEffect<Intent, Observation, Evidence>(
  store: EffectStore,
  contract: EffectContract<Intent, Observation, Evidence>,
  request: EffectRequest<Intent>
): Promise<EffectResult<Observation>> {
  const existing = await store.getOperation(request.identity.id);

  if (!existing) {
    const auth = contract.authorize ? await contract.authorize(request.intent) : { requiresReview: false };
    const initialStatus: OperationStatus = auth.requiresReview ? "AWAITING_REVIEW" : "OPEN";
    const created = await store.createOperation({
      identity: request.identity,
      intent: request.intent,
      status: initialStatus,
      reviewReason: auth.requiresReview ? auth.reason ?? defaultReviewReason() : undefined
    });

    if (auth.requiresReview) {
      return resultFromRecord(created);
    }
    return await performAttempt(store, contract, created, request.intent);
  }

  if (existing.status === "CLOSED") {
    return resultFromRecord(existing);
  }

  if (existing.status === "AWAITING_REVIEW") {
    if (!request.reviewApproved) {
      return resultFromRecord(existing);
    }
    const reopened = await store.setStatus(existing.identity.id, "OPEN");
    return await performAttempt(store, contract, reopened, request.intent);
  }

  // status === "OPEN"
  const latest = existing.attempts[existing.attempts.length - 1];
  if (!latest) {
    return await performAttempt(store, contract, existing, request.intent);
  }

  if (latest.evidenceState === "PENDING") {
    return await reObserve(store, contract, existing, request.intent, latest);
  }

  if (latest.disposition === "RETRY") {
    return await performAttempt(store, contract, existing, request.intent);
  }

  // OPEN with a latest attempt that is neither PENDING nor RETRY shouldn't occur
  // (performAttempt/reObserve always close otherwise) — return current state rather than guessing.
  return resultFromRecord(existing);
}
