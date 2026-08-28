/**
 * `things rescue` — the emergency surface for a Things that is up, answering,
 * and unusable (issue #640). Thin surface over the library's rescueStatus() /
 * rescueDismiss() / rescueRelaunch().
 *
 * Exit codes carry the shape a script needs: `status` is always 0 (a wedged
 * machine is a reported state, not a command failure); an action that refused
 * before touching anything exits 4; an action that acted and could not finish
 * exits 3.
 */
import type { Command } from "commander";

import {
  ExitCode,
  okEnvelope,
  rescueDismiss,
  rescueDismissLines,
  rescueRelaunch,
  rescueRelaunchLines,
  rescueStatus,
  rescueStatusLines,
  type EnvelopeMeta,
} from "../../index.ts";

function meta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

function emit(
  json: boolean | undefined,
  kind: string,
  data: unknown,
  lines: string[],
  started: number,
): void {
  if (json === true) {
    process.stdout.write(`${JSON.stringify(okEnvelope(kind, data, meta(started)))}\n`);
  } else {
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}

export function registerRescue(program: Command): void {
  const rescue = program
    .command("rescue")
    .description(
      "Get an unresponsive Things moving again. A dialog left open in Things stops the app " +
        "sending changes to Things Cloud and makes it answer that items you can plainly see are " +
        "not there — so commands fail in ways that look like missing data. Subcommands: status, " +
        "dismiss, relaunch.",
    );

  rescue
    .command("status")
    .description(
      "Report what is stuck: whether a dialog is open in Things and which one, how many are " +
        "stacked, which application owns the keyboard, and whether another command is holding the " +
        "change lock (and for how long). Reads only — nothing is clicked, closed or quit. Names " +
        "the owning application when a dialog belongs to macOS rather than to Things, since " +
        "nothing here may touch one of those. Always exit 0.",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action(async (opts: { json?: boolean }) => {
      const started = Date.now();
      const report = await rescueStatus();
      emit(opts.json, "rescue-status", report, rescueStatusLines(report), started);
      process.exitCode = ExitCode.Ok;
    });

  rescue
    .command("dismiss")
    .description(
      "Close the dialog in front by pressing its own Cancel button, discarding whatever was " +
        "typed into it — the database is not touched. Closes exactly one: dialogs stack, they " +
        "close one at a time, and the result says how many are left. Refuses without pressing " +
        "anything when the dialog is one it cannot identify, when it belongs to macOS rather " +
        "than to Things, or when the screen cannot be read. Reports honestly when the dialog " +
        "ignores its own Cancel, which some do.",
    )
    .option(
      "--dangerously-dismiss-dialog",
      "required: closes the open dialog and discards anything typed into it; also needs " +
        "`things config set ui-enabled true`",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action(async (opts: { dangerouslyDismissDialog?: boolean; json?: boolean }) => {
      const started = Date.now();
      const result = await rescueDismiss({
        dangerouslyDismissDialog: opts.dangerouslyDismissDialog === true,
      });
      emit(opts.json, "rescue-dismiss", result, rescueDismissLines(result), started);
      process.exitCode =
        result.outcome === "dismissed" || result.outcome === "no-dialog"
          ? ExitCode.Ok
          : result.outcome === "refused"
            ? ExitCode.Blocked
            : ExitCode.VerifyFailed;
    });

  rescue
    .command("relaunch")
    .description(
      "Quit Things and start it again in the background. Everything already saved survives; " +
        "anything typed into an open dialog and not saved is lost. Use it when a dialog will not " +
        "close: this is the only thing known to clear one of those, and it also releases the " +
        "changes Things has been holding back from Things Cloud. On a machine set up as a " +
        "workstation it needs a second flag, since someone may be sitting in front of the dialog.",
    )
    .option("--yes", "required: quit Things and start it again")
    .option(
      "--dangerously-force-quit",
      "also required on a workstation: quit Things even though someone may be using it",
    )
    .option("--json", "emit versioned JSON envelope on stdout")
    .action(async (opts: { yes?: boolean; dangerouslyForceQuit?: boolean; json?: boolean }) => {
      const started = Date.now();
      const result = await rescueRelaunch({
        yes: opts.yes === true,
        dangerouslyForceQuit: opts.dangerouslyForceQuit === true,
      });
      emit(opts.json, "rescue-relaunch", result, rescueRelaunchLines(result), started);
      process.exitCode =
        result.outcome === "relaunched"
          ? ExitCode.Ok
          : result.outcome === "refused"
            ? ExitCode.Blocked
            : ExitCode.VerifyFailed;
    });
}
