/**
 * `things setup shortcuts` — install the bundled Apple Shortcuts that unlock
 * the few operations available on no other surface. The signed .shortcut
 * files ship with the package (shortcuts/); installing one is an explicit
 * user action (Apple offers no silent import), so this command opens each
 * missing shortcut's install sheet and the user clicks "Add Shortcut".
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

import {
  ExitCode,
  okEnvelope,
  shortcutProxies,
  simFenceActive,
  type EnvelopeMeta,
  type ShortcutsState,
} from "../../index.ts";

/** Package root — one level above src/ AND dist/, so both layouts resolve. */
const SHORTCUTS_DIR = fileURLToPath(new URL("../../../shortcuts", import.meta.url));

interface SetupShortcutsData {
  installed: string[];
  missing: string[];
  opened: string[];
  detail: string;
}

function meta(started: number): EnvelopeMeta {
  return { dbVersion: null, fingerprint: "unknown", elapsedMs: Date.now() - started };
}

function renderState(state: ShortcutsState, opened: string[]): string[] {
  const lines = [
    `installed: ${state.present.length ? state.present.join(", ") : "(none)"}`,
    `missing:   ${state.missing.length ? state.missing.join(", ") : "(none)"}`,
  ];
  if (opened.length > 0) {
    lines.push(
      "",
      `Opened ${opened.length} install sheet${opened.length === 1 ? "" : "s"} in the Shortcuts app.`,
      "For each sheet: click “Add Shortcut”. The first time each shortcut runs, macOS",
      "asks for permission — choose “Always Allow” so later runs need no clicks",
      "(the two delete shortcuts re-ask on every run; Apple offers no always-allow there).",
      "",
      "Then verify with: things setup shortcuts --check",
    );
  } else if (state.missing.length === 0) {
    lines.push("", "All shortcuts are installed.");
  }
  return lines;
}

export function registerSetup(program: Command): void {
  const setup = program
    .command("setup")
    .description("One-time environment setup helpers (see also: things doctor)");
  setup
    .command("shortcuts")
    .description(
      "Install the bundled Apple Shortcuts that enable the operations nothing else can " +
        "perform: creating a heading in an existing project, clearing a reminder from a " +
        "date-scheduled item, and permanently deleting a single item. Opens an install " +
        "sheet in the Shortcuts app for each missing shortcut (click “Add Shortcut” on " +
        "each, then choose “Always Allow” on each one's first run). Exit 0 when all are " +
        "installed or sheets were opened; 7 when the Shortcuts tool or the bundled files " +
        "are unavailable.",
    )
    .option("--check", "report which shortcuts are installed without opening anything")
    .option("--json", "emit versioned JSON envelope on stdout")
    .action((opts: { check?: boolean; json?: boolean }) => {
      const started = Date.now();
      const state = shortcutProxies();
      const opened: string[] = [];
      let exitCode: number = ExitCode.Ok;
      let detail = state.detail;

      if (opts.check !== true && state.missing.length > 0 && simFenceActive()) {
        // Under the simulator fence: report the install sheets as simulated
        // rather than opening them, so a bench run never touches the host app.
        detail = "simulated: install sheets were not opened (the Shortcuts app was not touched)";
      } else if (opts.check !== true && state.missing.length > 0) {
        for (const name of state.missing) {
          const file = join(SHORTCUTS_DIR, `${name}.shortcut`);
          if (!existsSync(file)) {
            detail = `bundled shortcut file not found: ${file}`;
            exitCode = ExitCode.Environment;
            continue;
          }
          try {
            execFileSync("open", [file], { timeout: 10000 });
            opened.push(name);
          } catch {
            detail = `could not open ${file} — open it manually to install`;
            exitCode = ExitCode.Environment;
          }
        }
      } else if (opts.check === true && state.missing.length > 0) {
        exitCode = ExitCode.Environment;
      }

      const data: SetupShortcutsData = {
        installed: state.present,
        missing: state.missing,
        opened,
        detail,
      };
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify(okEnvelope("setup-shortcuts", data, meta(started)))}\n`,
        );
      } else {
        process.stdout.write(`${renderState(state, opened).join("\n")}\n`);
        if (detail !== state.detail) process.stderr.write(`setup: ${detail}\n`);
      }
      process.exitCode = exitCode;
    });
}
