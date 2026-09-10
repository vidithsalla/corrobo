# Security

corrobo is a pre-1.0 open-source library published on npm. If you find a security issue (e.g. something that could let a stored operation identity/intent be tampered with, or a way to bypass the same-identity coordination guarantee), please open a GitHub issue with as much detail as you can, or contact the maintainer directly through GitHub if the issue is sensitive enough that a public issue isn't appropriate.

There is no bug bounty program at this stage. Please do not test against any production system's credentials — `examples/stripe-refund/live-smoke.ts` is deliberately restricted to Stripe test-mode keys (`sk_test_...`) and refuses anything else.
