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
    evidence: ["A22", "A22B", "A22C", "E06"],
    notes:
      "list moves + project/area property setters + move to Inbox (de-schedules, E06); " +
      "cannot target Upcoming (schedule instead); no heading placement",
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
  "todo.duplicate": {
    support: "no",
    disruption: 0,
    validation: "validated",
    evidence: ["E08"],
    notes: "the app refuses: 'Selected to dos can not be copied. (-1717)'",
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
  "project.move": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["E14"],
    notes:
      "`set area of project id` — area re-assignment; status/schedule untouched; DETACH is " +
      'URL-only (missing value/"" rejected — P08/P27)',
  },
  "project.set-tags": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A2"],
    notes: "`set tag names of project id` — full replacement, same semantics as the URL vector",
  },
  "project.restore": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P06"],
    notes:
      '`move <trashed project> to list "Anytime"` un-trashes IN PLACE — schedule/area/' +
      "children untouched; the SAME statement on a non-trashed project is a silent no-op (P09)",
  },
  "todo.restore": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["E15"],
    notes:
      '`move <trashed to-do> to list "Inbox"` un-trashes (the UI\'s Put Back) — lands in the ' +
      "Inbox de-scheduled; to-dos only (project restore is unprobed)",
  },
  "area.add": { support: "yes", disruption: 0, validation: "validated", evidence: ["A03"] },
  "area.update": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["E01", "P10e"],
    notes: "rename via `set name`; tag replacement via `set tag names`",
  },
  "area.delete": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["A25", "A25B"],
    notes: "PERMANENT — the area row is hard-deleted; contained to-dos land in Trash",
  },
  "tag.add": { support: "yes", disruption: 0, validation: "validated", evidence: ["A04", "A05"] },
  "tag.update": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["E02", "E03", "E10", "P29", "A4"],
    notes:
      "rename (assignments survive), re-parent existing, keyboard shortcut set AND clear " +
      "(`delete keyboard shortcut of tag`, A4), un-nest to root via the property-delete form " +
      "(P29 — `set … to missing value` errors, E19)",
  },
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
  "todo.backdate": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["scf2:P4b"],
    notes:
      "`set completion date` / `set creation date` property writes — the ONLY surface " +
      "that rewrites these timestamps on an existing item",
  },
  "heading.rename": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P10d", "P10b:b6"],
    notes: "`set name of to do id` — heading rows are id-addressable (enumeration hides them)",
  },
  "heading.archive": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P10d", "P10b:b1", "P11c", "P11d"],
    notes:
      "`set status of to do id` completed/canceled — the UI's Archive; open children " +
      "cascade per the status (completed vs CANCELED), pre-resolved children untouched",
  },
  "heading.unarchive": {
    support: "yes",
    disruption: 0,
    validation: "validated",
    evidence: ["P10b:b2"],
    notes: "`set status … to open` — reopens the heading only; children stay resolved",
  },
  reorder: {
    support: "partial",
    disruption: 0,
    validation: "validated",
    evidence: [
      "O01",
      "O03",
      "O04",
      "O05",
      "O06",
      "O09",
      "O10",
      "O11",
      "O12",
      "O14",
      "A6",
      "scf:P1",
      "P8a",
      "P8b",
    ],
    experimental: true,
    notes:
      "`_private_experimental_ reorder to dos in` — today (bucket-0 members), project/area " +
      "(un-headed children only, O06), inbox (unscheduled to-dos, A6/P8a), headings (a " +
      "project's heading rows, scf P1 — children follow), someday (loose someday to-dos, " +
      "two-call anchor protocol, P8b); area also reorders PROJECTS (O14, same-type " +
      "requests only); evening and top-level projects are bounce-only (O03, P8e)",
  },
};

/** Escape a string literal for embedding in AppleScript source. */
export function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function runOsascript(script: string): Promise<ExecuteResult> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 30_000 }, (err, stdout, stderr) => {
      // A deadline kill (err.killed) is a distinct signal from a nonzero
      // exit: an osascript that never returns is the shape of an unanswered
      // macOS consent dialog — surfaced for failure attribution.
      const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
      resolve({
        exitCode: err === null ? 0 : ((err as { code?: number }).code ?? 1),
        stdout: String(stdout),
        stderr: String(stderr),
        ...(timedOut && { timedOut: true }),
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
