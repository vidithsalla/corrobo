import { runEffect, defineContract, observed, reconciled, type EffectStore } from "corrobo";
import type { PaymentsApi } from "./payments";
import type { RefundArgs, RefundTool } from "./agent";

/** 1. Calls the API directly. */
export function naiveTool(payments: PaymentsApi): RefundTool {
  return async (args) => {
    const refund = await payments.createRefund(args);
    return `Refunded ${refund.amountCents} (${refund.id})`;
  };
}

/** 2. The usual advice: an idempotency key per tool call. The model's retry is a new call, so a new key. */
export function toolCallIdKeyTool(payments: PaymentsApi): RefundTool {
  return async (args, { toolCallId }) => {
    const refund = await payments.createRefund(args, { idempotencyKey: toolCallId });
    return `Refunded ${refund.amountCents} (${refund.id})`;
  };
}

function refundContract(payments: PaymentsApi) {
  return defineContract<RefundArgs>()({
    operationType: "payments/refund",
    retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
    execute: ({ intent, identity }) => payments.createRefund({ ...intent, reference: identity.id }),
    observe: async ({ identity }) =>
      observed(await payments.findRefunds(identity.id), { source: "payments.findRefunds", authoritative: true }),
    reconcile: ({ intent, observation }) => {
      if (observation.status !== "observed") return reconciled("UNKNOWN", "NO_READ", "Couldn't look the refund up.");
      const refunds = observation.data;
      if (refunds.length === 0) return reconciled("NOT_APPLIED", "NO_REFUND", "No refund exists.");
      if (refunds.length === 1 && refunds[0].amountCents === intent.amountCents) {
        return reconciled("APPLIED", "REFUNDED", "The refund exists.");
      }
      return reconciled("CONFLICTED", "UNEXPECTED", "Refunds don't match the plan.");
    }
  });
}

/** What the model is told. A known outcome is reported as such; an unknown one says not to retry. */
function describe(result: Awaited<ReturnType<typeof runEffect>>, args: RefundArgs): string {
  if (result.evidenceState === "APPLIED") return `Refunded ${args.amountCents}`;
  return `The refund's outcome is unknown (${result.evidenceReason?.code}). Don't retry it: a person has to check.`;
}

/** 3. corrobo, but keyed on the tool call: each model retry looks like a new operation. */
export function corroboToolCallIdTool(payments: PaymentsApi, store: EffectStore): RefundTool {
  const contract = refundContract(payments);
  return async (args, { toolCallId }) => describe(await runEffect(store, contract, { identity: toolCallId, intent: args }), args);
}

/**
 * 4. corrobo, keyed on the decision: this run refunding this charge this amount. A model retry of
 * the same decision is the same operation, so it returns what was recorded instead of refunding
 * again. (If one run may legitimately make two identical refunds, mint an id when the action is
 * confirmed and store it with the action instead; see the README on where the identity comes from.)
 */
export function corroboDecisionTool(payments: PaymentsApi, store: EffectStore): RefundTool {
  const contract = refundContract(payments);
  return async (args, { runId }) => {
    const identity = `${runId}:refund:${args.chargeId}:${args.amountCents}`;
    return describe(await runEffect(store, contract, { identity, intent: args }), args);
  };
}
