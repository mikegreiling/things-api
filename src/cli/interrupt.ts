/**
 * Signal-safe final words (TRACE1, #487).
 *
 * Without this, a caller's timeout kill (SIGTERM/SIGINT) mid-drive left the
 * CLI's stdout EMPTY with no retained exit code — the exact #487 report. These
 * handlers, on a signal:
 *   (a) flush a final `signal` trace entry marking the interruption point, and
 *   (b) best-effort emit a STRUCTURED result distinguishing an interrupted write
 *       (outcome UNCERTAIN — the in-flight UI step may still complete) from a
 *       confirmed one, so an agent caller learns it must re-check rather than
 *       assume nothing changed.
 *
 * SIGKILL cannot be caught: it leaves only the trace's last checkpoint (the file
 * is flushed per line). That is documented for callers in the skill/CLI copy.
 *
 * The handler consults the library's in-flight-write marker ({@link getInflight})
 * — set by the pipeline only while a write is actually touching the app — so a
 * signal received during a read, or after the write already returned, emits
 * nothing and simply exits.
 */
import { errorEnvelope, getInflight, trace, tracePath, type InflightWrite } from "../index.ts";

/** Whether the current invocation is a `--json` write (so the interrupt result is machine-readable). */
let armed: { json: boolean } | null = null;

/** Arm the guard for a write invocation (call at the top of the write driver). */
export function armInterrupt(json: boolean): void {
  armed = { json };
}

/** Disarm once the write driver has returned (its `finally`). */
export function disarmInterrupt(): void {
  armed = null;
}

let installed = false;

/**
 * Install the SIGTERM/SIGINT handlers ONCE per process. Idempotent — safe to
 * call from `runCli` before dispatch. Exits with the conventional 128 + signum
 * code after emitting.
 */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  process.once("SIGTERM", () => handle("SIGTERM"));
  process.once("SIGINT", () => handle("SIGINT"));
}

/** The honest interrupt message: names the signal, op, last step, and re-check. */
export function interruptMessage(signal: string, inflight: InflightWrite): string {
  const uuid = inflight.uuid ?? "<uuid>";
  const where = inflight.uiDrive ? "driving the Things UI" : "writing";
  const at = inflight.step !== undefined ? `, at "${inflight.step}"` : "";
  return (
    `interrupted by ${signal} while ${where} (${inflight.op}${at}) — OUTCOME UNCERTAIN: the ` +
    `in-flight step may still complete on its own, so re-check with \`things show ${uuid}\` ` +
    "before retrying (retrying could duplicate the change)"
  );
}

/**
 * The structured interrupt result (testable, no process teardown). Returns the
 * `--json` error envelope when `json`, else a stderr line — or null when no
 * write was in flight (a signal during a read emits nothing).
 */
export function interruptReport(
  signal: string,
  inflight: InflightWrite | null,
  path: string | null,
  json: boolean,
): { stream: "stdout" | "stderr"; text: string } | null {
  if (inflight === null) return null;
  const message = interruptMessage(signal, inflight);
  if (!json) return { stream: "stderr", text: `\nthings: ${message}\n` };
  const uuid = inflight.uuid ?? "<uuid>";
  const envelope = errorEnvelope(
    {
      code: "interrupted",
      message,
      detail: {
        signal,
        op: inflight.op,
        uuid: inflight.uuid,
        outcome: "uncertain",
        recheck: `things show ${uuid}`,
        ...(inflight.step !== undefined && { step: inflight.step }),
        ...(path !== null && { tracePath: path }),
      },
    },
    { dbVersion: null, fingerprint: "unknown", elapsedMs: 0 },
  );
  return { stream: "stdout", text: `${JSON.stringify(envelope)}\n` };
}

function handle(signal: "SIGTERM" | "SIGINT"): void {
  const inflight = getInflight();
  // (a) Mark the interruption point in the trace (flushed synchronously).
  trace(() => ({
    phase: "signal",
    signal,
    ...(inflight !== null && { inflight }),
  }));
  // (b) Emit a structured, honest result — only when a write was actually in
  //     flight (a read or an already-finished write emits nothing).
  const report = interruptReport(signal, inflight, tracePath(), armed?.json === true);
  if (report !== null) {
    try {
      (report.stream === "stdout" ? process.stdout : process.stderr).write(report.text);
    } catch {
      // The process is terminating; a failed final write changes nothing.
    }
  }
  // Conventional signal exit status (128 + signum): SIGINT 2, SIGTERM 15.
  // Distinct from ExitCode.* so a caller can tell a signal death from a clean
  // structured failure — though a caller that killed us may never read it.
  process.exit(signal === "SIGINT" ? 128 + 2 : 128 + 15);
}
