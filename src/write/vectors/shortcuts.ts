/**
 * Apple Shortcuts vector — drives the six golden-resident `things-proxy-*`
 * shortcuts (docs/lab/s-campaign-results.md). It fills the last gaps left by
 * the URL scheme and AppleScript: creating a heading inside an existing
 * project, and clearing a DATED reminder (both impossible on every other
 * surface). Each run pipes a JSON dict to `shortcuts run <name>` via a
 * per-run temp file and reads the shortcut's output back from another.
 *
 * Consent: the create/edit/set proxies are output-class ("Allow … to output
 * N items") and offer Always-Allow, so they run headless after one grant. A
 * run that HANGS against the deadline is the shape of an unanswered first-run
 * consent dialog (classified as consent-needed by failure-hints).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompiledInvocation, ExecuteResult, VectorMatrix, WriteVector } from "./types.ts";

/** First-run consent can stall the run; give it generous headroom. */
const SHORTCUTS_TIMEOUT_MS = 25_000;

export const SHORTCUTS_MATRIX: VectorMatrix = {
  "heading.create": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["S02"],
    notes:
      "`things-proxy-create-heading` — the one surface that creates a heading in an " +
      "EXISTING project (dead on URL T09/U09 and AppleScript A31). Requires the Things " +
      "proxy shortcuts (`things setup shortcuts`); no transactional undo (heading delete " +
      "is interactive-only, so undo reports irreversible)",
  },
  "todo.clear-dated-reminder": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["scf:P3b"],
    notes:
      '`things-proxy-set-detail` Reminder Time = "" — the ONLY surface that clears a ' +
      "DATED reminder (sticky on URL, R20/R21, oddity 2e); startDate untouched. Requires " +
      "the Things proxy shortcuts (`things setup shortcuts`)",
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
  return new Promise((resolve) => {
    execFile(
      "shortcuts",
      ["run", shortcut, "--input-path", inputPath, "--output-path", outputPath],
      { timeout: SHORTCUTS_TIMEOUT_MS },
      (err, stdout, stderr) => {
        // A deadline kill (err.killed) is the signature of an unanswered
        // first-run consent dialog — surfaced distinctly for attribution.
        const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
        resolve({
          exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1),
          stdout: String(stdout),
          stderr: String(stderr),
          ...(timedOut && { timedOut: true }),
        });
      },
    );
  });
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
