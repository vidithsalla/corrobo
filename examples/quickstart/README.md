# Quickstart

The code in the [main README's quickstart](../../README.md#quickstart), runnable: `npm ci && npm run quickstart` from the repo root.

- `quickstart.ts`: the contract and the call. The part between `#region readme` and `#endregion` is the README block, word for word (`tests/quickstart.test.ts` checks).
- `payments-api.ts`: a stand-in payments API. It stores the `reference` you send and lets you look refunds up by it, but doesn't deduplicate on it. `loseNextResponse()` makes the next refund happen and then fail anyway, as if the response was lost.

Expected output:

```
APPLIED COMPLETE
refunds made: 1
```

To use your own API, replace `createPaymentsApi()` with your client and keep the three hooks: `execute()` sends the operation id, `observe()` looks it up and only reads, `reconcile()` compares what it found with the intent.
