# Audit mode reference

Goal: find consequential side-effecting operations, assess their duplication/loss risk honestly, and report — without editing anything.

## Step 1 — find side effects

Search the codebase (use the coding agent's own repository search tools — grep/glob/semantic search; this skill does not ship a static-analysis engine) for operations where **repeating the action could matter externally**:

- HTTP mutations: `POST`/`PATCH`/`PUT`/`DELETE` calls to external or internal APIs.
- SDK methods named like `create`, `update`, `delete`, `cancel`, `refund`, `send`, `charge`, `subscribe`, `deploy`, `merge`, `close`, `assign`.
- MCP/agent tool definitions marked as mutating, or whose description/implementation performs one of the above.
- Payment/refund flows, ticket/CRM mutations, message/email sends, infra/deployment mutations (`kubectl apply`, Terraform runs, CI/CD triggers), account/subscription changes.
- Database writes that themselves trigger or represent an external effect (e.g. an outbox row that a worker later delivers).

**Do not flag:** `GET`/read-only calls, pure functions, local cache updates, ordinary in-memory assignments, or any write whose repetition has no externally observable consequence. If unsure whether repetition matters, say so in the report rather than guessing either way.

**Also do not flag a persistence layer's own internal bookkeeping writes as a side effect needing corrobo-wrapping** — e.g. corrobo's own `PostgresStore` writing to its own operations table. Wrapping corrobo's own storage writes *with* corrobo would be circular. The distinction is whether the write is the runtime's internal bookkeeping vs. the application's business mutation against an external system that corrobo would be wrapping.

## Step 2 — find unsafe retry assumptions

For each candidate operation, look for:

- `try { await mutation() } catch { retry() }` or a retry library (`p-retry`, `axios-retry`, framework-level HTTP client retries, agent-framework tool-call retries) wrapping the mutation **without** an authoritative check in between.
- Code that treats a timeout/thrown error as proof the effect didn't happen.
- Code that treats a 2xx response as proof the effect is finally, fully complete (missing that some APIs report an async/pending state).
- A retry path that would generate a **new** idempotency key / new resource id for what is logically the same operation (defeats the API's own protection).
- Any path where a process restart or a replayed event/message could re-invoke the mutation with no memory of a prior attempt.

## Step 3 — inspect operation identity

For the specific operation, determine which of these actually exist (do not assume more than what's verifiable in code/API docs):

- A native idempotency key the API accepts (e.g. Stripe's `Idempotency-Key` header).
- A client-generated stable resource id the API accepts at creation time (e.g. Linear's `IssueCreateInput.id`).
- A correlation/request id that could be embedded and later searched for (best-effort only — see step 4).
- No viable identity mechanism at all — say this plainly; do not invent one.

## Step 4 — inspect authoritative observation

- What system actually owns the truth here (not the caller's own database — the external system, unless the caller's DB is itself authoritative for an internal effect)?
- Is there a **direct** read-back (fetch-by-id) or only a **search/scan** (channel history, a search index)? Direct read-back is authoritative; search/scan is best-effort and should be labeled as such.
- Is the read immediately consistent, or could it lag (search index delay, replication lag)?
- Is `PENDING`/async-status a normal outcome for this operation type (payments settling, infra converging)?
- Could `UNKNOWN` be genuinely unavoidable for some failure mode (e.g. a network partition with no correlation id ever recorded)? If so, say that explicitly — it's not a gap in the audit, it's a property of the system being audited.

## Step 5 — inspect concurrency/preconditions

Look for, **per operation type** (not per vendor — e.g. GitHub's `merge_pull_request` may have an ETag/SHA precondition while `update_issue` on the same API has none):

- ETags, `resourceVersion`, expected SHAs, `updatedAt`/version fields, compare-and-set or conditional-write support.
- Whether the code actually uses any of the above, or performs a blind overwrite.

## Report format

Do not edit code in this mode. Produce a table like this, one row per operation, plus a one-line summary of anything genuinely ambiguous:

| Operation | Risk | Current behavior | Identity | Observation | Retry hazard | Recommended corrobo treatment |
|---|---|---|---|---|---|---|
| e.g. `POST /orders/:id/cancel` in `checkout/cancel.ts:42` | High — real money/state change | Catches timeout, retries blindly up to 3x | None found — no idempotency key sent | Direct `GET /orders/:id` exists, immediately consistent | Retry after timeout could double-cancel/re-trigger side effects | Wrap with an Effect Contract; `execute()` = the POST, `observe()` = the GET, retryable only after confirmed `NOT_APPLIED` |

Be specific about file/line where practical. Where an operation is *already* safely wrapped (e.g. it already uses corrobo, or already has solid native idempotency plus a checked precondition), say so plainly instead of manufacturing a finding — a clean bill of health is a valid, useful audit result.

## Language discipline

Never write: "guaranteed exactly-once," "fully idempotent" (when only a retry-safety property was verified), "confirmed" for anything read from a search/index rather than a direct lookup, or "safe" based on an idempotency key's mere existence without checking whether the code actually threads it through correctly (same key reused across retries of the same logical operation, a fresh key per new logical operation).
