/**
 * OPTIONAL live implementation of RefundJudgmentProvider, backed by the real TypeSafe AI Jev
 * API via the official `@typesafe-ai/sdk` package (a devDependency of this repo only — see
 * package.json and docs/jev-integration.md #7). Nothing in src/ or the mock demo imports this
 * file; it is loaded only by live.ts, and only when TYPESAFE_API_KEY is explicitly set.
 *
 * Model versioning: TypeSafe's `jev-latest` alias moves as new releases ship, which can shift
 * answers (and therefore this example's thresholds) out from under you. This example pins a
 * specific version by default for reproducibility and lets it be overridden via
 * TYPESAFE_JEV_MODEL — see docs/jev-integration.md #5 for the tradeoff.
 */

import { TypeSafeClient, noul, score } from "@typesafe-ai/sdk";
import type { RefundJudgment, RefundJudgmentInput, RefundJudgmentProvider } from "./judgment-provider";

const DEFAULT_MODEL = "jev-1.13.0";

const RISK_LEVELS = [
  "Low risk: small amount, clear stated reason, no red flags",
  "Medium risk: ambiguous reason or a moderate amount",
  "High risk: large amount, fraud/dispute language, or an unclear justification"
] as const;

export class LiveJevJudgmentProvider implements RefundJudgmentProvider {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(options: { model?: string } = {}) {
    // TypeSafeClient reads TYPESAFE_API_KEY from the environment itself — this code never
    // reads, logs, or stores the key, and it never ends up in corrobo state (see contract.ts).
    this.client = new TypeSafeClient();
    this.model = options.model ?? process.env.TYPESAFE_JEV_MODEL ?? DEFAULT_MODEL;
  }

  async assess({ requestText, amountCents }: RefundJudgmentInput): Promise<RefundJudgment> {
    // Minimum semantic state only — no customer identifiers, no payment instruments, no
    // provider payloads. See docs/jev-integration.md #8 for the data-boundary rationale.
    const response = await this.client.systemOne({
      model: this.model,
      state: { request: requestText, amount_cents: amountCents },
      questions: {
        isRefundRequest: noul("Is this clearly a request for a refund?"),
        risk: score("How risky is it to approve this refund automatically, without human review?", RISK_LEVELS)
      }
    });

    return {
      isRefundRequest: { noul: response.answers.isRefundRequest.noul },
      // score() spreads probability over levels 0..(N-1) = 0..2 here; normalize to 0-1.
      risk: { score: response.answers.risk.score / (RISK_LEVELS.length - 1), confidence: response.answers.risk.confidence },
      model: response.model
    };
  }
}
