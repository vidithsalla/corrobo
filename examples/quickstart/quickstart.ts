// The README's quickstart is the region below, verbatim (tests/quickstart.test.ts checks this).
// Run it: npm run quickstart
import { createPaymentsApi } from "./payments-api";

const payments = createPaymentsApi(); // your real API client goes here

// #region readme
import { runEffect, InMemoryStore, defineContract, observed, reconciled } from "corrobo";

const refundOrder = defineContract<{ orderId: string; amountCents: number }>()({
  operationType: "payments/refund",
  retryPolicy: { maxAttempts: 3, retryOnNotApplied: true },
  maxInFlightMs: 10_000, // your request timeout + how long the API may take to apply a request

  // 1. Make the write. Send the operation id so the API can be asked about it afterwards.
  execute: ({ intent, identity }) => payments.createRefund({ ...intent, reference: identity.id }),

  // 2. Ask the API what is actually true. Never infer it from execute()'s outcome.
  //    authoritative: this lookup sees a refund the moment it's made, so "none found" proves
  //    none. For a search that can lag, pass false and treat "none found" as UNKNOWN.
  observe: async ({ identity }) =>
    observed(await payments.findRefunds(identity.id), { source: "payments.findRefunds", authoritative: true }),

  // 3. Compare what you intended with what you observed.
  reconcile: ({ intent, observation }) => {
    if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "Could not read refunds.");
    const refunds = observation.data;
    if (refunds.length === 0) return reconciled("NOT_APPLIED", "NO_REFUND", "No refund exists.");
    if (refunds.length === 1 && refunds[0].amountCents === intent.amountCents) {
      return reconciled("APPLIED", "REFUNDED", "The intended refund exists.");
    }
    return reconciled("CONFLICTED", "UNEXPECTED_REFUNDS", `${refunds.length} refund(s) don't match the plan.`);
  }
});

async function main() {
  payments.loseNextResponse(); // the refund goes through, but the response is lost

  const result = await runEffect(new InMemoryStore(), refundOrder, {
    identity: "refund-request-8421", // minted once, when the refund was requested, and stored with it
    intent: { orderId: "1001", amountCents: 5_000 }
  });

  console.log(result.evidenceState, result.disposition); // APPLIED COMPLETE
  console.log("refunds made:", payments.refundCount()); // refunds made: 1
}

main();
// #endregion
