/**
 * `op-result` — a cheap, read-only CALLER-RECOVERY lookup over the local change
 * history (RSPA1 deliverable 3). It answers ONE question: "an op I dispatched with
 * an `--op-id` / `op_id` — what actually happened to it?"
 *
 * The motivating failure: a caller's harness caps command wall-time (~30s), so a
 * long GUI drive (a `--dangerously-drive-gui` reschedule can run its full verify
 * budget) is KILLED before the CLI prints its result — the caller never learns the
 * outcome and is tempted to blind-retry a write that may have landed. Guidance
 * cannot fix a hard harness cap; this can. The write path records every attempt
 * TWICE (an `intent` marker before the app is touched, then the final `ok` /
 * `verify-failed:*` / `blocked:*` / `unsupported` record after read-after-write —
 * see audit/schema.ts), both carrying the caller's `opId`. So after a kill, the
 * caller runs `things op-result <op-id>` in a FRESH short-lived process and reads
 * the final outcome the killed process already durably wrote (fsync per record).
 *
 * Three outcomes:
 *  - FOUND — a final (non-intent) record carries the id: report its result code,
 *    target uuid, and post-verify observation (the standard fields the killed
 *    process would have printed).
 *  - INTENT-ONLY — only an `intent` marker exists: the op is still running, or the
 *    process died between touching the app and writing its final record — the
 *    outcome is UNCERTAIN (the app-side change may have landed). The newest
 *    correlated trace file is surfaced when determinable.
 *  - UNKNOWN — no record carries the id: it never ran, the id is mistyped, or the
 *    record has aged out of the local history.
 *
 * This is a pure history read — it opens no database and drives nothing. Reused by
 * the CLI subcommand and (read-only) the MCP surface through the single library
 * entry point (src/index.ts), like {@link diagnose}.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { AuditRecord } from "./audit/schema.ts";
import { auditDir as defaultAuditDir, traceDir as defaultTraceDir } from "./paths.ts";
import { readAuditRecords } from "./write/undo.ts";

export interface OpResultOptions {
  /** Directory holding the audit JSONL files; defaults to the state dir. Test seam. */
  auditDir?: string;
  /**
   * Directory holding the per-invocation trace files — used to surface the newest
   * correlated trace on an INTENT-ONLY outcome; defaults to the state trace dir.
   * Test seam.
   */
  traceDir?: string;
}

export type OpResultStatus = "found" | "intent-only" | "unknown";

export interface OpResultData {
  opId: string;
  status: OpResultStatus;
  /** The recorded operation kind (e.g. "todo.reschedule-repeat"); null when UNKNOWN. */
  op: string | null;
  /**
   * The FINAL record's result code (`ok` | `verify-failed:*` | `blocked:*` |
   * `unsupported`); null when INTENT-ONLY (no final written) or UNKNOWN.
   */
  result: AuditRecord["result"] | null;
  /** The recorded target uuid (null for an as-yet-undiscovered create, or UNKNOWN). */
  uuid: string | null;
  /** The post-verify observation the final record captured; null when absent. */
  observed: Record<string, unknown> | null;
  /** The verify attempt/elapsed the final record captured; null when absent. */
  verify: { attempts: number; elapsedMs: number } | null;
  /** The record's start timestamp (ISO-8601); null when UNKNOWN. */
  ts: string | null;
  /** The final record's wall-clock duration in ms; null when INTENT-ONLY / UNKNOWN. */
  durationMs: number | null;
  /** The newest correlated trace file path (INTENT-ONLY, best-effort); null otherwise. */
  tracePath: string | null;
  /** A one-line behavioral explanation of the outcome for a human/agent caller. */
  note: string;
}

/** The trace file whose mtime is closest to `targetTs` (within a window), else null. */
function correlatedTrace(traceDir: string, targetTs: string): string | null {
  let files: string[];
  try {
    files = readdirSync(traceDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null; // no trace dir / unreadable → no correlation
  }
  const target = new Date(targetTs).getTime();
  const WINDOW_MS = 5 * 60 * 1000; // a trace more than 5 min from the intent is not "this op"
  let best: { path: string; diff: number } | null = null;
  for (const file of files) {
    const path = join(traceDir, file);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const diff = Math.abs(mtimeMs - target);
    if (diff <= WINDOW_MS && (best === null || diff < best.diff)) best = { path, diff };
  }
  return best?.path ?? null;
}

/** The behavioral note for a FOUND final record's result code. */
function foundNote(result: AuditRecord["result"], uuid: string | null): string {
  const target = uuid ?? "<uuid>";
  switch (result) {
    case "ok":
      return "the operation completed and read-after-write verification passed — the change landed";
    case "verify-failed:timeout":
      return (
        "the operation ran but read-after-write verification TIMED OUT — the change may or may not " +
        `have landed. Re-read the target (\`things show ${target}\`) and the trace before doing ` +
        "anything else; NEVER blind-retry a GUI drive"
      );
    case "verify-failed:mismatch":
      return (
        "the operation ran but landed in the WRONG state (verification mismatch) — re-read the " +
        `target (\`things show ${target}\`) to see what committed before retrying`
      );
    case "verify-failed:silent-noop":
      return (
        "the operation ran but the app did not move (silent no-op) — the change did NOT land; it is " +
        "safe to retry once you understand why it was rejected (re-read the target and the trace)"
      );
    case "unsupported":
      return "the operation is not supported by any available write vector — nothing changed";
    default:
      // blocked:<suffix> — a refusal before the app was touched.
      return result.startsWith("blocked:")
        ? `the operation was REFUSED before touching the app (${result}) — nothing changed`
        : `the operation finished with result ${result}`;
  }
}

/**
 * Look up the FINAL outcome of a dispatched op by its caller-supplied `opId`, from
 * the local change history alone (no database, no app). See the module header for
 * the three outcomes.
 */
export function opResult(opId: string, options: OpResultOptions = {}): OpResultData {
  const auditDir = options.auditDir ?? defaultAuditDir();
  const traceDir = options.traceDir ?? defaultTraceDir();
  const records = readAuditRecords(auditDir);
  // records are oldest-first; keep only those carrying this id.
  const matched = records.filter((r) => r.opId === opId);

  if (matched.length === 0) {
    return {
      opId,
      status: "unknown",
      op: null,
      result: null,
      uuid: null,
      observed: null,
      verify: null,
      ts: null,
      durationMs: null,
      tracePath: null,
      note:
        `no change-history record carries op-id "${opId}" — it never ran, the id is mistyped, or ` +
        "the record has aged out of the local history (`things doctor` shows the history health)",
    };
  }

  // A final (non-intent) record supersedes the intent marker. Take the NEWEST one
  // (an ambiguously-failed op can be re-dispatched under the same id, yielding
  // several finals — the last is the current truth).
  const finals = matched.filter((r) => r.result !== "intent");
  if (finals.length > 0) {
    const rec = finals[finals.length - 1] as AuditRecord;
    return {
      opId,
      status: "found",
      op: rec.op,
      result: rec.result,
      uuid: rec.uuid,
      observed: rec.observed,
      verify: rec.verify,
      ts: rec.ts,
      durationMs: rec.durationMs,
      tracePath: null,
      note: foundNote(rec.result, rec.uuid),
    };
  }

  // Only intent marker(s): still running, or the process died mid-flight.
  const rec = matched[matched.length - 1] as AuditRecord;
  const tracePath = correlatedTrace(traceDir, rec.ts);
  return {
    opId,
    status: "intent-only",
    op: rec.op,
    result: null,
    uuid: rec.uuid,
    observed: null,
    verify: null,
    ts: rec.ts,
    durationMs: null,
    tracePath,
    note:
      "the operation was recorded as STARTED but no final outcome was written — it is still " +
      "running, or the process died mid-flight (its GUI-side change may have landed). The outcome " +
      "is UNCERTAIN: re-read the target and inspect the trace" +
      (tracePath !== null ? ` (${tracePath})` : "") +
      " rather than blind-retrying",
  };
}
