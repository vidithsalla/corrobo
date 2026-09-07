# Dogfood audit 3: Slack `chat.postMessage` (external, read-only inspection)

Performed by following `references/audit-guide.md` against the publicly documented behavior of Slack's Web API `chat.postMessage`, as used by community Slack MCP servers (reusing facts already gathered in `docs/pressure-test-v0.md` — not re-researched). No external project was touched; audit-mode reasoning only.

## Step 1 — candidate side effect

- `chat.postMessage` — posts a message to a channel/DM/thread. Consequential: a human sees it, and it cannot be silently un-sent (deleting a message is itself a visible action).

## Findings

| Operation | Risk | Current behavior | Identity | Observation | Retry hazard | Recommended corrobo treatment |
|---|---|---|---|---|---|---|
| `chat.postMessage` | Medium-High for a broadcast/`@here`/`@channel` message; Medium otherwise | Typical MCP wrapper calls the Slack Web API directly; the community server reviewed disables this tool by default "for safety" but has no retry/idempotency logic when enabled | **None found.** Slack does not accept a caller-supplied idempotency key on this endpoint — `client_msg_id`-style fields belong to Slack's own real-time client machinery, not the bot/app Web API surface (confirmed absent, not merely undocumented) | Only a paginated, rate-limited scan of `conversations.history` — **not** a direct lookup, and only usable at all if a `ts` or an embedded correlation value is available to match against. On a timeout with no `ts` captured, there is nothing to search for that reliably distinguishes "never sent" from "sent, response lost" | High — a timeout leaves no server-issued correlation id, and Slack itself has no memory of "this exact request already happened" | `execute()` = the post call, with a caller-generated correlation UUID embedded in `metadata.event_payload` *before* the call (this is the only identity mechanism available — do not describe it as anything stronger than best-effort); `observe()` = `conversations.history` filtered to recent messages, matched by `ts` if known or by the embedded UUID otherwise, `authoritative: false`; `reconcile()`: a match → `APPLIED`; a timeout with the UUID embedded and a clean "not found after a reasonable window" → treat cautiously, since history scans can be rate-limited/incomplete — prefer `UNKNOWN → INVESTIGATE` over a confident `NOT_APPLIED` unless the scan is known-complete for the window; a timeout with **no UUID ever embedded** (e.g. it failed before the request body was even built) → `UNKNOWN → INVESTIGATE`, never a blind retry, since a retry here could genuinely double-post with no way to later tell it was a duplicate. |

## Check against no-false-positive/no-hype rules

- Did not invent a Slack idempotency mechanism — explicitly stated the identity field is caller-generated and best-effort, not an API guarantee, per `safety-model.md`'s "no certainty from an idempotency key alone" rule (here there isn't even a real key, just an embedded correlation value).
- Did not call the channel-history scan authoritative — labeled it `authoritative: false` and flagged its rate-limit/pagination fragility explicitly, rather than treating "message not found in history" as proof of non-delivery.
- Leaned toward `INVESTIGATE` over a confident `NOT_APPLIED` in the ambiguous no-UUID timeout case, consistent with `safety-model.md`: `UNKNOWN`/`INVESTIGATE` is a legitimate answer, not a shortcoming to be reasoned around.
