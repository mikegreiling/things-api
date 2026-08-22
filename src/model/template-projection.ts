/**
 * A repeating template's PROJECTION DAY — the packed day its rendered projection
 * row occupies on the Upcoming day-block todayIndex axis (the TMPLSORT/PTMPL
 * placement laws). Placement math (move/reorder pre-state) groups a template with
 * the scheduled and deadline-forecast rows sharing that day.
 *
 * TWO SOURCES, in order:
 *
 *  1. `rt1_nextInstanceStartDate` when it is non-NULL. Things ≤ 3.22 maintains
 *     this per-row next-instance cache on every live template, and it is the
 *     column every projection law was probed against — so when the running app
 *     still keeps it, it IS the answer (live-version support, not a legacy
 *     shim).
 *  2. DERIVED from the decoded rule + the `rt1_instanceCreationStartDate` cursor
 *     otherwise. Things **3.23** RETIRED the cache: the dbv-27 migration nulled
 *     it library-wide (21,960 of 22,074 rows) and stopped maintaining it, while
 *     moving the spawn cursor strictly FORWARD on 82% of templates — the cursor
 *     is the app's own surviving anchor for the next occurrence, so the
 *     projection is the first rule occurrence on or after it. The projection
 *     runs through the ONE occurrence generator ({@link projectOccurrences}),
 *     never a second rule evaluator: for an on-grid cursor it returns the cursor
 *     itself; for an off-rule first occurrence (ANCH2 — a typed "Next:" the grid
 *     does not contain) it returns the first rule-ALIGNED occurrence at or after
 *     it, which is exactly what the retired column held.
 *
 * FAIL CLOSED — the helper returns `null` (never a guess) whenever the app would
 * not render a projection or the derivation is not sound:
 *
 *  - no rule blob (a bare legacy `repeater` template), or an undecodable /
 *    unknown-`rrv` rule (a Things update changed the format);
 *  - an AFTER-COMPLETION rule: it has no calendar until the prior instance
 *    resolves, so nothing is derivable from the cursor;
 *  - a PAUSED series (`rt1_instanceCreationPaused = 1`): pause clears the cursor
 *    column but RETAINS the anchor (SERDEL S3), so deriving would resurrect a
 *    projection the app does not render;
 *  - an ENDED series — an ends-ON date already past (the generator's own bound)
 *    or an ends-AFTER total reached (`rt1_instanceCreationCount` ≥ the rule's
 *    immutable `rc` total, RRX1);
 *  - a missing or out-of-domain cursor.
 *
 * Every consumer treats `null` exactly as it treats a NULL column: the template
 * contributes no day, so it is not a day-block member and no placement leg is
 * compiled for it.
 */
import { decodePackedDate, encodePackedDate } from "./dates.ts";
import { projectOccurrences } from "./occurrences.ts";
import { decodeRecurrenceRule } from "./recurrence.ts";

/**
 * The TMTask columns {@link templateProjectionDay} reads, aliased to the
 * {@link TemplateProjectionRow} field names. Splice into any SELECT that needs a
 * template's projection day (one fetch — the rule blob is selected once here, so
 * callers alias `rt1_recurrenceRule` from `tpRule` rather than again).
 */
export const TEMPLATE_PROJECTION_COLUMNS =
  "rt1_nextInstanceStartDate AS tpNext, rt1_instanceCreationStartDate AS tpCursor, " +
  "rt1_recurrenceRule AS tpRule, rt1_instanceCreationPaused AS tpPaused, " +
  "rt1_instanceCreationCount AS tpCount";

/** A template row's projection inputs (see {@link TEMPLATE_PROJECTION_COLUMNS}). */
export interface TemplateProjectionRow {
  /** `rt1_nextInstanceStartDate` — packed; always NULL on Things ≥ 3.23. */
  tpNext: number | null;
  /** `rt1_instanceCreationStartDate` — the packed spawn cursor. */
  tpCursor: number | null;
  /** `rt1_recurrenceRule` — the XML plist blob. */
  tpRule: unknown;
  /** `rt1_instanceCreationPaused`. */
  tpPaused: number | null;
  /** `rt1_instanceCreationCount` — spawns so far (RRX1). */
  tpCount: number | null;
}

/**
 * The packed day a repeating template projects into, or `null` when it projects
 * nowhere. Callers apply their own strictly-future / day-equality gate; this
 * returns the day only.
 */
export function templateProjectionDay(row: TemplateProjectionRow): number | null {
  // Things ≤ 3.22: the app's own cache is authoritative.
  if (row.tpNext !== null) return row.tpNext;
  // Things ≥ 3.23: derive. A paused series renders no projection (its cursor
  // column was cleared while the anchor stayed) — never resurrect one.
  if (row.tpPaused === 1) return null;
  if (row.tpRule === null || row.tpRule === undefined) return null;
  let cursorIso;
  try {
    cursorIso = decodePackedDate(row.tpCursor);
  } catch {
    return null; // out-of-domain packed value — fail closed
  }
  if (cursorIso === null) return null;
  let rule;
  try {
    rule = decodeRecurrenceRule(row.tpRule);
  } catch {
    return null; // undecodable / unknown rrv — fail closed
  }
  // After-completion series have no calendar to project from.
  if (rule.type !== "fixed") return null;
  // Ends-after exhaustion: rc is the immutable configured TOTAL and the app
  // counts spawns in icCount (RRX1), so count >= total means the series ended.
  if (rule.occurrenceCount !== null && (row.tpCount ?? 0) >= rule.occurrenceCount) return null;
  // The first occurrence on or after the cursor (the generator bounds itself by
  // the rule's endDate, so a past ends-on series yields nothing).
  const first = projectOccurrences(rule, cursorIso, { count: 1 }, false)[0];
  if (first === undefined) return null;
  try {
    return encodePackedDate(first.startDate);
  } catch {
    return null;
  }
}
