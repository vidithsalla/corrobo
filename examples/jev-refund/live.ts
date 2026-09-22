import { InMemoryStore, runEffect } from "../../src/core";
import { createJevRefundContract, idempotencyKeyFor } from "./contract";
import { FakeRefundLedger } from "./fake-refund-ledger";
import { LiveJevJudgmentProvider } from "./live-judgment-provider";

/**
 * OPTIONAL live variant of demo.ts: same contract and fake ledger, but authorize() calls the
 * real TypeSafe Jev API instead of MockRefundJudgmentProvider. Refuses to run unless
 * TYPESAFE_API_KEY is set; never logs it. Not part of the automated test suite or CI, and not
 * invoked by `npm run example:jev` — run explicitly with:
 *
 *   TYPESAFE_API_KEY=... npm run example:jev:live
 *
 * The refund side effect itself still runs against the local fake ledger (no real payment
 * provider involved) — only the pre-execution judgment is live. See
 * docs/jev-integration.md #7-8.
 */

function log(label: string, result: unknown): void {
  console.log(`\n-- ${label} --`);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.log("live Jev example not run because TYPESAFE_API_KEY is not set. This is expected in CI and normal `npm test` runs.");
    return;
  }

  const store = new InMemoryStore();
  const ledger = new FakeRefundLedger();
  const judgmentProvider = new LiveJevJudgmentProvider();
  const contract = createJevRefundContract({ judgmentProvider, ledger });

  const identity = { id: `jev-refund-live-${Date.now()}`, operationType: contract.operationType };
  const intent = {
    requestText: "I was charged twice for the same order, please refund the extra charge.",
    chargeId: "ch_live_demo",
    amountCents: 2_500
  };

  ledger.scheduleTimeoutAfterWrite(idempotencyKeyFor(identity.id));
  const result = await runEffect(store, contract, { identity, intent });
  log("live Jev judgment -> corrobo authorize/execute/observe/reconcile", {
    evidenceState: result.evidenceState,
    disposition: result.disposition,
    dispositionReason: result.dispositionReason
  });
}

main().catch((err) => {
  console.error("live Jev example failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
