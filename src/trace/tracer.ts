/**
 * Dev-mode step-timeline trace (TRACE1, #487).
 *
 * When tracing is on — a `-dev` build, or forced via the `traceEnabled` config
 * key / `THINGS_API_TRACE` env — every write invocation appends a step-level
 * timeline to ONE local JSONL file under {@link traceDir}. The file is the
 * single artifact an issue report can point at to reconstruct exactly what the
 * CLI did and when: the sanitized argv, each pipeline stage, every UI-drive
 * osascript dispatch (with duration + outcome), the verify poll summary, the
 * final result, and — critically for a hang report — an interruption marker if
 * a signal killed the process mid-drive.
 *
 * Design goals:
 *   - Overhead ≈ 0 when disabled: {@link trace} is one null-check + return, and
 *     the emit thunk is never invoked.
 *   - Flush-on-write: each event is `appendFileSync`'d immediately, so even a
 *     SIGKILL leaves every event up to the last checkpoint on disk.
 *   - LOCAL-ONLY: a trace may carry real task titles/uuids from the running
 *     database. That is fine on the maintainer's own machine; it must NEVER be
 *     committed to the public repo or attached to a public issue.
 *
 * The sink and the in-flight-write registry are module-global by design: a CLI
 * invocation is exactly one process running exactly one write, so a singleton is
 * both correct and far simpler than threading a tracer through every signature.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.ts";
import { traceDir } from "../paths.ts";

/** One line in the trace: a phase tag plus arbitrary structured fields. */
export interface TraceEvent {
  /**
   * The kind of moment: `invocation` (start), `stage` (a pipeline milestone),
   * `ui-dispatch` (one osascript hop), `verify` (poll summary), `watchdog`,
   * `result`, `signal`, or `invocation-end`.
   */
  phase: string;
  [field: string]: unknown;
}

/** A trace destination. The file sink stamps `ts`/`elapsedMs` onto each event. */
export interface TraceSink {
  /** Absolute path of the trace file (embedded in uncertain-outcome results). */
  readonly path: string;
  /** Epoch ms when this invocation's trace opened (the `elapsedMs` origin). */
  readonly startedAt: number;
  write(event: TraceEvent): void;
  close(): void;
}

let sink: TraceSink | null = null;

/** Install (or clear, with null) the process trace sink. */
export function setTraceSink(next: TraceSink | null): void {
  sink = next;
}

/** The active sink, or null when tracing is off. */
export function traceSink(): TraceSink | null {
  return sink;
}

/** Is tracing on right now? Cheap guard for hot call sites. */
export function traceActive(): boolean {
  return sink !== null;
}

/** The active trace file path, or null — embedded in uncertain-outcome results. */
export function tracePath(): string | null {
  return sink?.path ?? null;
}

/**
 * Emit one event. The event is built by a THUNK so nothing is allocated when
 * tracing is off (overhead ≈ 0 disabled). Never throws — a failed trace write
 * must never break a mutation.
 */
export function trace(makeEvent: () => TraceEvent): void {
  if (sink === null) return;
  try {
    sink.write(makeEvent());
  } catch {
    // tracing is best-effort diagnostics; never let it affect the write
  }
}

// ---------------------------------------------------------------------------
// In-flight-write registry — read by the CLI's signal handler so a SIGTERM/
// SIGINT can name the exact operation (and last UI step) that was interrupted.
// ---------------------------------------------------------------------------

export interface InflightWrite {
  op: string;
  /** The resolved target uuid, when the op has a single one (else null). */
  uuid: string | null;
  vector: string;
  /** True while a GUI drive is in flight — the genuinely-uncertain case. */
  uiDrive: boolean;
  /** The label of the last UI-drive step dispatched (updated as it drives). */
  step?: string;
  startedAt: number;
}

let inflight: InflightWrite | null = null;

/** Mark (or clear, with null) the write currently touching the app. */
export function setInflight(write: InflightWrite | null): void {
  inflight = write;
}

/** The write currently touching the app, or null. */
export function getInflight(): InflightWrite | null {
  return inflight;
}

/** Record the last-dispatched UI-drive step on the in-flight write. */
export function noteInflightStep(step: string): void {
  if (inflight !== null) inflight.step = step;
}

// ---------------------------------------------------------------------------
// Enablement + the file sink.
// ---------------------------------------------------------------------------

/**
 * The effective trace decision. The tri-state config key wins when set
 * (`true`/`false` force it), otherwise tracing follows `isDev` — on for a
 * `-dev` source checkout, off for a published install. The env override is
 * already folded into `configTrace` by {@link loadConfig}.
 */
export function resolveTraceEnabled(
  configTrace: boolean | null | undefined,
  isDev: boolean,
): boolean {
  return configTrace ?? isDev;
}

/** Redact obvious secrets (URL-scheme auth tokens) from a logged argv. */
export function sanitizeArgv(argv: readonly string[]): string[] {
  return argv.map((arg) => arg.replace(/((?:[?&]|\b)(?:auth|token)=)[^&\s]+/gi, "$1<redacted>"));
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Open a per-invocation JSONL trace file and return the sink (already carrying
 * the leading `invocation` event). One file per process keeps concurrent
 * invocations from interleaving, so the file for a given run reconstructs that
 * run and nothing else.
 */
export function createFileTraceSink(opts: {
  dir: string;
  argv: readonly string[];
  version: string;
  pid: number;
  now?: () => number;
}): TraceSink {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  mkdirSync(opts.dir, { recursive: true });
  // Filesystem-safe stamp (colons/dots → dashes) plus the pid, so two runs in
  // the same second never collide.
  const fileStamp = isoStamp(startedAt).replace(/[:.]/g, "-");
  const path = join(opts.dir, `${fileStamp}-${opts.pid}.jsonl`);
  const sinkImpl: TraceSink = {
    path,
    startedAt,
    write(event: TraceEvent): void {
      const line = `${JSON.stringify({ ts: isoStamp(now()), elapsedMs: now() - startedAt, ...event })}\n`;
      appendFileSync(path, line);
    },
    close(): void {
      // JSONL is flushed per line; nothing to finalize.
    },
  };
  sinkImpl.write({
    phase: "invocation",
    argv: sanitizeArgv(opts.argv),
    version: opts.version,
    pid: opts.pid,
    cwd: process.cwd(),
  });
  return sinkImpl;
}

/**
 * CLI entry: decide whether to trace this invocation and, if so, install a file
 * sink. Returns the sink (or null when off). Called from the write driver so
 * tracing is scoped to mutations — the invocations where a step timeline earns
 * its keep. Never throws: a trace-setup failure degrades to no tracing.
 */
export function installCliTrace(opts: {
  argv: readonly string[];
  version: string;
  isDev: boolean;
  env?: NodeJS.ProcessEnv;
  pid?: number;
}): TraceSink | null {
  const env = opts.env ?? process.env;
  try {
    const config = loadConfig(env);
    if (!resolveTraceEnabled(config.traceEnabled, opts.isDev)) return null;
    const created = createFileTraceSink({
      dir: traceDir(env),
      argv: opts.argv,
      version: opts.version,
      pid: opts.pid ?? process.pid,
    });
    setTraceSink(created);
    return created;
  } catch {
    return null;
  }
}

/** Tear down the process trace sink (clears the in-flight marker too). */
export function closeCliTrace(): void {
  inflight = null;
  if (sink !== null) {
    try {
      sink.close();
    } catch {
      // best-effort
    }
    sink = null;
  }
}
