// npm run example:agent-retry
import { InMemoryStore } from "corrobo";
import { createPaymentsApi, type PaymentsApi } from "./payments";
import { runAgentTurn, type RefundTool } from "./agent";
import { naiveTool, toolCallIdKeyTool, corroboToolCallIdTool, corroboDecisionTool } from "./tools";

const args = { chargeId: "ch_1", amountCents: 5_000 };

async function scenario(label: string, make: (payments: PaymentsApi) => RefundTool, lookupDown = 0) {
  const payments = createPaymentsApi();
  payments.loseNextResponse(); // the first refund goes through, but its response is lost
  payments.takeLookupDown(lookupDown);
  const transcript = await runAgentTurn(make(payments), args, "run_42");
  console.log(`\n${label}\n  refunds made: ${payments.refundCount()}`);
  for (const line of transcript) console.log(`  ${line}`);
  return payments.refundCount();
}

async function main() {
  console.log("A refund times out after it went through. The model retries on anything but a success.");
  await scenario("1. Calling the API directly", naiveTool);
  await scenario("2. Idempotency key = toolCallId (the model's retry is a new call, so a new key)", toolCallIdKeyTool);
  await scenario("3. corrobo keyed on toolCallId, with the lookup down for a moment", (p) => corroboToolCallIdTool(p, new InMemoryStore()), 1);
  await scenario("4. corrobo keyed on the decision, with the same lookup outage", (p) => corroboDecisionTool(p, new InMemoryStore()), 1);
  await scenario("4b. corrobo keyed on the decision, lookup working", (p) => corroboDecisionTool(p, new InMemoryStore()));
}

main();
