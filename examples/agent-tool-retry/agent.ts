/**
 * A simulated agent turn, standing in for a model so this runs offline. It behaves like the worst
 * case: it calls the refund tool, and on anything other than a success it calls it again, with a
 * new tool call id. With "Please try again" as the error text, a smaller model (Claude Haiku 5.5)
 * did this in 6 of 6 runs; a larger one (Sonnet 5.5) checked first in both of its default-text runs
 * (https://github.com/openai/openai-agents-js/issues/2184).
 */
export type RefundArgs = { chargeId: string; amountCents: number };
export type RefundTool = (args: RefundArgs, call: { runId: string; toolCallId: string }) => Promise<string>;

export const DEFAULT_TOOL_ERROR = "An error occurred while running the tool. Please try again.";

export async function runAgentTurn(tool: RefundTool, args: RefundArgs, runId: string, maxCalls = 3): Promise<string[]> {
  const transcript: string[] = [];
  for (let n = 1; n <= maxCalls; n++) {
    const toolCallId = `call_${n}`;
    let output: string;
    try {
      output = await tool(args, { runId, toolCallId });
    } catch {
      output = DEFAULT_TOOL_ERROR;
    }
    transcript.push(`${toolCallId}: ${output}`);
    if (output.startsWith("Refunded")) break;
  }
  return transcript;
}
