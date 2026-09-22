/**
 * A deterministic, in-memory stand-in for an authoritative refund system. No network, no
 * credentials. Its only job in this example is to demonstrate the boundary corrobo exists to
 * hold: create() can report an ambiguous transport failure (timeout AFTER the write committed),
 * but a keyed, idempotent read-back always tells the truth. Jev is never involved in it.
 */
export class FakeRefundLedger {
  private readonly byKey = new Map<string, { refundId: string; amountCents: number }>();
  private readonly pendingTimeoutAfterWrite = new Set<string>();
  private createdCount = 0;

  /** Injects one simulated "the write committed but the response was lost" fault for this key. */
  scheduleTimeoutAfterWrite(idempotencyKey: string): void {
    this.pendingTimeoutAfterWrite.add(idempotencyKey);
  }

  get createdRefundCount(): number {
    return this.createdCount;
  }

  /** Idempotent by key: replaying the same key never creates a second refund. */
  async create(idempotencyKey: string, params: { chargeId: string; amountCents: number }): Promise<{ refundId: string }> {
    const existing = this.byKey.get(idempotencyKey);
    if (existing) return { refundId: existing.refundId };

    this.createdCount += 1;
    const refundId = `jr_${this.createdCount}`;
    this.byKey.set(idempotencyKey, { refundId, amountCents: params.amountCents });

    if (this.pendingTimeoutAfterWrite.delete(idempotencyKey)) {
      // The write above already happened and is visible to lookupByKey() — only the response
      // to THIS call is lost, which is exactly the ambiguity corrobo's observe() must resolve.
      throw new Error("simulated network timeout after the ledger committed the write");
    }

    return { refundId };
  }

  /** Authoritative, keyed read-back — never influenced by Jev's judgment. */
  async lookupByKey(idempotencyKey: string): Promise<{ exists: true; refundId: string; amountCents: number } | { exists: false }> {
    const record = this.byKey.get(idempotencyKey);
    return record ? { exists: true, refundId: record.refundId, amountCents: record.amountCents } : { exists: false };
  }
}
