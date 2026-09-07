import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { CoordinatedStore, EffectStore, NewOperationInput, OperationLock } from "../core/store";
import type { AttemptRecord, OperationRecord, OperationStatus, ReservedAttemptInput } from "../core/types";

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

/** Anything with node-postgres's .query() signature — a Pool or a single PoolClient. */
interface Queryable {
  query<T extends QueryResultRow = never>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
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

function mustReturnRow(identityId: string, row: Row | undefined): OperationRecord {
  if (!row) {
    throw new Error(`corrobo: unknown operation identity "${identityId}"`);
  }
  return rowToRecord(row);
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

// --- Query implementations, parameterized over Queryable so both the shared pool (for
// standalone/test use) and a single dedicated lock-holding connection (for a coordinated
// runEffect pass) can run the identical SQL without duplicating it. ---

async function getOperationImpl(q: Queryable, identityId: string): Promise<OperationRecord | null> {
  const result = await q.query<Row>(`SELECT * FROM ${TABLE} WHERE id = $1`, [identityId]);
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

async function createOperationImpl(q: Queryable, input: NewOperationInput): Promise<OperationRecord> {
  try {
    const result = await q.query<Row>(
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

async function reserveAttemptImpl(
  q: Queryable,
  identityId: string,
  reserved: ReservedAttemptInput
): Promise<OperationRecord> {
  const placeholder: AttemptRecord = {
    status: "RESERVED",
    attemptNumber: reserved.attemptNumber,
    startedAt: reserved.startedAt,
    updatedAt: reserved.startedAt
  };
  const result = await q.query<Row>(
    `UPDATE ${TABLE} SET attempts = attempts || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
    [identityId, JSON.stringify([placeholder])]
  );
  return mustReturnRow(identityId, result.rows[0]);
}

async function appendAttemptImpl(
  q: Queryable,
  identityId: string,
  attempt: AttemptRecord,
  status: OperationStatus
): Promise<OperationRecord> {
  const result = await q.query<Row>(
    `UPDATE ${TABLE}
     SET attempts = attempts || $2::jsonb, status = $3, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [identityId, JSON.stringify([attempt]), status]
  );
  return mustReturnRow(identityId, result.rows[0]);
}

async function updateLatestAttemptImpl(
  q: Queryable,
  identityId: string,
  attempt: AttemptRecord,
  status: OperationStatus
): Promise<OperationRecord> {
  const result = await q.query<Row>(
    `UPDATE ${TABLE}
     SET attempts = jsonb_set(attempts, array[(jsonb_array_length(attempts) - 1)::text], $2::jsonb),
         status = $3,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [identityId, JSON.stringify(attempt), status]
  );
  return mustReturnRow(identityId, result.rows[0]);
}

async function setStatusImpl(q: Queryable, identityId: string, status: OperationStatus): Promise<OperationRecord> {
  const result = await q.query<Row>(
    `UPDATE ${TABLE} SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [identityId, status]
  );
  return mustReturnRow(identityId, result.rows[0]);
}

function boundStore(q: Queryable): CoordinatedStore {
  return {
    getOperation: (id) => getOperationImpl(q, id),
    createOperation: (input) => createOperationImpl(q, input),
    reserveAttempt: (id, r) => reserveAttemptImpl(q, id, r),
    appendAttempt: (id, a, s) => appendAttemptImpl(q, id, a, s),
    updateLatestAttempt: (id, a, s) => updateLatestAttemptImpl(q, id, a, s),
    setStatus: (id, s) => setStatusImpl(q, id, s)
  };
}

/**
 * Postgres-backed store: durable across process restarts. This is the mode intended
 * for real applications — operation identity and prior evidence survive a crash.
 *
 * Concurrency: tryAcquireLock() checks out ONE dedicated connection from the pool, uses it to
 * take a session-scoped Postgres advisory lock (pg_try_advisory_lock, keyed by a hash of the
 * operation identity), and returns that SAME connection (as OperationLock.store) for every
 * store operation the coordinated pass performs — reservation, reads, and the final resolve
 * all run on the one connection that holds the lock. One in-flight identity therefore consumes
 * exactly one pool connection for the duration of its pass, never two: earlier revisions held
 * the lock on a dedicated connection while routing the pass's own bookkeeping queries through
 * the shared pool, which could self-deadlock once concurrently in-flight distinct identities
 * reached pool.max (every connection held by a lock, none left for any pass's own reads/writes).
 * If the process holding the connection crashes, Postgres releases the advisory lock
 * automatically — no lease timers, no permanent locks. Different operation identities hash to
 * different lock keys and never serialize against each other; the connection is not held
 * across a transaction and does not lock the row itself, so ordinary reads of that row by
 * other tools are never blocked.
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
      store: boundStore(client),
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

  // Standalone instance methods (used directly by tests/tooling outside a coordinated pass,
  // and by runEffect's non-blocking "lock loser" read) go through the shared pool as before —
  // each is a single, independent query, so there is nothing to reuse a connection across.
  getOperation(identityId: string): Promise<OperationRecord | null> {
    return getOperationImpl(this.pool, identityId);
  }

  createOperation(input: NewOperationInput): Promise<OperationRecord> {
    return createOperationImpl(this.pool, input);
  }

  reserveAttempt(identityId: string, reserved: ReservedAttemptInput): Promise<OperationRecord> {
    return reserveAttemptImpl(this.pool, identityId, reserved);
  }

  appendAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord> {
    return appendAttemptImpl(this.pool, identityId, attempt, status);
  }

  updateLatestAttempt(identityId: string, attempt: AttemptRecord, status: OperationStatus): Promise<OperationRecord> {
    return updateLatestAttemptImpl(this.pool, identityId, attempt, status);
  }

  setStatus(identityId: string, status: OperationStatus): Promise<OperationRecord> {
    return setStatusImpl(this.pool, identityId, status);
  }
}
