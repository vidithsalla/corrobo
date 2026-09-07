import Stripe from "stripe";
import { InMemoryStore, runEffect } from "../../src/core";
import { createRefundContract } from "./contract";
import type { RefundLike, RefundStatus, StripeClientLike } from "./types";

const KNOWN_STATUSES: readonly RefundStatus[] = ["pending", "requires_action", "succeeded", "failed", "canceled"];

function toRefundStatus(status: string | null): RefundStatus {
  if (status && (KNOWN_STATUSES as readonly string[]).includes(status)) {
    return status as RefundStatus;
  }
  throw new Error(`Stripe refund returned an unrecognized status: ${String(status)}`);
}

/**
 * Optional, manual smoke test against the REAL Stripe test-mode API. Not part of the
 * automated test suite (see tests/stripe-refund.test.ts for the deterministic tests that
 * always run). This script:
 *   - refuses to run unless STRIPE_SECRET_KEY is set AND starts with "sk_test_";
 *   - never prints the key;
 *   - creates one small test-mode charge (Stripe's `tok_visa` test token — no real card);
 *   - refunds it twice through the SAME corrobo operation identity, to demonstrate that the
 *     second call does not create a second refund.
 *
 * Run with: STRIPE_SECRET_KEY=sk_test_... npx tsx examples/stripe-refund/live-smoke.ts
 */

function toRefundLike(refund: Stripe.Refund): RefundLike {
  const charge = typeof refund.charge === "string" ? refund.charge : (refund.charge?.id ?? "");
  return { id: refund.id, status: toRefundStatus(refund.status), amount: refund.amount, charge };
}

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.log("live Stripe test-mode smoke test not run because no test key was available.");
    return;
  }
  if (!key.startsWith("sk_test_")) {
    console.log(
      "STRIPE_SECRET_KEY is set but does not start with sk_test_ — refusing to run against a non-test-mode key."
    );
    return;
  }

  const stripe = new Stripe(key);

  const client: StripeClientLike = {
    refunds: {
      async create(params, opts) {
        const refund = await stripe.refunds.create(
          { charge: params.charge, amount: params.amount, reason: params.reason as Stripe.RefundCreateParams.Reason },
          { idempotencyKey: opts.idempotencyKey }
        );
        return toRefundLike(refund);
      },
      async retrieve(id) {
        return toRefundLike(await stripe.refunds.retrieve(id));
      }
    }
  };

  const charge = await stripe.charges.create({
    amount: 100,
    currency: "usd",
    source: "tok_visa",
    description: "corrobo live-smoke test charge (test mode, safe to ignore)"
  });

  const store = new InMemoryStore();
  const contract = createRefundContract({ client });
  const identity = { id: `live-smoke-${charge.id}`, operationType: contract.operationType };
  const intent = { chargeId: charge.id, amountCents: 100 };

  const first = await runEffect(store, contract, { identity, intent });
  console.log("first call:", { evidenceState: first.evidenceState, disposition: first.disposition });

  const second = await runEffect(store, contract, { identity, intent });
  console.log("second call with the same identity (expect cached, no new refund):", {
    evidenceState: second.evidenceState,
    disposition: second.disposition,
    attemptsRecorded: second.attempts.length
  });
}

main().catch((err) => {
  console.error("live smoke test failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
