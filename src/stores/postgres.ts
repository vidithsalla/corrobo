import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { EffectStore, NewOperationInput, OperationLock } from "../core/store";
import type { AttemptRecord, OperationRecord, OperationStatus } from "../core/types";

const TABLE = "corrobo_operations";

/** DDL for the single table this store needs. Safe to run repeatedly. */
export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  intent JSONB NOT NULL,
  status TEXT NOT NULL,
  review_reason JSONB,
  attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

interface Row {
  id: string;
  operation_type: string;
  intent: unknown;
  status: OperationStatus;
  review_reason: unknown;
  attempts: AttemptRecord[];
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(row: Row): OperationRecord {
  return {
    identity: { id: row.id, operationType: row.operation_type },
    intent: row.intent,
    status: row.status,
    reviewReason: (row.review_reason as OperationRecord["reviewReason"]) ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

/**
 * Postgres-backed store: durable across process restarts. This is the mode intended
 * for real applications — operation identity and prior evidence survive a crash.
 *
 * Concurrency: tryAcquireLock() uses a session-scoped Postgres advisory lock
 * (pg_try_advisory_lock), keyed by a hash of the operation identity. It is held on a
 * dedicated connection checked out from the pool for the duration of one runEffect() pass
 * (including the external execute()/observe() calls) and released explicitly, or
 * automatically by Postgres if the connection dies — so a crashed process can never leave a
 * permanent lock. This deliberately does NOT hold an open transaction or a row lock across
 * the external call (that would tie up a connection for an unbounded, network-dependent
 * duration in a way that also blocks other readers of that row); the tradeoff accepted
 * instead is that one pool connection is held per concurrently in-flight identity for the
 * duration of its pass — size the pool accordingly under high fan-out concurrency.
 */
export class PostgresStore implements EffectStore {
  constructor(private readonly pool: Pool) {}

  /** Creates the schema if it doesn't exist. Call once at startup. */
  static async migrate(pool: Pool | PoolClient): Promise<void> {
    await pool.query(POSTGRES_SCHEMA_SQL);
  }

  async tryAcquireLock(identityId: string): Promise<OperationLock | null> {
    const client = await this.pool.connect();
    const key = advisoryLockKey(identityId);
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key]);
      if (!result.rows[0]?.locked) {
        client.release();
        return null;
      }
    } catch (err) {
      client.release();
      throw err;
    }

    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [key]);
        } finally {
          client.release();
        }
      }
    };
  }

  async getOperation(identityId: string): Promise<OperationRecord | null> {
    const result = await this.pool.query<Row>(`SELECT * FROM ${TABLE} WHERE id = $1`, [identityId]);
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async createOperation(input: NewOperationInput): Promise<OperationRecord> {
    try {
      const result = await this.pool.query<Row>(
        `INSERT INTO ${TABLE} (id, operation_type, intent, status, review_reason, attempts)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, '[]'::jsonb)
         RETURNING *`,
        [
          input.identity.id,
          input.identity.operationType,
          JSON.stringify(input.intent),
          input.status,
          input.reviewReason ? JSON.stringify(input.reviewReason) : null
        ]
      );
      return rowToRecord(result.rows[0]);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new Error(`corrobo: operation identity "${input.identity.id}" already exists`);
      }
      throw err;
    }
  }

  async appendAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord> {
    const result = await this.pool.query<Row>(
      `UPDATE ${TABLE}
       SET attempts = attempts || $2::jsonb, status = $3, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [identityId, JSON.stringify([attempt]), status]
    );
    return this.mustReturn(identityId, result.rows[0]);
  }

  async updateLatestAttempt(
    identityId: string,
    attempt: AttemptRecord,
    status: OperationStatus
  ): Promise<OperationRecord> {
    const result = await this.pool.query<Row>(
      `UPDATE ${TABLE}
       SET attempts = jsonb_set(attempts, array[(jsonb_array_length(attempts) - 1)::text], $2::jsonb),
           status = $3,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [identityId, JSON.stringify(attempt), status]
    );
    return this.mustReturn(identityId, result.rows[0]);
  }

  async setStatus(identityId: string, status: OperationStatus): Promise<OperationRecord> {
    const result = await this.pool.query<Row>(
      `UPDATE ${TABLE} SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [identityId, status]
    );
    return this.mustReturn(identityId, result.rows[0]);
  }

  private mustReturn(identityId: string, row: Row | undefined): OperationRecord {
    if (!row) {
      throw new Error(`corrobo: unknown operation identity "${identityId}"`);
    }
    return rowToRecord(row);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "23505";
}

/**
 * Deterministically derives a signed 64-bit key for pg_(try_)advisory_lock from an operation
 * identity string. A hash collision between two different identities would only cause them
 * to unnecessarily serialize against each other — never an incorrect safety outcome — since
 * the actual guarantee comes from Postgres allowing only one holder per key at a time.
 */
function advisoryLockKey(identityId: string): string {
  const digest = createHash("sha256").update(identityId).digest();
  const unsigned = digest.readBigUInt64BE(0);
  return BigInt.asIntN(64, unsigned).toString();
}
