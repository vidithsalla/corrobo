import type { Pool, PoolClient } from "pg";
import type { EffectStore, NewOperationInput } from "../core/store";
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
 */
export class PostgresStore implements EffectStore {
  constructor(private readonly pool: Pool | PoolClient) {}

  /** Creates the schema if it doesn't exist. Call once at startup. */
  static async migrate(pool: Pool | PoolClient): Promise<void> {
    await pool.query(POSTGRES_SCHEMA_SQL);
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
