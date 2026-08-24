/**
 * Apple Shortcuts vector — drives the six golden-resident `things-proxy-*`
 * shortcuts (docs/lab/s-campaign-results.md). It fills the last gaps left by
 * the URL scheme and AppleScript: creating a heading inside an existing
 * project (impossible on every other surface), and clearing a DATED reminder
 * in place (the URL bounce and AppleScript de-schedule also clear it, but only
 * by mutating the schedule — see docs/lab/rc-suite-results.md). Each run pipes
 * a JSON dict to `shortcuts run <name>` via a per-run temp file and reads the
 * shortcut's output back from another.
 *
 * Consent: the create/edit/set proxies are output-class ("Allow … to output
 * N items") and offer Always-Allow, so they run headless after one grant. A
 * run that HANGS against the deadline is the shape of an unanswered first-run
 * consent dialog (classified as consent-needed by failure-hints).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shortcutsRunExec } from "../../deputy/shortcuts-exec.ts";
import type { CompiledInvocation, ExecuteResult, VectorMatrix, WriteVector } from "./types.ts";

/** First-run consent can stall the run; give it generous headroom. */
const SHORTCUTS_TIMEOUT_MS = 25_000;

export const SHORTCUTS_MATRIX: VectorMatrix = {
  "project.add-heading": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["S02"],
    notes:
      "`things-proxy-create-heading` — the one surface that creates a heading in an " +
      "EXISTING project (dead on URL T09/U09 and AppleScript A31). Requires the Things " +
      "proxy shortcuts (`things setup`); no transactional undo (heading delete " +
      "is interactive-only, so undo reports irreversible)",
  },
  "todo.clear-dated-reminder": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["scf:P3b"],
    notes:
      '`things-proxy-set-detail` Reminder Time = "" — the only IN-PLACE / schedule-preserving ' +
      "clear of a DATED reminder (startDate untouched, headless), and the ONLY path for a " +
      "repeating template. The `todo.clear-dated-reminder` orchestrator auto-prefers this when " +
      "the proxy is installed and falls back to a pure-URL `when=today`->re-date BOUNCE " +
      "(RC01/RC02) for NON-REPEATING items when it is not (the bounce when= CRASHES a repeating " +
      "template, R09 — repeating stays Shortcuts-only). The clear is REVERSIBLE either way: undo " +
      "re-attaches the reminder via the URL set path (R17/R18). Same-date bare `when=` is sticky " +
      "(R20/R21, oddity 2e). Requires the Things proxy shortcuts (`things setup`)",
  },
};

/**
 * Low-level `shortcuts run` seam. Injectable so the executor's temp-file
 * orchestration is unit-testable WITHOUT ever running a mutating proxy (the
 * production DB is never a valid target — see CLAUDE.md safety rails).
 */
export type ShortcutsRunner = (
  shortcut: string,
  inputPath: string,
  outputPath: string,
) => Promise<ExecuteResult>;

function defaultRun(
  shortcut: string,
  inputPath: string,
  outputPath: string,
): Promise<ExecuteResult> {
  // Deputy-routed when active (src/deputy/shortcuts-exec.ts) so the Shortcuts
  // surface shares the deputy's stable identity; direct otherwise. The
  // deadline-kill consent signature (timedOut) survives both paths.
  return shortcutsRunExec(shortcut, inputPath, outputPath, SHORTCUTS_TIMEOUT_MS);
}

export function createShortcutsVector(run: ShortcutsRunner = defaultRun): WriteVector {
  return {
    id: "shortcuts",
    matrix: SHORTCUTS_MATRIX,
    async execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      const dir = mkdtempSync(join(tmpdir(), "things-api-shortcut-"));
      const inputPath = join(dir, "input.json");
      const outputPath = join(dir, "output.json");
      try {
        writeFileSync(inputPath, JSON.stringify(invocation.input ?? {}), "utf8");
        const result = await run(invocation.shortcut ?? "", inputPath, outputPath);
        // The proxy writes its result to --output-path; prefer it over stdout.
        let stdout = result.stdout;
        try {
          stdout = readFileSync(outputPath, "utf8");
        } catch {
          // No output file (e.g. an empty result) — keep the process stdout.
        }
        return { ...result, stdout };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
