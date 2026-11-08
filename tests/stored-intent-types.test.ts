import { describe, expectTypeOf, it } from "vitest";
import { defineContract, observed, reconciled } from "../src/core/helpers";
import type { ExecuteInput, StoredIntent } from "../src/core/types";

/**
 * Hooks receive the stored (JSON) form of the intent, and their types say so (0.6.0). These are
 * compile-time checks: `npm run typecheck` fails if StoredIntent stops matching what JSON keeps.
 */
describe("StoredIntent", () => {
  it("is the same type for an intent that is already plain JSON data", () => {
    type Refund = { orderId: string; amountCents: number; tags: string[]; meta: { note: string | null } };
    expectTypeOf<StoredIntent<Refund>>().toEqualTypeOf<Refund>();
  });

  it("turns a Date into its ISO string, as stored", () => {
    expectTypeOf<StoredIntent<{ when: Date }>>().toEqualTypeOf<{ when: string }>();
    expectTypeOf<StoredIntent<{ at: Date[] }>>().toEqualTypeOf<{ at: string[] }>();
  });

  it("applies toJSON() and drops function-valued properties", () => {
    type Money = { toJSON(): { cents: number } };
    expectTypeOf<StoredIntent<{ price: Money }>>().toEqualTypeOf<{ price: { cents: number } }>();
    expectTypeOf<StoredIntent<{ id: string; format: () => string }>>().toEqualTypeOf<{ id: string }>();
  });

  it("is what execute() is typed to receive", () => {
    expectTypeOf<ExecuteInput<{ when: Date }>["intent"]>().toEqualTypeOf<{ when: string }>();
  });

  it("makes reading a stored Date as a Date a compile error inside a hook", () => {
    defineContract<{ when: Date }>()({
      operationType: "types/date",
      retryPolicy: { maxAttempts: 1, retryOnNotApplied: false },
      execute: async ({ intent }) => {
        // @ts-expect-error intent.when is the stored ISO string, not a Date
        intent.when.getTime();
        return new Date(intent.when).getTime();
      },
      observe: async () => observed(1, { source: "s", authoritative: true }),
      reconcile: () => reconciled("APPLIED", "A", "a")
    });
  });
});
