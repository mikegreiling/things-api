/**
 * Per-op certification manifest for the Accessibility GUI ("ui") vector.
 *
 * Certification has two tiers (see docs/design/ui-vector.md):
 *   - `lab-certified` — the op was run end-to-end through the real shipped
 *     pipeline inside a disposable Tart VM (Accessibility granted via the AXVM1
 *     user-path toggle), and the exact DB deltas the lab verdicts specify were
 *     observed. This certifies the recipe against the Things build in the golden.
 *   - `certified` — additionally confirmed on the target deployment hardware
 *     against a scratch database (docs/lab/ui-certification-runbook.md §5).
 *   - `uncertified` — recipe wired from the known menu structure but either not
 *     yet exercised, or FAILED lab certification (see `blocker`).
 *
 * UIC1 (2026-07-14, Things 3.22.11 / macOS 15.7.7 / DB v26) ran the in-VM suite:
 * five ops passed and are `lab-certified`; two FAILED and stay `uncertified`
 * with the blocker recorded, because both need to select a specific Things list
 * row and the app exposes no AX/URL handle to do so (a to-do card opens only on
 * a mouse double-click; a heading/project is not selectable via things:///show).
 * UIC5 (2026-07-15) then certified `project.make-repeating` (and the
 * `project.create-repeating` composite that rides it) `lab-certified` — the
 * pure-AX row-selection path, corrected at the sitting (the row `select` action,
 * not the silent-no-op table `AXSelectedRows` set; the detached editor's interval
 * field nests in group 1 exactly like the sheet). `heading.convert-to-project`
 * stays uncertified (still no row-selection handle for a heading).
 *
 * This is DATA, not logic — the single source of truth surfaced by
 * `things capabilities`, the doctor ui-vector section, and the per-op warning a
 * successful non-`certified` drive carries. Kept as a typed module (not JSON) so
 * it type-checks and survives the `tsc` build without a JSON-copy step.
 */
import type { OperationKind } from "../operations.ts";
import { UI_DRIVE_OPS } from "../operations.ts";

export type CertificationStatus = "uncertified" | "lab-certified" | "certified";

export interface CertificationEntry {
  status: CertificationStatus;
  /** Lab verdict ids the recipe's structure and certification are derived from. */
  evidence: string[];
  /** Why an op is uncertified after a certification attempt (a failed run). */
  blocker?: string;
}

/** The manifest profile — records the tier + Things build the suite certified. */
export const UI_CERTIFICATION_PROFILE =
  "UIC1 + UIC3 + AXDRAG2 + UIC5 + UIC6 in-VM (Things 3.22.11) — on-device pending";

const CERTIFICATION: Partial<Record<OperationKind, CertificationEntry>> = {
  "todo.make-repeating": {
    status: "lab-certified",
    evidence: ["UI1", "UI2-a", "UIC1-a", "UIC6-a"],
  },
  "todo.reschedule-repeat": { status: "lab-certified", evidence: ["UI2-b", "UIC1-a", "UIC6-k"] },
  "todo.pause-repeat": { status: "lab-certified", evidence: ["UI2-c", "UIC1-a"] },
  "todo.resume-repeat": { status: "lab-certified", evidence: ["UI2-c", "UIC1-a"] },
  "todo.convert-to-project": { status: "lab-certified", evidence: ["UI2-d", "UIC1-a"] },
  "project.reschedule-repeat": {
    status: "lab-certified",
    evidence: ["UIC2-a", "UIC3-b", "UIC6-k"],
  },
  "project.pause-repeat": { status: "lab-certified", evidence: ["UIC2-a", "UIC3-b"] },
  "project.resume-repeat": { status: "lab-certified", evidence: ["UIC2-a", "UIC3-b"] },
  "area.reorder": {
    status: "lab-certified",
    evidence: ["NATIVE1-d", "AXDRAG1-a", "AXDRAG1-b", "AXDRAG1-f", "AXDRAG2-c"],
  },
  "project.make-repeating": {
    status: "lab-certified",
    evidence: ["UIC4-a", "UIC4-b", "UIC4-f", "UIC5-a", "UIC6-i"],
  },
  "heading.convert-to-project": {
    status: "uncertified",
    evidence: ["UI2-d", "UIC1-a"],
    blocker:
      "a heading is not selectable via things:///show (the reveal URL selects to-dos only; a " +
      "heading id leaves the selection empty and Convert to Project… disabled), and heading rows " +
      "expose no AX selection handle, so the drive no-ops (UIC1). Needs a row-selection path.",
  },
};

/** Certification entry for a ui-vector op (undefined for non-ui ops). */
export function certificationOf(op: OperationKind): CertificationEntry | undefined {
  return CERTIFICATION[op];
}

/** Every ui-vector op's certification, for the doctor section + capabilities. */
export function allCertifications(): { op: OperationKind; entry: CertificationEntry }[] {
  return UI_DRIVE_OPS.map((op) => ({
    op,
    entry: CERTIFICATION[op] ?? { status: "uncertified", evidence: [] },
  }));
}
