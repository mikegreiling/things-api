/**
 * things:/// URL-scheme vector. Executes via `open -g` (background-open):
 * the entire validated operation set ran at tier 0 against a running app
 * (u-suite, 2026-07-03). Auth token is read from the local DB by the
 * pipeline and injected at compile time; it never appears in output.
 */
import { execFile } from "node:child_process";

import type { CompiledInvocation, ExecuteResult, VectorMatrix, WriteVector } from "./types.ts";

export const URL_SCHEME_MATRIX: VectorMatrix = {
  "todo.add": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U03", "U04", "U07", "U09"],
    notes: "unknown tags silently ignored by the app — H-UNKNOWN-TAG guards pre-write",
  },
  "todo.update": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U04", "U13", "U12B"],
    notes: "when= on a repeating template CRASHES Things (U12) — H-REPEAT-SCHEDULE hard-blocks",
  },
  "todo.complete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U08", "U20"],
  },
  "todo.cancel": { support: "yes", disruption: 0, validation: "validated", evidence: ["U08"] },
  "todo.reopen": {
    support: "yes",
    disruption: 0,
    validation: "assumed",
    notes: "completed=false documented; AppleScript path is the validated one (A23B)",
  },
  "todo.move": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U06", "U06B"],
    notes: "unknown destinations are silent no-ops — H-UNKNOWN-DESTINATION guards pre-write",
  },
  "todo.set-tags": { support: "yes", disruption: 0, validation: "validated", evidence: ["U04"] },
  "todo.replace-checklist": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U07", "U20"],
    notes: "wholesale replacement — destroys per-item state (H-CHECKLIST-REPLACE)",
  },
  "todo.delete": { support: "no", disruption: 3, validation: "validated", evidence: ["U14"] },
  "project.add": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U08", "U19"],
  },
  "project.update": { support: "yes", disruption: 0, validation: "validated", evidence: ["U08"] },
  "project.complete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U08"],
    notes: "auto-completes open children with no prompt — children policy is mandatory",
  },
  "project.delete": { support: "no", disruption: 3, validation: "validated", evidence: ["U14"] },
  "area.add": { support: "no", disruption: 3, validation: "validated", evidence: ["U05"] },
  "area.delete": {
    support: "no",
    disruption: 3,
    validation: "validated",
    evidence: ["U05", "U14"],
  },
  "tag.add": {
    support: "no",
    disruption: 0,
    validation: "validated",
    evidence: ["U03"],
    notes: "unknown tags silently ignored; no tag-creation command exists",
  },
  "tag.delete": { support: "no", disruption: 0, validation: "validated" },
  "trash.empty": { support: "no", disruption: 0, validation: "validated" },
};

function openUrl(url: string): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    execFile("open", ["-g", url], { timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({
        exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1),
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

export function createUrlSchemeVector(): WriteVector {
  return {
    id: "url-scheme",
    matrix: URL_SCHEME_MATRIX,
    execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      return openUrl(invocation.payload);
    },
  };
}
