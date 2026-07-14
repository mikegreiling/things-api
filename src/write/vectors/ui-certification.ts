/**
 * Per-op certification manifest for the Accessibility GUI ("ui") vector.
 *
 * Every op ships UNCERTIFIED. The Accessibility API is unprobeable in the
 * disposable VM lab (SIP blocks it in the golden) and the developer's
 * workstation is a PRODUCTION Things library, so the element paths in the
 * recipes are derived from the KNOWN menu structure (UI1 / UI2 / UI2-i lab
 * verdicts) but have not been exercised end-to-end on real hardware. A
 * one-time real-hardware sitting (docs/lab/ui-certification-runbook.md) flips
 * these to "certified" once each recipe's element paths are confirmed with the
 * Accessibility Inspector and each op is run against a scratch database.
 *
 * This is DATA, not logic — it is the single source of truth surfaced by
 * `things capabilities`, the doctor ui-vector section, and the per-op warning
 * a successful uncertified drive carries. Kept as a typed module (not JSON) so
 * it type-checks and survives the `tsc` build without a JSON-copy step.
 */
import type { OperationKind } from "../operations.ts";
import { UI_DRIVE_OPS } from "../operations.ts";

export type CertificationStatus = "uncertified" | "certified";

export interface CertificationEntry {
  status: CertificationStatus;
  /** Lab verdict ids the recipe's structure is derived from. */
  evidence: string[];
}

/** The manifest profile — "provisional" until a real-hardware sitting lands. */
export const UI_CERTIFICATION_PROFILE = "provisional";

const CERTIFICATION: Partial<Record<OperationKind, CertificationEntry>> = {
  "todo.make-repeating": { status: "uncertified", evidence: ["UI1", "UI2-a"] },
  "todo.reschedule-repeat": { status: "uncertified", evidence: ["UI2-b"] },
  "todo.pause-repeat": { status: "uncertified", evidence: ["UI2-c"] },
  "todo.resume-repeat": { status: "uncertified", evidence: ["UI2-c"] },
  "todo.stop-repeat": { status: "uncertified", evidence: ["UI2-i"] },
  "todo.convert-to-project": { status: "uncertified", evidence: ["UI2-d"] },
  "heading.convert-to-project": { status: "uncertified", evidence: ["UI2-d"] },
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
