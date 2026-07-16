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
 */
import type { DeltaEvaluation } from "./delta.ts";

export interface PollOutcome {
  kind: "ok" | "timeout" | "mismatch" | "silent-noop";
  attempts: number;
  elapsedMs: number;
  observed: Record<string, unknown> | null;
  discoveredUuid?: string;
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
      };
    }
    const elapsed = now() - started;
    if (now() >= deadline) {
      const kind = last.assertedMovement ? "mismatch" : last.movement ? "timeout" : "silent-noop";
      return { kind, attempts, elapsedMs: elapsed, observed: last.observed };
    }
    // poll retries are inherently sequential: each attempt must observe the DB state left by the previous wait, never overlap
    await sleep(elapsed < 2000 ? 100 : 300);
  }
}
