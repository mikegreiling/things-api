/**
 * `things ui-state` — a read-only look at what is on the screen: whether a
 * dialog is open in Things, which dialog it is, whether Things is frontmost,
 * and which application owns the keyboard. Thin surface over the library's
 * readUiStateReport().
 *
 * Nothing is clicked, typed, activated or dismissed. Always exit 0: an
 * unreadable screen is a reported state, not a command failure.
 */
import type { Command } from "commander";

import { okEnvelope, readUiStateReport, uiStateLines, type EnvelopeMeta } from "../../index.ts";

export function registerUiState(program: Command): void {
  program
    .command("ui-state")
    .description(
      "Report what is on the screen right now: whether a dialog is open in Things and which one, " +
        "whether Things is the frontmost app, and which application owns the keyboard. Reads " +
        "only — nothing is clicked, typed or dismissed. Says so plainly when a system dialog is " +
        "covering the screen, since macOS does not let any app inspect one. Always exit 0.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action(async (opts: { json?: boolean }) => {
      const started = Date.now();
      const report = await readUiStateReport();
      const meta: EnvelopeMeta = {
        dbVersion: null,
        fingerprint: "unknown",
        elapsedMs: Date.now() - started,
      };
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(okEnvelope("ui-state", report, meta))}\n`);
      } else {
        process.stdout.write(`${uiStateLines(report).join("\n")}\n`);
      }
      process.exitCode = 0;
    });
}
