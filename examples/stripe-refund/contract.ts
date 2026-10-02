import type { EffectContract, ObservationResult } from "../../src/core/types";
import { isConflictCode, isDefiniteRejection } from "./types";
import type { RefundIntent, RefundLike, StripeClientLike } from "./types";

/**
 * The flagship example: refunding a charge. Nothing here is bespoke to corrobo's testing
 * machinery — this contract would work identically against the real `stripe` package
 * (see live-smoke.ts), because it only depends on the minimal StripeClientLike shape.
 */

export type RefundTransportEvidence =
  | { kind: "responded"; refundId: string; status: RefundLike["status"] }
  | { kind: "rejected"; code?: string; message: string };

export type RefundObservationData =
  | { exists: true; refundId: string; status: RefundLike["status"]; amount: number }
  | { exists: false; rejectionCode?: string; rejectionMessage?: string };

/**
 * The Corrobo operation identity IS the logical refund. The Stripe Idempotency-Key is
 * derived deterministically from it, so every attempt of the SAME logical refund reuses
 * the SAME key (Stripe will never create a second refund for it), while a genuinely new
 * logical refund requires a new identity — and therefore a new key — by construction.
 */
export function idempotencyKeyFor(operationId: string): string {
  return `refund:${operationId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** How many pages of a charge's refunds observe() reads before giving up (100 refunds per page). */
const MAX_LIST_PAGES = 50;

/** The metadata key each refund carries: the corrobo operation it belongs to. */
export const OPERATION_METADATA_KEY = "corrobo_operation";

export function createRefundContract(options: {
  client: StripeClientLike;
  /** Refunds at or above this amount require human authorization before execute() is attempted. */
  reviewThresholdCents?: number;
}): EffectContract<RefundIntent, RefundObservationData, RefundTransportEvidence> {
  const reviewThresholdCents = options.reviewThresholdCents ?? Number.POSITIVE_INFINITY;

  return {
    operationType: "stripe/refund",
    capabilities: {
      nativeIdempotency: true,
      callerGeneratedIdentity: true,
      optimisticConcurrency: false,
      convergence: true
    },
    retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
    // Every attempt sends the same Idempotency-Key (derived from the operation identity), so if a
    // failed request lands late, a retry is deduplicated by Stripe instead of refunding twice.
    // That is what makes 0 honest here. (Past Stripe's ~24h key retention it would not be.)
    maxInFlightMs: 0,

    authorize(intent) {
      if (intent.amountCents >= reviewThresholdCents) {
        return {
          requiresReview: true,
          reason: {
            code: "REFUND_ABOVE_THRESHOLD",
            summary: "This refund amount exceeds the autonomous threshold and requires human sign-off.",
            metadata: { amountCents: intent.amountCents, thresholdCents: reviewThresholdCents }
          }
        };
      }
      return { requiresReview: false };
    },

    async execute({ intent, identity }) {
      const idempotencyKey = idempotencyKeyFor(identity.id);
      try {
        const refund = await options.client.refunds.create(
          {
            charge: intent.chargeId,
            amount: intent.amountCents,
            reason: intent.reason,
            metadata: { [OPERATION_METADATA_KEY]: identity.id }
          },
          { idempotencyKey }
        );
        return { kind: "responded", refundId: refund.id, status: refund.status };
      } catch (err) {
        if (isDefiniteRejection(err)) {
          return { kind: "rejected", code: err.code, message: err.message };
        }
        throw err; // ambiguous (network/timeout/5xx) — the runtime captures this as transport.ok === false
      }
    },

    // observe() only ever reads. It runs when nothing may be executed (crash recovery, the
    // re-check before a retry, after an approval has expired), so it must never be able to
    // create a refund itself; replaying create-refund here would do exactly that whenever the
    // original request never reached Stripe.
    async observe({ intent, identity, transport }) {
      // Strongest evidence: execute() got a refund id back, so look that refund up directly.
      if (transport.ok && transport.evidence.kind === "responded") {
        const refund = await options.client.refunds.retrieve(transport.evidence.refundId);
        return observationFromRefund(refund);
      }

      // Otherwise (execute() threw, or Stripe rejected the request): find this operation's
      // refund, if any, among the charge's refunds by the metadata execute() attached. Stripe's
      // list endpoint reflects writes immediately (unlike its Search API), so "not there" is a
      // real answer. A throw here becomes observation_failed -> UNKNOWN, never NOT_APPLIED.
      // Every page: a charge can carry many partial refunds, and missing ours would read as
      // "not applied".
      let ours: RefundLike | undefined;
      let startingAfter: string | undefined;
      for (let pages = 0; ; pages++) {
        // A provider (or a bug) that keeps returning has_more would otherwise loop here forever,
        // holding the operation's lock. Give up loudly: a throw is observation_failed -> UNKNOWN.
        if (pages >= MAX_LIST_PAGES) throw new Error(`more than ${MAX_LIST_PAGES} pages of refunds on charge ${intent.chargeId}`);
        const page = await options.client.refunds.list({
          charge: intent.chargeId,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {})
        });
        ours = page.data.find((refund) => refund.metadata?.[OPERATION_METADATA_KEY] === identity.id);
        if (ours || !page.has_more || page.data.length === 0) break;
        startingAfter = page.data[page.data.length - 1].id;
      }
      if (ours) {
        return observationFromRefund(ours);
      }
      const rejection = transport.ok && transport.evidence.kind === "rejected" ? transport.evidence : undefined;
      return {
        status: "observed",
        data: { exists: false, rejectionCode: rejection?.code, rejectionMessage: rejection?.message },
        authoritative: true,
        source: "stripe:refunds.list",
        observedAt: nowIso()
      };
    },

    reconcile({ observation }) {
      if (observation.status === "observation_failed") {
        return {
          evidenceState: "UNKNOWN",
          reason: {
            code: "READBACK_UNAVAILABLE",
            summary: "Neither a direct lookup nor the charge's refund list could establish whether the refund exists.",
            metadata: { error: observation.error.message }
          }
        };
      }

      if (observation.status === "pending") {
        return {
          evidenceState: "PENDING",
          reason: {
            code: "AWAITING_CONVERGENCE",
            summary: "Stripe has acknowledged the refund but it has not yet reached a terminal status."
          },
          observedEffect: observation.data
        };
      }

      const data = observation.data;

      if (!data.exists) {
        if (isConflictCode(data.rejectionCode)) {
          return {
            evidenceState: "CONFLICTED",
            reason: {
              code: "REFUND_PRECONDITION_CONFLICT",
              summary: "The charge's refundable state no longer matches what the plan assumed.",
              metadata: { stripeCode: data.rejectionCode }
            }
          };
        }
        return {
          evidenceState: "NOT_APPLIED",
          reason: {
            code: "REFUND_NOT_CREATED",
            summary: "Stripe confirms no refund exists for this operation.",
            metadata: { stripeCode: data.rejectionCode }
          }
        };
      }

      if (data.status === "succeeded") {
        return {
          evidenceState: "APPLIED",
          reason: { code: "REFUND_CONFIRMED", summary: "Stripe confirms the refund succeeded." },
          observedEffect: data
        };
      }

      // status is "failed" or "canceled": a refund object exists, but the business effect
      // (funds returned) did not happen, and Stripe will not retry the underlying bank transfer
      // on a replayed key. Modeled honestly as NOT_APPLIED; once this operation's retries are
      // exhausted, the resulting INVESTIGATE correctly signals that a NEW logical refund (a new
      // operation identity, not a retry of this one) is what a human should consider next.
      return {
        evidenceState: "NOT_APPLIED",
        reason: {
          code: "REFUND_TERMINALLY_FAILED",
          summary: "A refund attempt exists but did not succeed, and Stripe will not retry it under the same key.",
          metadata: { stripeStatus: data.status }
        },
        observedEffect: data
      };
    }
  };
}

function observationFromRefund(refund: RefundLike): ObservationResult<RefundObservationData> {
  const observedAt = nowIso();
  if (refund.status === "pending" || refund.status === "requires_action") {
    return {
      status: "pending",
      authoritative: true,
      source: "stripe:refunds",
      observedAt,
      data: { exists: true, refundId: refund.id, status: refund.status, amount: refund.amount }
    };
  }
  return {
    status: "observed",
    data: { exists: true, refundId: refund.id, status: refund.status, amount: refund.amount },
    authoritative: true,
    source: "stripe:refunds",
    observedAt
  };
}
