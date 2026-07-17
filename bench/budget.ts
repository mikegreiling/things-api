/**
 * Token-budget bookkeeping for a sweep (`--max-total-tokens`). Kept in its own
 * side-effect-free module so the accumulation/stop decision is unit-testable without
 * importing runner.ts (which runs `main()` on import).
 */
import type { RunRecord, TaskSpec } from "./types.ts";

/** Distinct exit code when a sweep stops early because the token budget was spent. */
export const EXIT_TOKEN_BUDGET = 8;

/**
 * True once the accumulated total (tokensIn + tokensOut across completed runs) has
 * EXCEEDED the cap. A cap of 0 (or negative) means unlimited — always false. The
 * run that pushes the total over the cap still completes and stays valid; the check
 * is evaluated BEFORE launching each subsequent run.
 */
export function overBudget(spentTokens: number, maxTotalTokens: number): boolean {
  return maxTotalTokens > 0 && spentTokens > maxTotalTokens;
}

/** One selected (task, rep) unit of work in a sweep. */
export interface SweepUnit {
  task: TaskSpec;
  rep: number;
}

export interface SweepResult {
  /** Completed, graded runs (scored). */
  records: RunRecord[];
  /** Placeholder records for units skipped once the budget was spent (not scored). */
  skipped: RunRecord[];
  /** Total tokens (in + out) accumulated across completed runs. */
  spentTokens: number;
}

/**
 * Drive a sweep's units in order under the token budget. Before each unit, if the
 * running total already exceeds the cap, the unit is recorded as skipped via
 * `makeSkipped` and never executed; otherwise `runOne` runs it and its tokens are
 * added to the total. `onRecord` fires for every record (completed or skipped) in
 * order, so the caller can stream to runs.jsonl / stdout. Extracted here (rather than
 * inlined in the runner loop) so the stop decision is testable with a fake `runOne`.
 */
export async function executeSweep(
  units: readonly SweepUnit[],
  maxTotalTokens: number,
  runOne: (task: TaskSpec, rep: number) => Promise<RunRecord>,
  makeSkipped: (task: TaskSpec, rep: number) => RunRecord,
  onRecord?: (record: RunRecord, skipped: boolean) => void,
): Promise<SweepResult> {
  const records: RunRecord[] = [];
  const skipped: RunRecord[] = [];
  let spentTokens = 0;
  for (const { task, rep } of units) {
    if (overBudget(spentTokens, maxTotalTokens)) {
      const rec = makeSkipped(task, rep);
      skipped.push(rec);
      onRecord?.(rec, true);
      continue;
    }
    const rec = await runOne(task, rep);
    records.push(rec);
    spentTokens += rec.tokensIn + rec.tokensOut;
    onRecord?.(rec, false);
  }
  return { records, skipped, spentTokens };
}
