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
    evidence: ["U03", "U04", "U07", "U09", "R01", "R04"],
    notes:
      "unknown tags silently ignored by the app — H-UNKNOWN-TAG guards pre-write; " +
      "reminders via when=<list>@<time> (deterministic emitter — oddity 2d)",
  },
  "todo.update": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U04", "U13", "U12B", "R06", "R07", "E04", "E05", "E11", "E12"],
    notes:
      "when= on a repeating template CRASHES Things (U12/R09) — H-REPEAT-SCHEDULE hard-blocks; " +
      "reminders set/auto-preserved/cleared via when=@time (R06/R07); " +
      "append-/prepend-notes newline-joined (E04/E05/E11/E12)",
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
    evidence: ["U06", "U06B", "P21", "P22"],
    notes:
      "unknown destinations are silent no-ops — H-UNKNOWN-DESTINATION guards pre-write; " +
      "EMPTY list-id detaches from project/area keeping the schedule (P21/P22)",
  },
  "todo.set-tags": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U04", "P14"],
    notes: "full replacement; an empty set clears all tags (P14)",
  },
  "todo.replace-checklist": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U07", "U20", "P15", "P18"],
    notes:
      "wholesale replacement — destroys per-item state (H-CHECKLIST-REPLACE); empty list " +
      "clears (P15); stateful items ride things:///json with per-item completed (P18, " +
      "item uuids not stable across a rewrite)",
  },
  "todo.delete": { support: "no", disruption: 3, validation: "validated", evidence: ["U14"] },
  "todo.duplicate": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["E07"],
    notes: "update?duplicate=true — exact copy (title/notes), fresh uuid + creationDate",
  },
  "project.add": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U08", "U19"],
  },
  "project.update": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["U08", "E18", "A3"],
    notes:
      "append-/prepend-notes newline-joined, same semantics as to-dos (E18); " +
      "reminder via when=<list>@time — projects carry the to-do reminderTime codec (A3)",
  },
  "todo.add-logged": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["scf2:P4d"],
    notes:
      "things:///json add with completed + completion-date/creation-date attributes — " +
      "creates a row directly in the Logbook with backdated timestamps",
  },
  "project.set-tags": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A1"],
    notes: "update-project?tags= — full replacement; unknown tags silently dropped (guarded)",
  },
  "project.move": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P23", "P24"],
    notes:
      "update-project?area-id=<uuid> moves between areas (P23); EMPTY area-id detaches " +
      "from the area — the ONLY detach surface (P24)",
  },
  "project.cancel": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P01"],
    notes:
      "canceled=true — cascades natively: open children auto-cancel (no prompt), completed " +
      "children untouched; children policy is mandatory",
  },
  "project.reopen": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P02", "P05"],
    notes:
      "completed=false / canceled=false per the pre status; reopens ONLY the project row — " +
      "cascade-resolved children stay resolved (restore them explicitly)",
  },
  "project.duplicate": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["E17"],
    notes: "update-project?duplicate=true — copies the project INCLUDING its children",
  },
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
  // NB: no `todo.clear-dated-reminder` entry — like the reorder bounce, the
  // URL fallback is an ORCHESTRATED compound (two todo.update legs), not a
  // native command, so it stays out of the vector matrix (adding it here would
  // make planVector pick url-scheme and then fail to compile the op). The
  // fallback is surfaced via the clear-reminder command + capability-matrix.md.
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
