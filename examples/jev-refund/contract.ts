import type { EffectContract } from "../../src/core/types";
import type { RefundJudgmentProvider } from "./judgment-provider";
import type { FakeRefundLedger } from "./fake-refund-ledger";
import type { RefundObservationData, RefundRequestIntent, RefundTransportEvidence } from "./types";

/**
 * The flagship Jev + corrobo example. Demonstrates the intended flow end to end:
 *
 *   application state -> Jev typed judgment -> deterministic threshold/policy
 *     -> corrobo authorize() -> execute() -> authoritative observe() -> reconcile()
 *     -> evidence state + recovery disposition
 *
 * Jev's role is bounded to authorize(), evaluated BEFORE execute() is ever called. It answers
 * "should this be attempted automatically, or does it need a human?" — a probability, not a
 * decision. The deterministic thresholds below are what turn that probability into policy;
 * Jev's own output never becomes a requiresReview decision by itself.
 *
 * Jev is NEVER consulted in observe() or reconcile(). Once execute() has been attempted,
 * only authoritative state from the ledger can establish what actually happened — see
 * docs/jev-integration.md #9 (the authoritative-state rule) for why this boundary matters.
 */

/** Below this confidence, Jev's own answer is too uncertain to act on automatically. */
const CONFIDENCE_THRESHOLD = 0.7;
/** Above this risk score (0-1), automatic execution is not allowed regardless of confidence. */
const RISK_THRESHOLD = 0.4;
/** Below this probability, the request isn't clearly a refund at all. */
const IS_REFUND_THRESHOLD = 0.5;

export function idempotencyKeyFor(operationId: string): string {
  return `jev-refund:${operationId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createJevRefundContract(options: {
  judgmentProvider: RefundJudgmentProvider;
  ledger: FakeRefundLedger;
}): EffectContract<RefundRequestIntent, RefundObservationData, RefundTransportEvidence> {
  const { judgmentProvider, ledger } = options;

  return {
    operationType: "jev-example/refund",
    capabilities: {
      nativeIdempotency: true,
      callerGeneratedIdentity: true,
      optimisticConcurrency: false,
      convergence: false
    },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },

    async authorize(intent) {
      // Only the free-text request and the amount are sent to Jev — see
      // docs/jev-integration.md #8 for why nothing else (no identifiers, no payment
      // instruments) crosses this boundary.
      const judgment = await judgmentProvider.assess({
        requestText: intent.requestText,
        amountCents: intent.amountCents
      });

      // Small, intentional audit record — never the raw provider response. See
      // docs/jev-integration.md #5. This is application-owned metadata; corrobo just carries
      // it in the existing ReasonCode.metadata field, no new schema.
      const auditRecord = {
        model: judgment.model,
        isRefundRequestProbability: judgment.isRefundRequest.noul,
        riskScore: judgment.risk.score,
        riskConfidence: judgment.risk.confidence,
        confidenceThreshold: CONFIDENCE_THRESHOLD,
        riskThreshold: RISK_THRESHOLD
      };

      // Deterministic application policy interprets Jev's output. Jev's confidence/score are
      // INPUT to this policy — the thresholds themselves are ordinary application code, not
      // something Jev decides.
      if (judgment.risk.confidence < CONFIDENCE_THRESHOLD) {
        return {
          requiresReview: true,
          reason: {
            code: "JEV_LOW_CONFIDENCE",
            summary: "Jev's risk assessment was not confident enough to act on automatically.",
            metadata: auditRecord
          }
        };
      }
      if (judgment.risk.score > RISK_THRESHOLD) {
        return {
          requiresReview: true,
          reason: {
            code: "JEV_HIGH_RISK",
            summary: "Jev scored this refund above the automatic-execution risk threshold.",
            metadata: auditRecord
          }
        };
      }
      if (judgment.isRefundRequest.noul < IS_REFUND_THRESHOLD) {
        return {
          requiresReview: true,
          reason: {
            code: "JEV_NOT_CLEARLY_A_REFUND",
            summary: "Jev is not confident this request is actually asking for a refund.",
            metadata: auditRecord
          }
        };
      }
      return { requiresReview: false };
    },

    async execute({ intent, identity }) {
      const idempotencyKey = idempotencyKeyFor(identity.id);
      // Ambiguous failures (simulated timeout-after-write) are NOT caught here — they
      // propagate and the runtime records transport.ok === false. Jev plays no role in
      // resolving that ambiguity; observe() below does, against the ledger alone.
      const { refundId } = await ledger.create(idempotencyKey, {
        chargeId: intent.chargeId,
        amountCents: intent.amountCents
      });
      return { kind: "responded", refundId, status: "succeeded" };
    },

    async observe({ identity }) {
      // Authoritative-state rule: regardless of whether execute() returned normally or threw,
      // the ONLY source of truth here is a keyed, idempotent read-back of the ledger. Jev is
      // never called again after this point for this operation.
      const idempotencyKey = idempotencyKeyFor(identity.id);
      const record = await ledger.lookupByKey(idempotencyKey);
      return {
        status: "observed",
        data: record.exists ? { exists: true, refundId: record.refundId, amountCents: record.amountCents } : { exists: false },
        authoritative: true,
        source: "fake-refund-ledger:lookupByKey",
        observedAt: nowIso()
      };
    },

    reconcile({ observation }) {
      if (observation.status !== "observed") {
        return {
          evidenceState: "UNKNOWN",
          reason: { code: "LEDGER_READBACK_UNAVAILABLE", summary: "The ledger could not confirm whether the refund exists." }
        };
      }
      const data = observation.data;
      if (data.exists) {
        return {
          evidenceState: "APPLIED",
          reason: { code: "REFUND_CONFIRMED", summary: "The ledger confirms the refund exists." },
          observedEffect: data
        };
      }
      return {
        evidenceState: "NOT_APPLIED",
        reason: { code: "REFUND_NOT_CREATED", summary: "The ledger confirms no refund exists for this operation." }
      };
    }
  };
}
