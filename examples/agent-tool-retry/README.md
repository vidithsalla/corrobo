# Agent tool retries: why keying on toolCallId doesn't stop a duplicate refund

`npm run example:agent-retry` (offline; the model is simulated).

A refund tool's request times out after the refund went through. Shown the default error text ("Please try again"), real models call the tool again: 6 of 6 runs issued the refund twice in [this experiment](https://github.com/openai/openai-agents-js/issues/2184). The retry is a **new tool call, with a new `toolCallId`**.

| Tool | Refunds made |
|---|---|
| 1. Calls the API directly | 2 |
| 2. Idempotency key = `toolCallId` | 2: the retry sends a new key |
| 3. corrobo with identity = `toolCallId`, lookup briefly down | 2: corrobo answers "unknown, don't retry", the model retries anyway, and the new call is a new operation |
| 4. corrobo with identity = the decision (`run + charge + amount`), same outage | 1: the retry is the same operation, so corrobo returns what it recorded |
| 4b. Same, lookup working | 1, and the first call already reports "Refunded": corrobo looked the refund up after the timeout, so the model has nothing to retry |

Keying on `toolCallId` is right for a *worker* replaying the same step after a crash. It can't recognize the *model* deciding to try again. The identity has to name the decision to act; corrobo then reads back by it before doing anything.

The simulated model is the worst case: it retries on any answer that isn't a success. Telling a real model "unknown, don't retry" may help (the experiment above found the error text matters a lot), but the tool shouldn't depend on it.

Files: `payments.ts` (fake API), `agent.ts` (simulated turn), `tools.ts` (the four tools), `demo.ts`.
