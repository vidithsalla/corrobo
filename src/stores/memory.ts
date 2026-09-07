import type { CoordinatedStore, EffectStore, NewOperationInput, OperationLock } from "../core/store";
import type { AttemptRecord, OperationRecord, OperationStatus, ReservedAttemptInput } from "../core/types";

/**
 * In-memory store for tests, examples, and quick local development.
 *
 * LIMITATION: state lives only in process memory. A process restart loses every
 * operation record — there is no crash-survival and no durable-idempotency guarantee.
 * Do not use this for anything where a lost operation identity could cause a duplicate
 * side effect after a restart. Use the Postgres store for that.
 *
 * tryAcquireLock() is a per-identity in-process mutex: it correctly coordinates concurrent
 * runEffect() calls WITHIN one Node process (e.g. two overlapping requests to the same
 * server), but provides no cross-process or distributed guarantee. Use PostgresStore where
 * multiple processes/workers can race the same operation identity.
 */
export class InMemoryStore implements EffectStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly locked = new Set<string>();

  async tryAcquireLock(identityId: string): Promise<OperationLock | null> {
    if (this.locked.has(identityId)) {
      return null;
    }
    this.locked.add(identityId);
    let released = false;
    const scopedStore: CoordinatedStore = this;
    return {
      store: scopedStore,
      release: async () => {
        if (released) return;
        released = true;
        this.locked.delete(identityId);
      }
    };
  }

  async getOperation(identityId: string): Promise<OperationRecord | null> {
    const record = this.records.get(identityId);
    return record ? structuredClone(record) : null;
  }

  async createOperation(input: NewOperationInput): Promise<OperationRecord> {
    if (this.records.has(input.identity.id)) {
      throw new Error(`corrobo: operation identity "${input.identity.id}" already exists`);
    }
    const now = new Date().toISOString();
    const record: OperationRecord = {
      identity: input.identity,
      intent: input.intent,
      status: input.status,
      reviewReason: input.reviewReason,
      attempts: [],
      createdAt: now,
      updatedAt: now
    };
    this.records.set(input.identity.id, record);
    return structuredClone(record);
  }

  async reserveAttempt(identityId: string, reserved: ReservedAttemptInput): Promise<OperationRecord> {
    const record = this.mustGet(identityId);
    record.attempts.push({
      status: "RESERVED",
      attemptNumber: reserved.attemptNumber,
      startedAt: reserved.startedAt,
      updatedAt: reserved.startedAt
    });
    record.updatedAt = new Date().toISOString();
    return structuredClone(record);
  }

  async appendAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord> {
    const record = this.mustGet(identityId);
    record.attempts.push(attempt);
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return structuredClone(record);
  }

  async updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus
  ): Promise<OperationRecord> {
    const record = this.mustGet(identityId);
    if (record.attempts.length === 0) {
      throw new Error(`corrobo: no attempt to update for operation "${identityId}"`);
    }
    record.attempts[record.attempts.length - 1] = attempt;
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return structuredClone(record);
  }

  async setStatus(identityId: string, status: OperationStatus): Promise<OperationRecord> {
    const record = this.mustGet(identityId);
    record.status = status;
    record.updatedAt = new Date().toISOString();
    return structuredClone(record);
  }

  private mustGet(identityId: string): OperationRecord {
    const record = this.records.get(identityId);
    if (!record) {
      throw new Error(`corrobo: unknown operation identity "${identityId}"`);
    }
    return record;
  }
}
