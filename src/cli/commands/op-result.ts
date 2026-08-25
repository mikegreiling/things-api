/**
 * `things op-result <op-id>` — a read-only CALLER-RECOVERY lookup over the local
 * change history (RSPA1 deliverable 3). Thin surface over the library's opResult().
 *
 * When your environment kills long commands (a wall-time cap) before a write's
 * result is printed — a `--dangerously-drive-gui` drive can run its full verify
 * budget — dispatch the op with `--op-id <key>`, let it die, then run this in a
 * fresh process to learn what ACTUALLY happened from the record the killed process
 * already durably wrote. NEVER blind-retry a GUI drive.
 *
 * Always exit 0: this is a successful HISTORY READ regardless of the underlying
 * op's outcome (which lives in `data.status` / `data.result`).
 */
import type { Command } from "commander";

import { okEnvelope, opResult, type EnvelopeMeta } from "../../index.ts";

export function registerOpResult(program: Command): void {
  program
    .command("op-result")
    .argument("<op-id>", "the --op-id / op_id the original write carried")
    .description(
      "Look up what happened to a write you dispatched with --op-id, from the local change " +
        "history alone (opens no database, drives nothing). Use it to recover the outcome when " +
        "your environment killed the command before it printed its result: let the command die, " +
        "then run this. Reports FOUND (the final result + target + observation), INTENT-ONLY (the " +
        "op started but no outcome was written — still running or the process died mid-flight, " +
        "outcome UNCERTAIN), or UNKNOWN (no such op-id in history). Always exit 0 (a history read).",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opId: string, opts: { json?: boolean }) => {
      const started = Date.now();
      const data = opResult(opId);
      const meta: EnvelopeMeta = {
        dbVersion: null,
        fingerprint: "unknown",
        elapsedMs: Date.now() - started,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(okEnvelope("op-result", data, meta))}\n`);
      } else {
        const head =
          data.status === "found"
            ? `${data.result} — ${data.op}${data.uuid !== null ? ` (${data.uuid})` : ""}`
            : data.status === "intent-only"
              ? `intent-only — ${data.op} (no final outcome recorded)`
              : "unknown op-id";
        process.stdout.write(`op-result ${opId}: ${head}\n`);
        process.stdout.write(`  ${data.note}\n`);
        if (data.occurrence !== undefined) {
          const o = data.occurrence;
          process.stdout.write(
            `  occurrence: ${o.occurrenceUuid}${o.date === null ? "" : ` dated ${o.date}`} ` +
              `(${o.minted ? "created for that call" : "already open"}) of repeating to-do ` +
              `${o.templateUuid}\n`,
          );
        }
        if (data.status === "found" && data.observed !== null) {
          process.stdout.write(`  observed: ${JSON.stringify(data.observed)}\n`);
        }
      }
      process.exitCode = 0;
    });
}
