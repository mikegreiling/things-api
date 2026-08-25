/**
 * Shared client-idempotency (`opId`) machinery — the ONE place the lookback
 * window and match rule live, so the batch path and the single-op path agree by
 * construction rather than by two copies staying in sync.
 *
 * An `opId` is a caller-supplied idempotency key recorded on the audit record of
 * the mutation it accompanied. Before a mutation that carries one is dispatched,
 * the recent change history is scanned for an `ok` record bearing the SAME id;
 * on a hit the mutation is SKIPPED (reported already-applied) rather than
 * re-run. The id namespace is the whole trail — a batch leg and a single op that
 * share an id match each other — so resubmitting an ambiguously-failed write
 * (as a batch line OR a single `--op-id` invocation) is safe against a double.
 */
import type { AuditRecord } from "../audit/schema.ts";
import {
  replayResultFromRecord,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import { readAuditRecords } from "./undo.ts";

/** The idempotency-key charset/length, identical for a batch line and a single-op flag. */
export const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * opId idempotency lookback: at most the last {@link OPID_LOOKBACK_RECORDS}
 * records, AND only the last {@link OPID_LOOKBACK_MS} (whichever is more
 * restrictive). Phase 1 matches VERIFIED-OK records only.
 */
export const OPID_LOOKBACK_RECORDS = 1000;
export const OPID_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The recent-history lookback for an opId: the most recent `ok` record carrying
 * that id, within the last {@link OPID_LOOKBACK_RECORDS} records AND the last
 * {@link OPID_LOOKBACK_MS} (whichever is more restrictive). Undo/intent/blocked
 * records are naturally excluded — only `result === "ok"` matches (phase 1; the
 * verify-failed:timeout reconciliation variant is a queued phase-2 round).
 */
export function findAppliedOpId(
  records: AuditRecord[],
  opId: string,
  now: Date,
): AuditRecord | undefined {
  const cutoff = now.getTime() - OPID_LOOKBACK_MS;
  const window = records.slice(-OPID_LOOKBACK_RECORDS);
  let match: AuditRecord | undefined;
  for (const r of window) {
    if (r.opId !== opId || r.result !== "ok") continue;
    if (new Date(r.ts).getTime() < cutoff) continue;
    match = r; // records are oldest-first, so the last match is the newest
  }
  return match;
}

/**
 * The lookback as a DISPATCH DECISION: the replay result when this write's
 * `opId` was already applied, or null when it must run. The ONE gate every
 * single-invocation entry point calls before doing anything — the client's
 * single-op `run`, and the complete/cancel/exception entries whose composites
 * own their own dispatch (they never reach `run`, so without this the key would
 * be recorded and never honored).
 *
 * Three conditions, all fail-open (run the write) rather than fail-closed:
 * no key, a dry run (it mints and records nothing, so there is nothing to
 * deduplicate against), or no trail to read.
 */
export function replayIfApplied(deps: WriteDeps, options: WriteOptions): MutationResult | null {
  if (options.opId === undefined || options.dryRun === true) return null;
  if (deps.auditDirPath === undefined) return null;
  const applied = findAppliedOpId(
    readAuditRecords(deps.auditDirPath),
    options.opId,
    deps.now?.() ?? new Date(),
  );
  return applied === undefined ? null : replayResultFromRecord(applied);
}
