# Pressure-test v0: does one Effect Contract abstraction survive real side-effecting operations?

Status: research only. No runtime code, packages, or Skill exist yet. This document is the Phase 1 deliverable — decide GO/MODIFY/STOP before anything is scaffolded.

Method: inspected the frozen `relay-reliability-harness` repo read-only (GitHub API only, no clone, no writes) for its actual reconciliation/recovery/fault model, then pressure-tested the proposed Effect Contract idea against 5 real, structurally different side-effecting operations in real open-source codebases.

---

## 0. What the frozen Relay repo actually does (for calibration)

Read-only inspection of `lib/domain/types.ts`, `lib/domain/desired-effects.ts`, `lib/reconciliation/reconciliation-engine.ts`, `lib/recovery/recovery-engine.ts`, `lib/policies/risk-policy.ts`, `lib/faults/fault-injecting-adapter.ts`.

The shipped model is richer than the 5-state sketch in the brief:

- **8 reconciliation statuses**: `CONFIRMED_APPLIED`, `CONFIRMED_NOT_APPLIED`, `PARTIALLY_APPLIED`, `CONFLICTED`, `UNKNOWN`, `NO_OP_DUPLICATE`, `BLOCKED_PRECONDITION`, `REVIEW_REQUIRED`.
- **7 recovery decisions**: `COMPLETE`, `RETRY_ACTION`, `RETRY_MISSING_ACTIONS`, `REPLAN_REQUIRED`, `HUMAN_REVIEW_REQUIRED`, `MANUAL_INVESTIGATION_REQUIRED`, `FAIL_CLOSED`.
- Idempotency keys are per-entity (inspection/settlement/note each carry one) and matched against read-back state via `matchDesiredEffect`.
- `expectedVersionAtPlan` gives per-action optimistic concurrency.
- Fault injection is a decorator (`FaultInjectingAdapter`) around a plain delegate interface, with `BEFORE_WRITE` / `AFTER_WRITE` / `READBACK` injection phases — cleanly separate from the production path, matching decision #9.
- Risk policy (review threshold, precondition blocking) is a fully separate module from reconciliation — good precedent for keeping "is this safe to attempt" distinct from "what actually happened."

Takeaway: Relay's real implementation is closer to a well-differentiated state machine than the 5+5 sketch suggests. That's a design question for v0 (see §D, §E) — not a reason to distrust the sketch.

---

## A. Five real projects/operations examined

| # | Project | Operation | Why chosen |
|---|---|---|---|
| 1 | Stripe (`stripe/agent-toolkit` + Stripe API) | `create_refund` — `POST /v1/refunds` | Payment/refund mutation with the strongest native idempotency story of anything examined |
| 2 | GitHub (`github/github-mcp-server`) | `merge_pull_request`, `create_issue`/`update_issue` | Code mutation; one operation has native optimistic concurrency, the other has neither idempotency nor versioning |
| 3 | Slack (`korotovsky/slack-mcp-server` + Slack Web API) | `chat.postMessage` | Messaging mutation with **no** native idempotency and an expensive/lossy read-back |
| 4 | Linear (community Linear MCP servers + Linear GraphQL API) | `issueCreate` / `issueUpdate` | Ticketing mutation with client-generated-id idempotency but caller-enforced (not server-enforced) concurrency |
| 5 | Kubernetes (`GoogleCloudPlatform/kubectl-ai` + Kubernetes API) | `kubectl apply` / `kubectl scale` | Infra mutation that is fundamentally declarative and asynchronously-converging — stress-tests whether APPLIED/NOT_APPLIED can even be binary |

Deliberately diverse: one has excellent native support (Stripe), one is a mixed bag within a single API (GitHub), one has essentially nothing (Slack), one is in between (Linear), and one breaks the binary-outcome assumption entirely (Kubernetes).

---

## B. Findings per operation

### B1. Stripe — `create_refund`
- Transport 200 proves Stripe *accepted* the refund, not that funds moved — `status` starts `pending`/`requires_action` for some rails and resolves async to `succeeded`/`failed`. **This is a real PENDING case, not just APPLIED/NOT_APPLIED.**
- **Native idempotency, confirmed and strong**: `Idempotency-Key` header, Stripe caches the first response per key ≥24h, mismatched params on key reuse error out, and a timeout can be safely resolved by retrying with the *same* key.
- No traditional optimistic concurrency (refunds aren't updated), but the real precondition — "remaining refundable balance" — is enforced server-side, giving a clean REPLAN trigger (over-refund attempt fails because the world changed).
- REVIEW trigger: refund above a policy $ threshold, or `reason: fraudulent` (has side effects like blocklisting).
- INVESTIGATE trigger: timeout with **no idempotency key ever recorded** — the one way to force UNKNOWN here, and it's entirely the caller's responsibility to avoid it (generate and persist the key *before* calling).
- Honest limit: Stripe's idempotency guarantees exactly-once at Stripe's boundary, not exactly-once at the customer's bank.
- **Fit**: excellent. Stripe's own model is nearly isomorphic to the proposed evidence-state machine.

### B2. GitHub — `merge_pull_request` vs. `create_issue`/`update_issue`
- `merge_pull_request` supports `expectedHeadSha` as a genuine optimistic-concurrency precondition, and merging an already-merged PR is a harmless 405 — naturally idempotent. This is the strongest real-world example of REPLAN (base moved) and safe blind retry coexisting cleanly, already mechanized by GitHub itself.
- `create_issue` / `add_comment` have **no native idempotency at all** (confirmed via GitHub's own community discussion on the gap) and **no** version precondition on `update_issue` — last-write-wins.
- The only workaround for issue/comment dedup is embedding a correlation token in the body and searching for it later — and that search itself runs against an eventually-consistent index, so even *reconciliation* can't be made fully authoritative for this operation.
- **Fit**: natural for merge, strained for issue/comment creation — good evidence for why INVESTIGATE must exist as a distinct, honest disposition rather than the runtime pretending it can always resolve to APPLIED/NOT_APPLIED.

### B3. Slack — `chat.postMessage`
- No `ts` (message id) is returned until the call *succeeds* — a timeout leaves nothing to look up. There's no server-issued correlation id for a failed call.
- **Native idempotency: confirmed absent.** `client_msg_id` is part of Slack's internal real-time-client machinery, not a documented Web API parameter; a 2018 feature request for post-level idempotency is unresolved in an archived repo.
- `observe()` here is not a cheap direct-key read — it's a rate-limited (1 req/min for non-Marketplace apps), paginated scan of channel history. The only reliable operation-identity mechanism is embedding a UUID in `metadata.event_payload` or the message text *before* sending, then searching for it after.
- This is the case that most stresses the "observe() is cheap and reliable" assumption implicit in the sketch.
- **Fit**: the abstraction still earns its keep here — precisely because Slack has no memory of its own duplicates, external evidence-tracking is the only way to know — but mandating the full contract for "just send a message" is real friction if `observe()` isn't allowed to be explicitly declared expensive/best-effort.

### B4. Linear — `issueCreate` / `issueUpdate`
- `IssueCreateInput.id` can be **client-generated** (a UUID) before the call — genuine, documented, caller-controlled idempotency: retry with the same id, then read back that id to check pre-existence.
- Read-back is a direct-key lookup (`issue(id)`), not a scan — much closer to Linear's own db row than Slack's history scan.
- No documented version/ETag precondition on `issueUpdate` — only an `updatedAt` timestamp a caller can compare, so optimistic concurrency is caller-enforced and racy, not API-enforced.
- **Fit**: good — most of the primitives (id-based idempotency, O(1) read-back, staleness timestamp) already exist; the contract maps onto them almost 1:1.

### B5. Kubernetes — `kubectl apply` / `kubectl scale` (via kubectl-ai)
- kubectl-ai has **no automated read-back after a mutation** — verification, if any, is left to the LLM's own conversational judgment. It does have a real, working REVIEW gate: any tool call classified `modifies_resource != "no"` blocks on user confirmation by default (`skipPermissions: false`) — a clean, already-implemented instance of the REVIEW disposition.
- `resourceVersion` gives genuine, API-enforced optimistic concurrency (409 on staleness) — confirmed via Kubernetes API conventions.
- **The strongest finding of the whole pressure test**: Kubernetes is fundamentally declarative and asynchronously reconciled. A write can be durably accepted (new `resourceVersion`) while the real-world effect (pods running, service healthy) is still converging — for seconds to minutes. Binary APPLIED/NOT_APPLIED is too coarse; forcing "spec accepted, not yet converged" into APPLIED risks false positives, forcing it into UNKNOWN wastes a state that's perfectly legible and pollable (watch `status.observedGeneration`/conditions to convergence or timeout).
- **This is direct evidence that PENDING must be a first-class, commonly-hit evidence state — not a rare fallback.**

---

## C. Does one Effect Contract abstraction survive all 5?

**Yes, with modifications.** The core lifecycle (intent → execute → transport evidence → observe → reconcile → evidence state → disposition) held up in every case without needing to be abandoned or forked per-integration. What needed adjusting is described in §D.

The REVIEW vs. INVESTIGATE distinction in particular held up cleanly everywhere it was tested: REVIEW is a policy gate on a *known* action (Stripe threshold, GitHub protected-branch merge, kubectl-ai's confirmation prompt); INVESTIGATE is specifically "we don't have enough identity/evidence to know what happened" (Slack timeout with no correlation id yet persisted, GitHub issue-creation timeout with an inconclusive eventually-consistent search). No case blurred these two together.

## D. Problems discovered with the proposed model

1. **PENDING is not an edge case — for some operations it's the normal, expected state for a bounded duration.** Kubernetes proved this hardest, but Stripe's async refund statuses are the same shape. The runtime needs a genuine "observed, evidence says converging, check again within budget X" path, not just a fast binary answer.
2. **`observe()` is not uniformly cheap or reliable.** Linear/Stripe/GitHub-merge: cheap, direct-key, effectively immediate. Slack: rate-limited, paginated, and the *only* index available is a scan. GitHub issue search: eventually consistent. The contract must let an integration declare "my observe is authoritative-and-cheap" vs. "my observe is best-effort-and-lossy" rather than assuming all observations are equally trustworthy.
3. **Idempotency and precondition support are per-operation-type capabilities, not per-integration flags.** GitHub is the clearest example: `merge_pull_request` has `expectedHeadSha`; `update_issue` has nothing. A single "does this integration support idempotency?" boolean would be wrong for GitHub as a whole.
4. **When native idempotency is absent, reconciliation itself becomes probabilistic, not certain** (Slack, GitHub issues) — the runtime's own dedup-by-search step inherits the eventual-consistency and rate-limit problems of the underlying read. Confidence should be surfaced, not hidden behind a clean-looking enum value.
5. **Relay's 8-state/7-decision granularity is probably too much surface for a public v0 API** — see §F.
6. **"Exactly-once" cannot be honestly promised across any third-party boundary the runtime doesn't control** (Stripe → bank rail; GitHub issue dedup → search index race). This must stay out of the marketing/docs language entirely, consistent with the existing positioning constraint.

## E. Minimum concepts that appear genuinely necessary

- Typed **intent** (desired effect) with a stable **operation identity** — native when the integration provides it (Stripe key, Linear client id), caller-constructed via an embedded correlation token when it doesn't (Slack, GitHub issues) — and the runtime should make explicit which kind is in play.
- **execute()** that captures raw transport evidence (status, timeout-vs-error, whatever id came back) without interpreting it as business truth.
- **observe()** as a pluggable, explicitly fallible strategy — allowed to be "cheap direct read," "expensive scan," or "poll until convergence or budget expires" (Kubernetes case) — not a single assumed shape.
- **reconcile(intent, observed) → evidence state**, where evidence states are **APPLIED / NOT_APPLIED / CONFLICTED / UNKNOWN / PENDING**, with PENDING meaning "observed, not yet converged" as a first-class, expected outcome for some operation types.
- **Recovery disposition**: COMPLETE / RETRY / REPLAN / REVIEW / INVESTIGATE, mapped from evidence state plus policy — this mapping held up in every case examined.
- **Declared per-operation-type capabilities**: does this operation have native idempotency? native optimistic concurrency? Both are sometimes true (Stripe), sometimes split within one API (GitHub), sometimes absent (Slack).
- **Durable persistence** (Postgres) of: intent, operation identity/idempotency key, attempt log, last-observed evidence — a crash mid-flight must be resumable without re-deriving all of this, and Kubernetes' convergence-watch case specifically needs a checkpoint to resume polling rather than re-mutating.
- **Fault injection as a separate decorator/harness**, architecturally outside the production path — Relay's existing `FaultInjectingAdapter` pattern (BEFORE_WRITE/AFTER_WRITE/READBACK) is a good, already-validated shape for this.

## F. Concepts that looked unnecessary or overengineered for v0

- **A mandatory version/precondition field on every operation.** Several real operations examined have none (Slack post, GitHub issue create) — making it required in the API shape creates friction for exactly the cases where it can't be honestly filled in. Make it optional per operation.
- **Exposing Relay's full 8-state/7-decision enum set as the public API.** `PARTIALLY_APPLIED`, `NO_OP_DUPLICATE`, and `BLOCKED_PRECONDITION` are useful *internal* nuance but are better modeled as reason codes/metadata layered on top of the simpler 5-state/5-decision public surface, not as top-level enum values developers must branch on from day one.
- **A single generic `observe()` shape that assumes a cheap synchronous read.** Building this generically before seeing more integrations risks getting the shape wrong (Slack and Kubernetes already need different shapes — scan-with-token vs. poll-to-convergence).
- **Any prebuilt, maintained connector marketplace.** Explicitly out of scope already, and the research reinforces why: even within one vendor (GitHub, Slack) the idempotency/versioning story varies by *operation*, so a maintained "GitHub connector" would need per-endpoint capability metadata anyway — that's a v1+ problem, not v0.

## G. TypeScript vs. Python — recommendation

The examined ecosystem does not contradict the TypeScript-first decision; if anything it reinforces it. Every agent-facing integration point actually inspected was TypeScript or Go, not Python: `stripe/agent-toolkit` (TS), `github/github-mcp-server` (Go, but its client ecosystem and most community MCP servers are TS/Node), `korotovsky/slack-mcp-server` (TS/Node), the community Linear MCP servers surveyed (TS/Node), and `kubectl-ai` (Go). The MCP ecosystem in general, where these tool-calling integrations live, skews TS/Node for server implementations. No evidence surfaced that Python is the lower-friction choice for *this* specific niche (side-effecting tool-call reliability), even though Python remains dominant in general ML/data tooling. **Recommendation: keep TypeScript-first for v0.** Revisit Python as a second-language port once there's real usage signal, not speculatively.

## H. Recommended first integration/example

Keep the original two-step plan, now evidence-backed rather than assumed:

1. **Generic REST mutation** as the framework-independence proof (no vendor SDK, no AI-framework dependency in `core`) — ships first, proves the abstraction works with plain `fetch`/HTTP.
2. **Stripe refund** as the flagship "aha" demo — of everything examined, it has the cleanest, most honest mapping onto the proposed model (native idempotency key, async status lifecycle that naturally produces a PENDING case, a real REPLAN trigger via balance-exceeded, a real REVIEW trigger via policy threshold) and the story ("run this and watch it *not* double-refund when the response disappears") is immediately understandable, exactly as anticipated in decision #7.

Do not build Slack/GitHub/Linear/Kubernetes as maintained connectors for v0 — write them up as **documented worked examples** (this report is most of that content already) to demonstrate the model generalizes, without taking on maintenance burden for four more vendor APIs.

## I. Preliminary v0 boundary

**In v0 core:**
- Intent types, `execute()` wrapper capturing raw transport evidence, `observe()` as a pluggable/declarable strategy, `reconcile()`.
- 5-state evidence enum, 5-value recovery-disposition enum, with reason-code metadata for nuance.
- Idempotency key generation/storage; optional per-operation expected-version/precondition field.
- Postgres-backed durable persistence of intent, identity, attempt log, evidence.
- Fault-injection test harness, architecturally separate from the production execute path.
- One fully-built example (generic REST) + one flagship demo (Stripe refund).

**Explicitly out of v0:**
- The Agent Skill (per decision #8 — runtime API first).
- Any GitHub/npm publication, public repo, or remote.
- Maintained Slack/GitHub/Linear/Kubernetes connectors (documented examples only).
- A generic "poll to convergence" helper for declarative/async systems — model PENDING as a state now; build convergence-watch tooling once a second declarative-style integration justifies generalizing it.
- Python port, UI/dashboard, orchestration/workflow features.

## J. Naming directions

Checked npm registry + top-level GitHub username/org availability (2026-09-07) for ~30 candidates evoking effects/certainty/recovery without generic AI branding. Shortlist:

| Name | npm | github.com/\<name\> | Notes |
|---|---|---|---|
| `corrobo` | free | free | from "corroborate"; short, pronounceable, distinctive |
| `oncefx` | free | free | evokes idempotency ("once") + effects; short, techy but clear |
| `veractl` | free | free | veracity + control; slightly techy read |
| `affirmly` | free | free | evokes confirmation; reads a bit more consumer-brand-ish |
| `certn` | free | taken (user) | "certain" clipped; still usable as an npm/repo name under an org |
| `resolvo` | free | taken (user) | evokes resolution/recovery; still usable as an npm/repo name |
| `ledgent` | free | not checked | ledger + agent — flag: bakes in "agent," may age poorly and reads as AI branding, which decision #10 wants to avoid |
| `groundtruth` | free | not checked | flag: overloaded ML term, reads generic-AI |
| `evidently` | taken | not checked | real dictionary word — SEO/trademark risk, and it's already an npm package |

Not exhaustive — worth a manual GitHub/npm/trademark pass on the final 2-3 before committing, per decision #10. `corrobo` and `oncefx` are the strongest candidates from this pass on the "short, distinctive, not generic-AI, hints at the concept without being overly literal" criteria.

## K. Recommendation: GO (with modifications)

The core idea — treating a transport response as evidence rather than truth, and routing outcomes through a small disposition vocabulary (COMPLETE/RETRY/REPLAN/REVIEW/INVESTIGATE) — survived five structurally different real operations without needing to be abandoned for any of them, including one (Kubernetes) that actively breaks a naive binary-outcome model. That's a meaningfully positive result for Phase 1.

Required modifications before implementation, not blockers to proceeding:
- Treat PENDING as a first-class, expected outcome for some operation types, not a rare fallback.
- Make `observe()` a declared, pluggable strategy (cheap-authoritative vs. best-effort-scan vs. poll-to-convergence) instead of assuming one shape.
- Declare idempotency/precondition support per operation-type, not per integration.
- Collapse the public API surface to 5 evidence states / 5 dispositions; keep richer nuance (partial-application, duplicate-detected, precondition-blocked) as reason-code metadata, following Relay's own internal precedent but not its full public surface.

## L. Open questions for the user

1. Public API granularity: confirm the 5+5 enum (with reason-code metadata) over exposing Relay's fuller 8-state/7-decision model directly.
2. Should v0 ship any generic "poll until convergence" helper for declarative/async operations (Kubernetes-style), or is documenting the pattern enough until a second such integration exists?
3. Sequencing: generic REST mutation and Stripe refund were both recommended (framework-proof vs. flagship demo) — confirm both ship for v0, or pick one to ship first.
4. How much should "caller-constructed operation identity" (embed-a-token-and-search-for-it, used by both Slack and GitHub issues) be a first-class helper in `core` vs. a documented pattern only — given it's inherently best-effort/racy and could create a false sense of certainty if packaged too cleanly.
5. Final name selection from §J (or a fresh direction) — needs explicit sign-off before any npm/GitHub claim is made.
6. Postgres-required-from-day-one vs. in-memory dev mode: the Kubernetes convergence-tracking case strengthens the argument for durable state even in dev/test — confirm whether in-memory mode is still worth building for v0 or whether Postgres should be required unconditionally.
