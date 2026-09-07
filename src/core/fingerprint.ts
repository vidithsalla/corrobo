import type { EffectContract } from "./types";

/**
 * Deterministic canonicalization for the plain, JSON-serializable intent shapes corrobo
 * accepts: recursively sorts object keys (array order is preserved — it's meaningful) so two
 * intents that differ only in property insertion order fingerprint identically. Not a
 * general-purpose serialization framework — intents with functions, symbols, or circular
 * references are out of scope, exactly like every intent already persisted via JSON.stringify
 * in PostgresStore.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Fingerprints an intent for reused-identity binding (see runtime.ts). Uses the contract's
 * own fingerprintIntent() when provided, otherwise the canonical-JSON default above.
 */
export function fingerprintIntent<Intent>(
  contract: Pick<EffectContract<Intent, unknown, unknown>, "fingerprintIntent">,
  intent: Intent
): string {
  if (contract.fingerprintIntent) {
    return contract.fingerprintIntent(intent);
  }
  return canonicalStringify(intent);
}
