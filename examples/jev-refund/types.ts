/**
 * Minimal shapes for this example. Deliberately not Stripe-shaped (see
 * examples/stripe-refund for that) — this example is about the boundary between a
 * pre-execution judgment system (Jev) and corrobo's post-execution reconciliation, so the
 * "refund provider" here is a small fake ledger, not a real payment API.
 */

export interface RefundRequestIntent {
  /** Free-text description of the request, e.g. from a support ticket. This is the ONLY field sent to Jev. */
  requestText: string;
  chargeId: string;
  amountCents: number;
}

export type RefundTransportEvidence =
  | { kind: "responded"; refundId: string; status: "succeeded" }
  | { kind: "rejected"; reason: string };

export type RefundObservationData =
  | { exists: true; refundId: string; amountCents: number }
  | { exists: false };
