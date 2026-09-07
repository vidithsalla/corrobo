/**
 * Minimal local shapes for what this example needs from a Stripe-like client.
 * Deliberately NOT importing the `stripe` package here — the contract and the
 * deterministic demo/tests depend only on this interface, so the official SDK
 * is needed only by live-smoke.ts (see README). This is what makes it possible
 * for `stripe` to stay a devDependency of this repo rather than a dependency
 * corrobo forces on every consumer.
 */

export interface RefundIntent {
  chargeId: string;
  amountCents: number;
  reason?: string;
}

export type RefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";

export interface RefundLike {
  id: string;
  status: RefundStatus;
  amount: number;
  charge: string;
}

export interface StripeRejection {
  code?: string;
  message: string;
}

export interface StripeClientLike {
  refunds: {
    create(
      params: { charge: string; amount: number; reason?: string },
      options: { idempotencyKey: string }
    ): Promise<RefundLike>;
    retrieve(id: string): Promise<RefundLike>;
  };
}

/**
 * True when the client is telling us DEFINITIVELY that no refund was created — Stripe's real
 * SDK marks this via `err.type === "StripeInvalidRequestError"`; the fake client's
 * FakeStripeRejection mirrors it via `err.name`. Any other thrown error (network failure,
 * timeout, 5xx) is genuinely ambiguous and must NOT be treated as a confirmed rejection.
 */
export function isDefiniteRejection(err: unknown): err is Error & { code?: string } {
  if (!(err instanceof Error)) return false;
  const typed = err as Error & { type?: string };
  return typed.type === "StripeInvalidRequestError" || err.name === "FakeStripeRejection";
}

/**
 * Best-effort recognition of Stripe error codes that mean "the world changed under the plan"
 * (the charge was already refunded, or the requested amount now exceeds what's left) rather
 * than "the request itself was malformed." Example-only heuristic, not a core guarantee —
 * Stripe's exact error codes are not part of any stability contract corrobo depends on.
 */
export function isConflictCode(code: string | undefined): boolean {
  return code === "charge_already_refunded" || code === "amount_too_large";
}
