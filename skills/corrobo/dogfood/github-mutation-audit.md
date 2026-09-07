# Dogfood audit 2: GitHub mutations via github-mcp-server (external, read-only inspection)

Performed by following `references/audit-guide.md` against the publicly documented behavior of `github/github-mcp-server`'s `merge_pull_request` and `create_issue`/`update_issue` tools (reusing facts already gathered in `docs/pressure-test-v0.md` — not re-researched). No files in that project were touched; this is audit-mode reasoning only, applied to a project this skill does not own.

## Step 1 — candidate side effects

- `merge_pull_request` tool → REST `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`.
- `create_issue` / `update_issue` tools → GraphQL create/update mutations.
- Excluded: any `get_*`/`list_*` read tools in the same server — read-only, not flagged.

## Findings

| Operation | Risk | Current behavior | Identity | Observation | Retry hazard | Recommended corrobo treatment |
|---|---|---|---|---|---|---|
| `merge_pull_request` | Medium-High (merges code into a branch; can be a protected/release branch) | Server issues the merge REST call directly; no corrobo-style retry-after-observe logic present in the tool itself | The tool supports `expectedHeadSha`, a genuine server-enforced optimistic-concurrency precondition — this is real, not invented for this audit | Direct: `GET /repos/{o}/{r}/pulls/{n}` reads `.merged`/`.merge_commit_sha`, immediately consistent for a single-resource REST read | Low for retry safety (merge is naturally idempotent — merging an already-merged PR returns 405, not a duplicate merge), but a stale `expectedHeadSha` means the base moved under the plan | `execute()` = the merge call with `expectedHeadSha` set from the plan's known base; `observe()` = the direct PR read; `reconcile()`: `.merged && .merge_commit_sha` → `APPLIED`; a 405/409 citing a stale head → `CONFLICTED` → `REPLAN` (do not retry this identity — replan against the new head); merging a **protected/release branch** → gate with `authorize()` → `REVIEW` before ever calling `execute()`, since that's a known action needing sign-off, not an uncertain outcome. |
| `create_issue` / `add_comment` | Medium (creates a visible, hard-to-silently-undo artifact) | No idempotency key support in GitHub's REST/GraphQL API for these calls (confirmed via GitHub's own community discussion, cited in `docs/pressure-test-v0.md`) | **None found.** The only workaround is embedding a caller-generated correlation token in the issue/comment body and searching for it later — this is a best-effort convention, not an API guarantee, and must be labeled as such | Search-based only (GitHub's Search API), which is eventually consistent — **not** authoritative. A "not found" result does not prove absence; a "found" result via token match is reasonably strong but not certain | High if a timeout occurs with no token embedded before the call — a retry has no way to detect a prior success | `execute()` = the create call, always embedding a pre-generated correlation token in the body *before* the call; `observe()` = search-by-token, explicitly `authoritative: false`, `source: "github-search-api"`; `reconcile()`: search hit → `APPLIED`; search miss **after a definitive rejection** (e.g. repo/issue not found) → `NOT_APPLIED`; search miss after a timeout with no prior token record → **`UNKNOWN` → `INVESTIGATE`** — do not claim `NOT_APPLIED` here, since a genuinely absent search result under index lag looks identical to a real absence. |

## Check against no-false-positive/no-hype rules

- Did not claim GitHub "supports idempotency" as a vendor-wide property — explicitly scoped the finding to `merge_pull_request`'s `expectedHeadSha` vs. `create_issue`'s complete lack of one, per operation type, as `audit-guide.md` step 5 requires.
- Did not call the GitHub Search API "authoritative" — labeled it best-effort/eventually-consistent, consistent with `safety-model.md`'s explicit warning against treating search/index evidence as a direct lookup.
- Correctly separated `REVIEW` (protected-branch merge — a known action needing authorization before `execute()`) from `INVESTIGATE` (an issue-creation timeout with no token and an inconclusive search — evidence genuinely insufficient after the fact). These were not conflated.
