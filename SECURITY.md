# Security

corrobo is a pre-1.0 open-source library published on npm. If you find a security issue (e.g. something that could let a stored operation identity/intent be tampered with, or a way to bypass the same-identity coordination guarantee), please open a GitHub issue with as much detail as you can, or contact the maintainer directly through GitHub if the issue is sensitive enough that a public issue isn't appropriate.

There is no bug bounty program at this stage. Please do not test against any production system's credentials — `examples/stripe-refund/live-smoke.ts` is deliberately restricted to Stripe test-mode keys (`sk_test_...`) and refuses anything else.

## Data handling

corrobo has no telemetry and no corrobo-operated backend — it does not send application data anywhere on its own. `PostgresStore` persists reliability state (intent, transport evidence, observations, reason metadata) only in the database you configure, and requires an explicit `{ acknowledgePersistence: true }` acknowledgement to construct. As of this version, raw thrown error objects are excluded from what `PostgresStore` persists (only `error.message`, a string, is kept) specifically because HTTP-client-style errors commonly carry request headers and response bodies that can include credentials or customer data.

**Accidental sensitive-data persistence is a security concern, not just a privacy one**, and it is one this library cannot fully protect you from: `intent`, observation data, and reason metadata are generic by design, and corrobo has no way to distinguish an ordinary value from a secret. If you find a case where corrobo's own code (not your application's `execute()`/`observe()`/`reconcile()`) causes something unexpected to be persisted, that's a legitimate report under this policy. Please still avoid putting credentials, tokens, or unnecessary personal data into intents, observations, reason metadata, or thrown error messages — corrobo persists what you give it.

See README's [Privacy and data handling](README.md#privacy-and-data-handling) section for the full picture.
