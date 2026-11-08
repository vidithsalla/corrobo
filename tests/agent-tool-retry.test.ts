import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/memory";
import { createPaymentsApi, type PaymentsApi } from "../examples/agent-tool-retry/payments";
import { runAgentTurn, type RefundTool } from "../examples/agent-tool-retry/agent";
import { corroboDecisionTool, corroboToolCallIdTool, naiveTool, toolCallIdKeyTool } from "../examples/agent-tool-retry/tools";

/** examples/agent-tool-retry: a model's retry is a new tool call, so the identity must name the decision. */
async function refundsMade(make: (p: PaymentsApi) => RefundTool, lookupDown = 0): Promise<{ count: number; transcript: string[] }> {
  const payments = createPaymentsApi();
  payments.loseNextResponse();
  payments.takeLookupDown(lookupDown);
  const transcript = await runAgentTurn(make(payments), { chargeId: "ch_1", amountCents: 5_000 }, "run_42");
  return { count: payments.refundCount(), transcript };
}

describe("agent tool retry example", () => {
  it("calling the API directly refunds twice when the model retries", async () => {
    expect((await refundsMade(naiveTool)).count).toBe(2);
  });

  it("an idempotency key per toolCallId still refunds twice: the retry is a new call with a new key", async () => {
    expect((await refundsMade(toolCallIdKeyTool)).count).toBe(2);
  });

  it("corrobo keyed on toolCallId refunds twice if its read-back is briefly down and the model retries anyway", async () => {
    expect((await refundsMade((p) => corroboToolCallIdTool(p, new InMemoryStore()), 1)).count).toBe(2);
  });

  it("corrobo keyed on the decision refunds once through the same outage, and every retry gets the recorded answer", async () => {
    const { count, transcript } = await refundsMade((p) => corroboDecisionTool(p, new InMemoryStore()), 1);
    expect(count).toBe(1);
    expect(transcript).toHaveLength(3);
    expect(transcript.every((line) => line.includes("Don't retry"))).toBe(true);
  });

  it("with the lookup working, corrobo keyed on the decision reports the refund on the first call, so there's nothing to retry", async () => {
    const { count, transcript } = await refundsMade((p) => corroboDecisionTool(p, new InMemoryStore()));
    expect(count).toBe(1);
    expect(transcript).toEqual(["call_1: Refunded 5000"]);
  });
});
