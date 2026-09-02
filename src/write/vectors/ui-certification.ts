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
 * `project.add-repeating` composite that rides it) `lab-certified` — the
 * pure-AX row-selection path, corrected at the sitting (the row `select` action,
 * not the silent-no-op table `AXSelectedRows` set; the detached editor's interval
 * field nests in group 1 exactly like the sheet). HEADCERT1 (2026-07-17) then
 * certified `project.promote-heading` (then spelled `heading.convert-to-project`) `lab-certified` — the LAST uncertified
 * op — by reusing the row `select` action on the heading's parent-project view:
 * a heading row IS selectable (unlike the `things:///show` reveal UIC1 tried),
 * addressed POSITIONALLY (heading rows expose no stable AX title, only a
 * hover-dependent "More" affordance) by ordinal among the project's headings.
 * With the heading selected, Convert to Project… enables. Every ui op is now
 * lab-certified.
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
  "UIC1 + UIC3 + AXDRAG2 + UIC5 + UIC6 + UIC7 + UIC7b + HEADCERT1 + HEADXPROJ + DISS1 in-VM (Things 3.22.11) + " +
  "UIC8 promote-via-clone compounds in-VM (golden-v2 / Things 3.22.12) + RDLG2 recipe re-point + " +
  "HXPC1 heading-ellipsis/Move-picker paths in-VM (golden-v4 / Things 3.23) + " +
  "CHORDMH1 heading-order arrow chords in-VM (golden-v4 / Things 3.23) + " +
  "RDLAT2 round-trip recut + shape manifest, re-certified across the dialog state matrix " +
  "(fixed / after-completion / deadlines / ends-count / paused) in-VM (golden-v4 / Things 3.23) — on-device pending";

const CERTIFICATION: Partial<Record<OperationKind, CertificationEntry>> = {
  "todo.make-repeating": {
    status: "lab-certified",
    // UIC7b: interval > 1 across units now LANDS live (closed-loop interval
    // read-back retry) and the create-probe verifies the decoded rule — no more
    // silent-ok on a mis-committed interval (oddities §8l addendum, RESOLVED).
    // UIC8 (golden-v2/3.22.12): certified as the REWIRED promote-via-clone compound
    // end-to-end (clone → trash(X) → native-promote), incl. the trash-both undo,
    // the H-CLONE-SOURCE nested-repeater refusal, and the failure-rollback.
    evidence: ["UI1", "UI2-a", "UIC1-a", "UIC6-a", "UIC7b", "UIC8"],
  },
  "todo.reschedule-repeat": {
    status: "lab-certified",
    // UIC7-b: the fixed→after-completion CONVERSION (0½ item 1) drives + verifies
    // + reports success live; caveat: a →fixed reschedule with interval > 1 hits
    // the interval-field re-layout race (oddities §8l addendum) and fail-closes
    // honestly (verify-failed:mismatch, observed interval 1).
    evidence: ["UI2-b", "UIC1-a", "UIC6-k", "UIC7-b"],
  },
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
    // UIC7b: create-probe now verifies the decoded rule (type/unit/interval) —
    // the interval guard covers project make + the add-repeating promote leg.
    // UIC8 (golden-v2/3.22.12): certified as the REWIRED promote-via-clone compound
    // end-to-end (clone → trash(X) → native-promote) incl. area/heading fate on the
    // clone-promote, the H-CLONE-SOURCE nested-repeater refusal, and the trash-both undo.
    evidence: ["UIC4-a", "UIC4-b", "UIC4-f", "UIC5-a", "UIC6-i", "UIC7b", "UIC8"],
  },
  "project.promote-heading": {
    status: "lab-certified",
    evidence: ["UI2-d", "UIC1-a", "HEADCERT1"],
  },
  "project.move-heading-to-project": {
    // HEADXPROJ (2026-07-27, bjhx-lab, Things 3.22.11) established the flow and the
    // DB oracle with a hand-written driver: HID-click the "More. <title>" button →
    // Move… → type the destination → Return, and heading `HXH`'s project FK
    // rewritten HX-PA → HX-PB with both children following via their intact heading
    // FK (project NULL, heading=HXH) — a single-row change, no index churn.
    //
    // HXPC1 (2026-08-25, hxpc1-lab, Things 3.23 / golden-v4) certified the SHIPPED
    // recipe for the first time and corrected three of the four provisional paths:
    // the "More. <title>" button is three levels below the content table (so the
    // shipped one-level `whose` clause matched nothing and the drive never got past
    // its first click), the picker is a detached `MovePopUpDialog-` window rather
    // than a sheet of the main window, and the commit is a CLICK on the row whose
    // title matches exactly — the blind Return could take the picker's
    // `New Project "<typed>"` row whenever the destination was absent from it,
    // which a completed or canceled destination is. 7/7 through the production CLI
    // (clean match, prefix collision, completed-destination refusal with zero
    // mutation). docs/lab/hxpc1-picker-assert.md.
    status: "lab-certified",
    evidence: ["HEADXPROJ", "HXPC1"],
  },
  "project.move-heading": {
    // HEADORD1 (2026-08-25, headord1-lab, Things 3.23 / golden-v4) discovered and
    // characterised the affordance: ⌘↑/⌘↓ = ±1 slot, ⌘⌥↑/⌘⌥↓ = to top/bottom on a
    // selected heading row; a single-row `index` rewrite with no sibling renumber
    // and children untouched behind their FK; a chord with nowhere to go declined
    // with zero delta and one alert beep; System Events modifiers frontmost-only,
    // `CGEventPostToPid` background-capable.
    //
    // CHORDMH1 (2026-08-25, chordmh1-lab, Things 3.23 / golden-v4) certified the
    // SHIPPED op. Its delivery gate re-measured the whole gesture with Things
    // never activated at all — `open -g` reveal, pure-AX row select, pid-posted
    // chord — and Finder frontmost at every stage, so the op ships BACKGROUND
    // delivery with no `activate` step (the least-disruptive tier any ordering op
    // has reached). The certification arms drove the production CLI over
    // 3-heading fixtures: ±1 up, ±1 down, to-top, to-bottom, a multi-hop, the
    // already-in-position no-op, the dry run, and the ungated call — children
    // byte-identical on every arm, sibling indexes byte-identical, zero beeps on
    // the normal paths. docs/lab/chordmh1-move-heading-build.md.
    //
    // CHORDMH2 (2026-08-25, chordmh2-lab, Things 3.23 / golden-v4) lifted CHORDMH1's
    // one deliberate capability cut — the whole-project refusal on any archived
    // heading — after CHORD2 cell 7a′ measured that an archived heading renders no
    // content row, takes no ordinal in the walk, and is skipped by a live heading's
    // ±1. The fence stood in for an ordinal mismatch, so the three reads that feed
    // the plan, the driver and the bare-placement anchor now return the RENDERED
    // (`status = 0`) order. Certified through the production CLI: one chord carried
    // a heading past an archived row's slot, that heading was the only row
    // rewritten, the archived row was byte-untouched on status/index/stopDate/umd,
    // children intact, zero beeps; an archived heading named as a movee or an
    // anchor still refuses with zero mutation.
    // docs/lab/chordmh2-archived-fence-lift.md.
    status: "lab-certified",
    evidence: ["HEADORD1", "CHORDMH1", "CHORDMH2"],
  },
  "project.dissolve-heading": {
    // DISS1 (2026-07-28, bjhx-lab, Things 3.22.11): the ellipsis Delete recipe ran
    // end-to-end in the clone — HID-click the "More. <title>" button → Delete — and
    // the exact delta was observed: the heading row HARD-DELETED (gone from
    // TMTask), its 3 children re-homed as DIRECT project children (heading→NULL,
    // project→parent, index preserved: c1<c2<c3, trashed=0). NO confirm sheet.
    // Popover items are AX-description-enumerable (the recipe resolves Delete by
    // description, scoped to the popover) — the one provisional path HXPC1 measured
    // CORRECT. Its sibling was not: the "More. <title>" button this drive opens the
    // popover with was addressed one level too shallow, so it resolved nothing and
    // the drive died at its first click on every host. HXPC1 (2026-08-25, Things
    // 3.23) fixed the walk and certified it through the move-heading sibling, but
    // this op was NOT driven end to end there — its next sitting should carry a cell
    // (docs/lab/hxpc1-picker-assert.md §B0/§D). The DB oracle + flow are certified.
    status: "lab-certified",
    evidence: ["DISS1"],
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
