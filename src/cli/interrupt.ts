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
 *
 * ## Why the listeners are SCOPED, not installed at startup
 *
 * A registered JS listener replaces the kernel's default disposition with a
 * libuv watcher that can only run its handler ON the event loop. A span that
 * never yields — the whole synchronous read path, whose `open(2)` on the Things
 * container can block indefinitely behind a TCC dialog — therefore SWALLOWS the
 * signal entirely: queued, never dispatched, and the EINTR'd syscall restarted.
 * Measured 2026-08-24: the clean-host probes needed SIGKILL to reap an ordinary
 * command. The ceremonies answered the same hazard from the other side with
 * {@link withDefaultInterrupts} (#567), which lifts the listeners for their
 * blocking span.
 *
 * So the listeners are armed exactly where they can be honored AND have
 * something to say: the CLI write drivers, whose osascript dispatch is async
 * (`osaExec` — "never blocks the event loop"), and the MCP server, which is
 * event-loop-resident for its whole life. Everywhere else the process keeps the
 * kernel's default disposition, and a `timeout`'s SIGTERM kills it — which is
 * the CORRECT outcome for a read: there is nothing to report (the report builder
 * returns null with no write in flight) and nothing to unwind.
 *
 * ## The write path arms PAST the client open (residual closed, 2026-08-25)
 *
 * A write driver used to arm from its top, which put the synchronous
 * `openThings` — the read gate's `open(2)` on the container, the same call that
 * can block — INSIDE the armed span: a write stalled there swallowed SIGTERM
 * where a read no longer did (measured exit 137 after 10 s against a FIFO
 * standing in for the TCC-held open). {@link armInterrupt} is now called once
 * `openThings` has RETURNED — the single seam is `beginWriteInvocation`'s
 * `openClient` in `commands/writes.ts`, which every driver goes through — so
 * that same repro dies to the caller's own TERM (124 after 5 s).
 *
 * The cost is the pre-write window's `signal` trace entry, ruled EXPENDABLE: it
 * is a dev-build diagnostic in the one window where the guard is armed but has
 * nothing to report anyway (no client, so nothing can be in flight, so
 * {@link interruptReport} returns null). Killability wins.
 */
import { errorEnvelope, getInflight, trace, tracePath, type InflightWrite } from "../index.ts";

/** The signals whose default disposition an armed span replaces. */
const SIGNALS = ["SIGTERM", "SIGINT"] as const;

/** Whether the current invocation is a `--json` write (so the interrupt result is machine-readable). */
let armed: { json: boolean } | null = null;

/** The listeners currently registered, so disarming removes exactly those. */
let listeners: { signal: (typeof SIGNALS)[number]; fn: () => void }[] = [];

function install(): void {
  if (listeners.length > 0) return;
  listeners = SIGNALS.map((signal) => {
    const fn = (): void => handle(signal);
    process.on(signal, fn);
    return { signal, fn };
  });
}

function uninstall(): void {
  for (const { signal, fn } of listeners) process.removeListener(signal, fn);
  listeners = [];
}

/**
 * Arm the guard for a write invocation — call it once the client open has
 * RETURNED, never before (that open can block, and a listener across a blocking
 * span swallows the signal instead of honoring it; see the module note).
 * Registers the handlers for the span of the write and records whether its
 * stdout is machine-readable. Idempotent within a span.
 */
export function armInterrupt(json: boolean): void {
  armed = { json };
  install();
}

/**
 * Disarm once the write driver has returned (its `finally`): the handlers come
 * OFF, so the rest of the invocation — rendering, teardown, and any synchronous
 * read that follows — dies to a signal under the kernel's default disposition
 * rather than queueing it behind a blocked event loop.
 */
export function disarmInterrupt(): void {
  armed = null;
  uninstall();
}

/**
 * Install the handlers for the LIFETIME of a long-running server (`things mcp`).
 * Legitimate only there: an event-loop-resident process can always dispatch, and
 * a supervisor's SIGTERM mid-write still gets the honest stderr line. Never call
 * this from a one-shot command path — see the module note.
 */
export function installServerSignalHandlers(): void {
  install();
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
  // Once-semantics AND default disposition restored: a second signal arriving
  // while this handler runs kills the process outright instead of re-entering.
  uninstall();
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
