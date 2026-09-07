---
name: corrobo
description: Audits application and agent/tool code for consequential side-effecting operations (payments, refunds, ticket/CRM mutations, messages, infra/deployment changes) that could duplicate on retry, and helps integrate the corrobo runtime (execute/observe/reconcile) so they are safe. Use when asked to find unsafe retry assumptions, audit tool-call side effects for duplication risk, or wrap a specific mutation with corrobo.
license: MIT
---

# corrobo: side-effect safety audit & integration

## What this skill is, and is not

corrobo is a small deterministic TypeScript runtime that separates transport evidence from business truth for side-effecting operations. **The runtime provides the safety guarantee. This skill does not.** This skill only helps a developer find where that guarantee is missing and integrate the runtime correctly.

```
This skill      -> helps identify a risky operation and propose/scaffold an integration
corrobo runtime -> owns operation identity, coordination, execution evidence,
                    observation, reconciliation, disposition, persistence
External system -> owns authoritative business truth
```

Never claim this skill itself makes anything safe. Never claim corrobo provides exactly-once execution against an arbitrary third-party system, or certainty it doesn't have evidence for — see `references/safety-model.md` before making any claim about what's guaranteed.

## Two modes

**Audit mode** (default). The user asks to find risky mutations, unsafe retry assumptions, or "which actions should use corrobo." Produce a report only. Do not edit code. Follow `references/audit-guide.md`.

**Integration mode**. The user explicitly asks to wrap, fix, or integrate a *specific* operation. Inspect the exact relevant code, propose the minimal Effect Contract, implement it, add tests, verify. Do not touch unrelated code. Follow `references/integration-guide.md`.

If the request is ambiguous about which is wanted, default to audit mode and confirm before editing anything.

## Core vocabulary — internalize before reasoning about any specific operation

Evidence states (what the evidence establishes): `APPLIED`, `NOT_APPLIED`, `CONFLICTED`, `PENDING`, `UNKNOWN`.
Recovery dispositions (what's safe to do next): `COMPLETE`, `RETRY`, `REPLAN`, `REVIEW`, `INVESTIGATE`.

These are two different axes — never conflate them:

- `APPLIED` → `COMPLETE`.
- `NOT_APPLIED` → `RETRY` only if the operation is actually safe to retry (native idempotency, or a naturally idempotent write); otherwise → `INVESTIGATE`.
- `CONFLICTED` → `REPLAN` (a new intent/identity is needed, not a retry of this one).
- `PENDING` → **no disposition yet.** Re-observe later. Never re-execute merely because convergence is incomplete.
- `UNKNOWN` → `INVESTIGATE`, never a silent retry.
- `REVIEW` is a **pre-execution** policy gate on a known, well-formed action requiring human authorization — it never comes from evidence.
- `INVESTIGATE` is what happens when evidence *after* an execution attempt cannot establish what happened, or a safe retry is exhausted.

Full detail, including the concurrency model and exact non-guarantees: `references/safety-model.md`.

## Workflow

1. Read `references/safety-model.md` once per session before reasoning about any specific operation — it's the shared vocabulary both modes depend on.
2. Determine the mode from the user's request (see above).
3. Follow `references/audit-guide.md` or `references/integration-guide.md`.
4. Never invent idempotency, versioning, or authoritative read-back that the inspected code or API doesn't actually have. If evidence would be genuinely insufficient, say so plainly — `UNKNOWN`/`INVESTIGATE` is a correct conclusion, not a failure to find a better one.
5. Only flag operations where repeating the action could matter externally. Read-only requests, pure functions, local cache updates, and ordinary in-memory writes are never side effects in this sense — do not report them.
