/**
 * Verification polling loop. Each poll is a discrete auto-commit read (fresh
 * WAL snapshot — never wrap polls in a transaction). Cadence: immediate,
 * then every 100ms for 2s, then every 300ms until deadline.
 *
 * Deadline classification (design §4):
 *   satisfied            → ok
 *   asserted field moved → mismatch   (partial or contrary write)
 *   only tripwire moved  → timeout    (something happened, not what we asked)
 *   nothing moved        → silent-noop
 *
 * STABLE-MISMATCH EARLY EXIT (DACON1). When an ASSERTED field has moved to a
 * value that is not the target AND that observed value then sits UNCHANGED for a
 * meaningful window, waiting out the rest of the budget cannot change the verdict
 * — the write has settled on the wrong value. The loop returns `mismatch` early
 * once the same mismatching asserted-field observation repeats for ≥
 * {@link STABLE_MISMATCH_MIN_POLLS} consecutive polls spanning ≥
 * {@link STABLE_MISMATCH_MIN_MS}. This is deliberately CONSERVATIVE: ANY change
 * to the observed values resets the window, so it never fires while state is
 * still converging, and it only ever fires on the SAME classification the
 * deadline would have reached (assertedMovement ⇒ mismatch). Short-budget callers
 * (timeout < the window) are unaffected — the window never elapses. It never
 * touches the tripwire (timeout) or silent-noop paths.
 */
import type { Disclosures } from "../disclosures.ts";
import type { CollateralFinding } from "../repeat-collateral.ts";
import type { DeltaEvaluation, RepeatingDiscovery } from "./delta.ts";

/** Consecutive identical mismatching polls required before an early stable-mismatch exit. */
const STABLE_MISMATCH_MIN_POLLS = 3;
/** Minimum wall-clock the mismatching value must sit unchanged before an early exit (ms). */
const STABLE_MISMATCH_MIN_MS = 5000;

export interface PollOutcome {
  kind: "ok" | "timeout" | "mismatch" | "silent-noop" | "collateral";
  attempts: number;
  elapsedMs: number;
  observed: Record<string, unknown> | null;
  discoveredUuid?: string;
  /** Make-repeating: the enriched template/instance/replaced block. */
  repeating?: RepeatingDiscovery;
  /** Make-repeating: the repeating derivation's ALREADY-TIERED disclosures (#634). */
  repeatingDisclosures?: Disclosures;
  /** A distinct failure detail from a terminal evaluation (overrides the generic one). */
  detail?: string;
  /** `collateral` only: the fields that moved with nothing to attribute them to. */
  collateral?: CollateralFinding[];
}

export interface PollerDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollUntilVerified(
  evaluate: () => DeltaEvaluation,
  timeoutMs: number,
  deps: PollerDeps = {},
): Promise<PollOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let last: DeltaEvaluation | null = null;
  // Stable-mismatch tracking: the serialized observed bag of the current unchanged
  // run, when it began, and how many consecutive polls have shown it.
  let stableKey: string | null = null;
  let stableSince = started;
  let stableCount = 0;

  for (;;) {
    attempts += 1;
    last = evaluate();
    if (last.satisfied) {
      return {
        kind: "ok",
        attempts,
        elapsedMs: now() - started,
        observed: last.observed,
        ...(last.discoveredUuid !== undefined && { discoveredUuid: last.discoveredUuid }),
        ...(last.repeating !== undefined && { repeating: last.repeating }),
        ...(last.repeatingDisclosures !== undefined && {
          repeatingDisclosures: last.repeatingDisclosures,
        }),
      };
    }
    // UNEXPLAINED DELTA (CGRD1 guard 3): the requested change LANDED — the
    // evaluation only looks for collateral once the assertions pass — and a field
    // nobody requested moved with it. Waiting cannot unmake that, so return at
    // once with its own kind; the pipeline shapes `verify-failed:collateral`.
    if (last.collateral !== undefined && last.collateral.length > 0) {
      return {
        kind: "collateral",
        attempts,
        elapsedMs: now() - started,
        observed: last.observed,
        collateral: last.collateral,
        ...(last.detail !== undefined && { detail: last.detail }),
      };
    }
    // A terminal evaluation (e.g. an unbreakable template ambiguity) will never
    // resolve by waiting — fail fast as a mismatch with its distinct detail.
    if (last.terminal === true) {
      return {
        kind: "mismatch",
        attempts,
        elapsedMs: now() - started,
        observed: last.observed,
        ...(last.detail !== undefined && { detail: last.detail }),
      };
    }
    const elapsed = now() - started;
    if (now() >= deadline) {
      const kind = last.assertedMovement ? "mismatch" : last.movement ? "timeout" : "silent-noop";
      return {
        kind,
        attempts,
        elapsedMs: elapsed,
        observed: last.observed,
        ...(last.detail !== undefined && { detail: last.detail }),
      };
    }
    // Stable-mismatch early exit: an asserted field has moved to a non-target value
    // that then holds unchanged. Only ASSERTED movement with a concrete observation
    // counts (never the tripwire/timeout or silent-noop paths); ANY change to the
    // observation resets the window, so a still-converging write can never trip it.
    if (last.assertedMovement && last.observed !== null) {
      const key = JSON.stringify(last.observed);
      if (key === stableKey) {
        stableCount += 1;
      } else {
        stableKey = key;
        stableSince = now();
        stableCount = 1;
      }
      if (
        stableCount >= STABLE_MISMATCH_MIN_POLLS &&
        now() - stableSince >= STABLE_MISMATCH_MIN_MS
      ) {
        return {
          kind: "mismatch",
          attempts,
          elapsedMs: now() - started,
          observed: last.observed,
          ...(last.detail !== undefined && { detail: last.detail }),
        };
      }
    } else {
      stableKey = null;
      stableCount = 0;
    }
    // poll retries are inherently sequential: each attempt must observe the DB state left by the previous wait, never overlap
    await sleep(elapsed < 2000 ? 100 : 300);
  }
}
