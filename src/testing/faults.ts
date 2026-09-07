/**
 * Deterministic fault injection for tests and examples.
 *
 * Architecturally separate from the production execute()/observe() path: nothing in
 * src/core imports this module. A contract under test wraps its own real delegate calls
 * (a real HTTP request, a real DB read) with these helpers to simulate exactly where and
 * how a fault occurs, without corrobo's runtime ever being aware faults exist.
 */

export type FaultKind = "TIMEOUT" | "NETWORK_ERROR" | "TRANSIENT_ERROR";

/**
 * BEFORE_EFFECT: the delegate never runs (simulates a timeout/drop before the mutation reached the server).
 * AFTER_EFFECT: the delegate runs and completes for real, then the fault is thrown (simulates the response
 *   being lost after the side effect already committed — the headline scenario this project exists for).
 * ON_OBSERVE: the observation delegate throws instead of running (simulates a failed read-back).
 */
export type FaultPhase = "BEFORE_EFFECT" | "AFTER_EFFECT" | "ON_OBSERVE";

export interface FaultRule {
  phase: FaultPhase;
  attempt: number;
  fault: FaultKind;
}

export class FaultError extends Error {
  constructor(
    public readonly kind: FaultKind,
    message: string
  ) {
    super(message);
    this.name = "FaultError";
  }
}

export class FaultSchedule {
  constructor(private readonly rules: FaultRule[]) {}

  ruleFor(phase: FaultPhase, attempt: number): FaultRule | undefined {
    return this.rules.find((rule) => rule.phase === phase && rule.attempt === attempt);
  }
}

/** Wraps a delegate that performs the real side effect. */
export function withFaultInjection<Args extends unknown[], R>(
  delegate: (...args: Args) => Promise<R>,
  schedule: FaultSchedule,
  attempt: number
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const before = schedule.ruleFor("BEFORE_EFFECT", attempt);
    if (before) {
      throw new FaultError(before.fault, `injected ${before.fault} before the effect ran (attempt ${attempt})`);
    }

    const result = await delegate(...args);

    const after = schedule.ruleFor("AFTER_EFFECT", attempt);
    if (after) {
      throw new FaultError(
        after.fault,
        `injected ${after.fault} after the effect committed — response lost (attempt ${attempt})`
      );
    }

    return result;
  };
}

/** Wraps a delegate that performs the authoritative read-back. */
export function withObservationFault<Args extends unknown[], R>(
  delegate: (...args: Args) => Promise<R>,
  schedule: FaultSchedule,
  attempt: number
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const rule = schedule.ruleFor("ON_OBSERVE", attempt);
    if (rule) {
      throw new FaultError(rule.fault, `injected ${rule.fault} during observation (attempt ${attempt})`);
    }
    return delegate(...args);
  };
}
