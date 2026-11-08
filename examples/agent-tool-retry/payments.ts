/**
 * A stand-in payments API. It deduplicates on an idempotency key when one is sent (like Stripe),
 * stores a `reference` and lets you look refunds up by it. Faults: the next refund's response
 * can be lost after the refund is made, and the lookup can be down for a while.
 */
export interface Refund {
  id: string;
  chargeId: string;
  amountCents: number;
  reference?: string;
}

export function createPaymentsApi() {
  const refunds: Refund[] = [];
  const byKey = new Map<string, Refund>();
  let loseNextResponse = false;
  let lookupDownFor = 0;
  return {
    async createRefund(input: Omit<Refund, "id">, options: { idempotencyKey?: string } = {}): Promise<Refund> {
      const replay = options.idempotencyKey ? byKey.get(options.idempotencyKey) : undefined;
      const refund = replay ?? { id: `re_${refunds.length + 1}`, ...input };
      if (!replay) {
        refunds.push(refund); // the refund is made
        if (options.idempotencyKey) byKey.set(options.idempotencyKey, refund);
      }
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error("TimeoutError: request to /refunds timed out after 30000ms"); // ...but the caller never hears
      }
      return refund;
    },
    async findRefunds(reference: string): Promise<Refund[]> {
      if (lookupDownFor > 0) {
        lookupDownFor -= 1;
        throw new Error("503 Service Unavailable");
      }
      return refunds.filter((r) => r.reference === reference);
    },
    loseNextResponse() {
      loseNextResponse = true;
    },
    takeLookupDown(calls: number) {
      lookupDownFor = calls;
    },
    refundCount: () => refunds.length
  };
}

export type PaymentsApi = ReturnType<typeof createPaymentsApi>;
