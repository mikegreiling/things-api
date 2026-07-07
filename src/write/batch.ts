/**
 * Batch mutations: N ops through the SAME pipeline as single mutations —
 * every op individually pre-read, guarded, verified, and audited. The wins
 * are amortization (one process, one DB handle, one config load) and a
 * per-op result stream; there is deliberately NO transactional semantics
 * (the app's surfaces have none to offer). Ops run SEQUENTIALLY: the
 * mutation lock serializes them anyway, and create-probe verification must
 * never race.
 */
import { OPERATION_KINDS, type OperationKind, type OperationParamsMap } from "./operations.ts";
import { runMutation, type WriteDeps, type WriteOptions } from "./pipeline.ts";
import { runReorder, type ReorderResult } from "./reorder.ts";

/** One line of a batch: the op kind, its params, and per-op options. */
export interface BatchOp {
  op: OperationKind;
  params: Record<string, unknown>;
  /** Per-op acknowledgements/overrides (a safe subset of WriteOptions). */
  options?: {
    acknowledgeChecklistReset?: boolean;
    acknowledgeProjectReopen?: boolean;
    dangerouslyPermanent?: boolean;
    acknowledgeTagSubtree?: boolean;
    vector?: WriteOptions["vector"];
    verifyTimeoutMs?: number;
    maxDisruption?: WriteOptions["maxDisruption"];
  };
}

export type BatchItemOutcome =
  | ReorderResult
  | { kind: "invalid"; op: string; detail: string }
  | { kind: "skipped"; op: string; detail: string };

export interface BatchItemResult {
  index: number;
  op: string;
  outcome: BatchItemOutcome;
}

export interface BatchOptions {
  /** Stop at the first non-ok outcome; remaining ops report kind "skipped". */
  failFast?: boolean;
  /** Plan every op without executing (each result is its dry-run plan). */
  dryRun?: boolean;
  actor?: string;
}

const KNOWN_OPS = new Set<string>(OPERATION_KINDS);

/** True when an outcome should be treated as a failure for --fail-fast/exit. */
export function outcomeFailed(outcome: BatchItemOutcome): boolean {
  return outcome.kind !== "ok" && outcome.kind !== "dry-run";
}

export async function runBatch(
  deps: WriteDeps,
  ops: BatchOp[],
  options: BatchOptions = {},
  onResult?: (result: BatchItemResult) => void,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  let halted = false;

  for (let index = 0; index < ops.length; index++) {
    const entry = ops[index] as BatchOp;
    let outcome: BatchItemOutcome;

    if (halted) {
      outcome = {
        kind: "skipped",
        op: String(entry?.op),
        detail: "skipped after earlier failure (--fail-fast)",
      };
    } else if (typeof entry !== "object" || entry === null || typeof entry.op !== "string") {
      outcome = {
        kind: "invalid",
        op: String((entry as { op?: unknown })?.op),
        detail: "each op needs {op, params}",
      };
    } else if (!KNOWN_OPS.has(entry.op)) {
      outcome = {
        kind: "invalid",
        op: entry.op,
        detail: `unknown op "${entry.op}" — see \`things capabilities\``,
      };
    } else if (typeof entry.params !== "object" || entry.params === null) {
      outcome = { kind: "invalid", op: entry.op, detail: "params must be an object" };
    } else {
      const writeOptions: WriteOptions = {
        ...(entry.options?.acknowledgeChecklistReset !== undefined && {
          acknowledgeChecklistReset: entry.options.acknowledgeChecklistReset,
        }),
        ...(entry.options?.acknowledgeProjectReopen !== undefined && {
          acknowledgeProjectReopen: entry.options.acknowledgeProjectReopen,
        }),
        ...(entry.options?.dangerouslyPermanent !== undefined && {
          dangerouslyPermanent: entry.options.dangerouslyPermanent,
        }),
        ...(entry.options?.acknowledgeTagSubtree !== undefined && {
          acknowledgeTagSubtree: entry.options.acknowledgeTagSubtree,
        }),
        ...(entry.options?.vector !== undefined && { vector: entry.options.vector }),
        ...(entry.options?.verifyTimeoutMs !== undefined && {
          verifyTimeoutMs: entry.options.verifyTimeoutMs,
        }),
        ...(entry.options?.maxDisruption !== undefined && {
          maxDisruption: entry.options.maxDisruption,
        }),
        ...(options.dryRun === true && { dryRun: true }),
        ...(options.actor !== undefined && { actor: options.actor }),
      };
      try {
        // Params arrive as parsed JSON; the pipeline's pre-read + guards are
        // the runtime validators (loud on bad shapes), same as single ops.
        outcome =
          entry.op === "reorder"
            ? await runReorder(
                deps,
                entry.params as unknown as OperationParamsMap["reorder"],
                writeOptions,
              )
            : await runMutation(
                deps,
                entry.op as Exclude<OperationKind, "reorder">,
                entry.params as never,
                writeOptions,
              );
      } catch (err) {
        // Param-shape errors (exclusive combos etc.) surface per-op, not fatally.
        outcome = {
          kind: "invalid",
          op: entry.op,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const result: BatchItemResult = { index, op: String(entry?.op), outcome };
    results.push(result);
    onResult?.(result);
    if (options.failFast === true && !halted && outcomeFailed(outcome)) halted = true;
  }
  return results;
}
