#!/usr/bin/env node
// Mutation check for the review flow: reintroduces known review-flow bugs one at a time and checks
// that the model-based test (tests/review-state-machine.test.ts) catches each one on its own.
// Usage: node scripts/review-mutations.mjs [name-prefix ...]   (restores every file it touches)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// [name, file, original code, mutated code]
const MUTATIONS = [
  ["M1 \u00d6mer: no token check", "src/core/runtime.ts", "if (!episode || decision.reviewToken !== episode.token) {", "if (!episode) {"],
  ["M2 no new review on requiresReview", "src/core/runtime.ts", "await openReviewEpisode(store, base.identity, fingerprintIntent(contract, record.intent), record.reviewEpisode, record.review)", "(record.reviewEpisode ?? await openReviewEpisode(store, base.identity, fingerprintIntent(contract, record.intent), undefined))"],
  ["M3 no approval recheck after revalidate()", "src/core/runtime.ts", "if (after) result = { outcome: \"requiresReview\", reason: after };", ""],
  ["M4 no expiry check", "src/core/runtime.ts", "  if (expiry && Date.parse(now) >= Date.parse(expiry.at)) {", "  if (false) {"],
  ["M5 no re-observe after approval", "src/core/runtime.ts", "if (latest.transport.ok && !approvedSinceLatest) {", "if (latest.transport.ok) {"],
  ["M6 no decidedAt guard", "src/core/runtime.ts", "if (decision.decidedAt !== undefined && Date.parse(decision.decidedAt) < Date.parse(episode!.openedAt)) {", "if (false) {"],
  ["M7 answered reviews stay open", "src/core/runtime.ts", "  return answered ? null : episode;", "  return episode;"],
  ["M8 approval needs no matching token", "src/core/runtime.ts", "    typeof record.review.reviewToken === \"string\" &&\n    record.review.reviewToken === record.reviewEpisode?.token;", "    true;"],
  ["M9 retry without settlement re-check", "src/core/runtime.ts", "    const settled = await reObserve(store, contract, existing, request.intent, latest);", "    return await checkThenAttempt(store, contract, existing, request);\n    const settled = await reObserve(store, contract, existing, request.intent, latest);"],
  ["M10 decision on a non-awaiting op", "src/core/runtime.ts", "      refuse(\"NOT_AWAITING_REVIEW\", `it is ${existing.status}, not awaiting review; see error.current.`);", ""],
  ["M11 revalidate() verdict ignored", "src/core/runtime.ts", "  if (result.outcome === \"proceed\") {\n    return performAttempt(", "  if (true) {\n    return performAttempt("],
  ["M12 superseded decision not moved", "src/core/runtime.ts", "  return reviewEpisode.supersededDecision ? { reviewEpisode, review: null } : { reviewEpisode };", "  return { reviewEpisode };"],
  ["M13 0.4 approvals honored", "src/core/runtime.ts", "const unrecordedApproval = !approval && record.reviewReason !== undefined;", "const unrecordedApproval = false;"],
  ["M14 rejection doesn't close", "src/core/runtime.ts", "{ status: review.decision === \"approved\" ? \"OPEN\" : \"CLOSED\", review }", "{ status: \"OPEN\", review }"],
  ["C1 authorize() ignored at creation", "src/core/runtime.ts", "const initialStatus: OperationStatus = auth.requiresReview ? \"AWAITING_REVIEW\" : \"OPEN\";", "const initialStatus: OperationStatus = \"OPEN\";"],
  ["C2a approval stored as CLOSED", "src/core/runtime.ts", "{ status: review.decision === \"approved\" ? \"OPEN\" : \"CLOSED\", review }", "{ status: \"CLOSED\", review }"],
  ["C2b revalidate() failure closes", "src/core/runtime.ts", "result.outcome === \"requiresReview\" ? \"AWAITING_REVIEW\" : result.outcome === \"reject\" ? \"CLOSED\" : undefined;", "result.outcome === \"requiresReview\" ? \"AWAITING_REVIEW\" : \"CLOSED\";"],
  ["C2c revalidate() reject doesn't close", "src/core/runtime.ts", "result.outcome === \"requiresReview\" ? \"AWAITING_REVIEW\" : result.outcome === \"reject\" ? \"CLOSED\" : undefined;", "result.outcome === \"requiresReview\" ? \"AWAITING_REVIEW\" : undefined;"],
  ["C3a new review on every call", "src/core/runtime.ts", "    if (!openReview(existing)) {", "    if (true) {"],
  ["C3b token reused across reviews", "src/core/runtime.ts", "  const episode: ReviewEpisode = { token, generation, openedAt };", "  const episode: ReviewEpisode = { token: previous?.token ?? token, generation, openedAt };"],
  ["C4 review opened earlier than it did", "src/core/runtime.ts", "  const generation = (previous?.generation ?? 0) + 1;\n  const openedAt = await safetyNow(store);", "  const generation = (previous?.generation ?? 0) + 1;\n  const openedAt = new Date(Date.parse(await safetyNow(store)) - 600_000).toISOString();"],
  ["C6a revalidate() gets no approval", "src/core/runtime.ts", "      approval: approval ? { ...approval } : null,", "      approval: null,"],
  ["C6b revalidate() gets no context", "src/core/runtime.ts", "      context: request.context\n    });\n    // Read each field once", "      context: undefined\n    });\n    // Read each field once"],
  ["C6c revalidate() wrong attempt", "src/core/runtime.ts", "      attemptNumber,\n      approval: approval", "      attemptNumber: attemptNumber + 1,\n      approval: approval"],
  ["C7 no INTENT_MISMATCH refusal", "src/core/runtime.ts", "  if (decision.intentFingerprint !== undefined && decision.intentFingerprint !== intentFingerprint) {", "  if (false) {"],
  ["C8 maxAttempts off by one", "src/core/disposition.ts", "const hasAttemptsRemaining = attemptNumber < retryPolicy.maxAttempts;", "const hasAttemptsRemaining = attemptNumber <= retryPolicy.maxAttempts;"],
  ["C9 PENDING retries", "src/core/runtime.ts", "  if (latest.evidenceState === \"PENDING\") {\n    return resultFromRecord(await reObserve(store, contract, existing, request.intent, latest));\n  }", "  if (latest.evidenceState === \"PENDING\") {\n    return await checkThenAttempt(store, contract, existing, request);\n  }"],
  ["C11 0.3 approvals honored", "src/core/runtime.ts", "const unrecordedApproval = !approval && record.reviewReason !== undefined;", "const unrecordedApproval = !approval && record.reviewReason !== undefined && record.review !== undefined;"],
  ["C12 lock never held", "src/stores/memory.ts", "    if (this.locked.has(identityId)) {\n      return null;\n    }", ""],
  ["C13a attempt doesn't record approval", "src/core/runtime.ts", "    ...(approval ? { approval } : {}),\n    attemptNumber: base.attemptNumber,", "    attemptNumber: base.attemptNumber,"],
  ["C13b attemptCount always 0", "src/core/runtime.ts", "    attemptCount: record.attempts.length", "    attemptCount: 0"],
  ["C14 lock losers lose the token", "src/core/runtime.ts", "    assertSameLogicalOperation(contract, request, prepared, existing);\n    return resultFromRecord(existing);\n  }\n  try {", "    assertSameLogicalOperation(contract, request, prepared, existing);\n    return { ...resultFromRecord(existing), reviewToken: null };\n  }\n  try {"],
  ["N1 later request changes the executed intent", "src/core/runtime.ts", "  const acting = contract.fingerprintIntent ? { ...request, intent: existing.intent as Intent } : request;", "  const acting = request;"],
  ["N2 shorter deploy window applies retroactively", "src/core/runtime.ts", "  return whenStarted === undefined ? current : Math.max(current, whenStarted);", "  return current;"],
  ["N3 window not recorded on the attempt", "src/core/runtime.ts", "    ...(contract.maxInFlightMs !== undefined ? { maxInFlightMs: contract.maxInFlightMs } : {})\n  };\n  const reservedRecord", "  };\n  const reservedRecord"],
];

const only = process.argv.slice(2);
let missed = 0;
for (const [name, path, original, mutated] of MUTATIONS) {
  if (only.length && !only.some((prefix) => name.startsWith(prefix))) continue;
  const source = readFileSync(path, "utf8");
  if (source.split(original).length !== 2) {
    console.log(`${name.padEnd(42)} ANCHOR NOT FOUND (update this mutation)`);
    missed += 1;
    continue;
  }
  writeFileSync(path, source.replace(original, mutated));
  let caught = false;
  try {
    execFileSync("npx", ["vitest", "run", "tests/review-state-machine.test.ts", "-t", "InMemory"], { stdio: "pipe" });
  } catch {
    caught = true;
  } finally {
    writeFileSync(path, source);
  }
  if (!caught) missed += 1;
  console.log(`${name.padEnd(42)} ${caught ? "caught" : "MISSED"}`);
}
process.exit(missed ? 1 : 0);
