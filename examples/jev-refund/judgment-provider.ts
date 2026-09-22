/**
 * The boundary between a probabilistic pre-execution judgment system (Jev, here) and
 * corrobo's deterministic post-execution runtime. This interface is EXAMPLE-ONLY — it is not
 * exported from the `corrobo` package, and corrobo's core has no knowledge of it. See
 * docs/jev-integration.md for why this stays out of core.
 *
 * `RefundJudgmentProvider` is deliberately narrow: it answers bounded, typed questions about
 * a request and returns probabilities. It does NOT decide policy (that's deterministic
 * application code in contract.ts) and it is NEVER consulted after execute() — only
 * authoritative observation of the refund ledger is.
 */

export interface RefundJudgmentInput {
  requestText: string;
  amountCents: number;
}

export interface RefundJudgment {
  /** Probability (0-1) that requestText is genuinely asking for a refund. Jev's Noul primitive. */
  isRefundRequest: { noul: number };
  /** Risk of approving this refund automatically, normalized to 0 (low) - 1 (high). Jev's Score primitive. */
  risk: { score: number; confidence: number };
  /** Resolved model/version that answered, when the provider can report one (see docs/jev-integration.md #5). */
  model?: string;
}

export interface RefundJudgmentProvider {
  assess(input: RefundJudgmentInput): Promise<RefundJudgment>;
}

/**
 * Deterministic stand-in for a live Jev call. Used by the mock demo and all tests — no network
 * access, no API key, same interface a live provider would satisfy. The heuristic is
 * intentionally simple and legible, not a serious risk model: it exists to give the demo/tests
 * clearly distinguishable low-risk, high-risk, and low-confidence inputs to drive policy with.
 */
export class MockRefundJudgmentProvider implements RefundJudgmentProvider {
  async assess({ requestText, amountCents }: RefundJudgmentInput): Promise<RefundJudgment> {
    const mentionsRefund = /refund|charged twice|wrong amount|please fix/i.test(requestText);
    const mentionsFraud = /unauthorized|fraud|stolen|dispute|don'?t recognize/i.test(requestText);

    const isRefundRequest = mentionsRefund ? 0.96 : 0.35;

    let riskScore = Math.min(1, amountCents / 100_000); // $1000+ alone saturates risk to 1.0
    if (mentionsFraud) riskScore = Math.min(1, riskScore + 0.5);

    // Ambiguous/ fraud-flavored language is exactly the case Jev is least confident about —
    // model that as lower confidence, which the deterministic policy treats as review-worthy
    // on its own, independent of the risk score.
    const confidence = mentionsFraud ? 0.55 : 0.92;

    return {
      isRefundRequest: { noul: isRefundRequest },
      risk: { score: riskScore, confidence },
      model: "mock-jev/deterministic-0"
    };
  }
}
