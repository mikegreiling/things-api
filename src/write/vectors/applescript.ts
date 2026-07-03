/**
 * AppleScript vector — lab-validated 2026-07-03 (a-suite). Fills the URL
 * scheme's gaps: area/tag lifecycle, delete-to-trash, permanent deletes.
 * Tier 0 for every operation WITH THINGS RUNNING; an AppleEvent to a closed
 * Things launches it with focus steal (A40/A41), which the pipeline's
 * ensure-running step prevents.
 */
import { execFile } from "node:child_process";

import type { CompiledInvocation, ExecuteResult, VectorMatrix, WriteVector } from "./types.ts";

export const APPLESCRIPT_MATRIX: VectorMatrix = {
  "todo.add": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A01", "A01B", "A06"],
  },
  "todo.update": {
    support: "partial",
    disruption: 0,
    validation: "validated",
    evidence: ["A20", "A21B"],
    notes: "title/notes setters + schedule; no checklist access (A30)",
  },
  "todo.complete": { support: "yes", disruption: 0, validation: "validated", evidence: ["A23"] },
  "todo.cancel": { support: "yes", disruption: 0, validation: "validated", evidence: ["A23"] },
  "todo.reopen": { support: "yes", disruption: 0, validation: "validated", evidence: ["A23B"] },
  "todo.move": {
    support: "partial",
    disruption: 0,
    validation: "validated",
    evidence: ["A22", "A22B", "A22C"],
    notes:
      "list moves + project/area property setters; cannot target Upcoming (schedule instead); no heading placement",
  },
  "todo.set-tags": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A26"],
    notes: "`set tag names` — same full-replacement semantics as the URL vector",
  },
  "todo.replace-checklist": {
    support: "no",
    disruption: 0,
    validation: "validated",
    evidence: ["A30"],
  },
  "todo.delete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A24", "X04"],
    notes: "moves to Trash (trashed=1); links intact; restorable",
  },
  "project.add": { support: "yes", disruption: 0, validation: "validated", evidence: ["A02"] },
  "project.update": {
    support: "partial",
    disruption: 0,
    validation: "assumed",
    notes: "property setters exist; URL path is the validated one",
  },
  "project.complete": {
    support: "partial",
    disruption: 0,
    validation: "assumed",
    notes: "status setter exists; child-cascade semantics validated on the URL path only",
  },
  "project.delete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A24B"],
    notes: "SHALLOW: only the project row is trashed; children keep links (derived membership)",
  },
  "area.add": { support: "yes", disruption: 0, validation: "validated", evidence: ["A03"] },
  "area.delete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A25", "A25B"],
    notes: "PERMANENT — the area row is hard-deleted; contained to-dos land in Trash",
  },
  "tag.add": { support: "yes", disruption: 0, validation: "validated", evidence: ["A04", "A05"] },
  "tag.delete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A26"],
    notes: "PERMANENT — assignments cascade",
  },
  "trash.empty": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A27"],
    notes: "PERMANENT — hard-deletes every trashed row",
  },
};

/** Escape a string literal for embedding in AppleScript source. */
export function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function runOsascript(script: string): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({
        exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1),
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

export function createAppleScriptVector(): WriteVector {
  return {
    id: "applescript",
    matrix: APPLESCRIPT_MATRIX,
    execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      return runOsascript(invocation.payload);
    },
  };
}
