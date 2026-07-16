/**
 * Shared SQL predicate fragments for the list views (src/read/views.ts).
 * Every live view composes these so the membership rules — untrashed, open,
 * anytime-self, the effective-project resolution, and the derived-trash
 * container checks — are written once and cannot drift between views.
 *
 * Derivation and live-probe provenance are documented at each view's call
 * site in views.ts and in docs/atlas/schema-v26.md.
 */
import { NOT_TEMPLATE } from "./queries.ts";

/** Real to-dos/projects (type IN 0,1), untrashed, excluding repeating templates. */
export const LIVE = `t.type IN (0, 1) AND t.trashed = 0 AND ${NOT_TEMPLATE}`;

/** {@link LIVE} restricted to open (status = 0) rows. */
export const OPEN = `${LIVE} AND t.status = 0`;

/**
 * The GUI-visible set: open rows PLUS closed (completed/canceled) rows the
 * periodic log-move sweep has NOT yet carried to the Logbook — completion ≠
 * logged (src/read/log-boundary.ts). A closed row keeps its slot in its list
 * until the sweep passes it, exactly as the GUI keeps it checked in place; it
 * leaves when the sweep boundary advances past its stopDate (boundary-relative,
 * no new state). This is {@link LIVE} widened to that set: swept iff
 * status IN (2,3) AND stopDate IS NOT NULL AND stopDate <= boundary — the
 * negation of the {@link markLogged} `logged` predicate, so an included closed
 * row always materializes with `logged=false`. Mirrors the project/area card
 * precedent (project-view.ts / area-view.ts keep a closed-but-unswept row
 * checked in place). ONE bind: the log boundary as epoch seconds
 * (logBoundary(db, now).getTime() / 1000). Ruling 2026-07-14 (Mike): GUI parity
 * — `today` and `anytime` show checked-but-unswept rows.
 */
export const OPEN_OR_UNSWEPT = `${LIVE} AND NOT (t.status IN (2, 3) AND t.stopDate IS NOT NULL AND t.stopDate <= ?)`;

/**
 * The `--overdue` content scope: OPEN items whose deadline falls strictly
 * BEFORE today. Due-TODAY is deliberately NOT overdue (`<`, not `<=`) —
 * mirroring the app's own Today badge split, where a deadline EQUAL to today
 * reads as "due" and only an EARLIER deadline reads as "overdue". One bind:
 * today as a packed-date int (encodePackedDate(localToday(now))), so the
 * boundary rides the same injected clock every other view uses — never a
 * hardcoded date. The `t.status = 0` clause re-tightens the OPEN_OR_UNSWEPT
 * views (today/anytime) so a checked-but-unswept row that happens to sit past
 * a deadline is excluded — overdue is remaining, OPEN work. Trash exclusion is
 * the hosting view's job (every view this composes into already drops trashed
 * and derived-trashed rows), so it is not repeated here.
 */
export const OVERDUE = `t.deadline IS NOT NULL AND t.deadline < ? AND t.status = 0`;

/** An item's own anytime membership: unscheduled-active, or dated <= today. */
export const ANYTIME_SELF = (col: string): string =>
  `((${col}.start = 1 AND (${col}.startDate IS NULL OR ${col}.startDate <= ?))
    OR (${col}.start = 2 AND ${col}.startDate IS NOT NULL AND ${col}.startDate <= ?))`;

/**
 * The item's effective project: its own link, or its heading's project for
 * headed children (heading rows carry the project link).
 */
export const EFF_PROJECT = `COALESCE(t.project, (SELECT h.project FROM TMTask h WHERE h.uuid = t.heading))`;

/**
 * Container cascade (live-verified against the UI, 2026-07-09): a to-do
 * inside a project that is NOT itself anytime-visible (someday or
 * future-scheduled, logged, or trashed) is absent from Anytime regardless of
 * the to-do's own start state — the project row alone represents it.
 * Projects and container-less to-dos pass through. Two binds (packedToday ×2).
 */
export const PROJECT_ANYTIME_ACTIVE = `(${EFF_PROJECT} IS NULL OR EXISTS (
     SELECT 1 FROM TMTask p WHERE p.uuid = ${EFF_PROJECT}
     AND p.trashed = 0 AND p.status = 0 AND ${ANYTIME_SELF("p")}))`;

/**
 * DERIVED-trash exclusion: project deletion is SHALLOW (A24B — only the
 * project row flips trashed=1; children keep trashed=0 and their links, so
 * their Trash membership is derived through the container chain). Every live
 * view must therefore check the chain, not just the row's own flag: the
 * heading (if any) and the effective project (direct or via heading) must
 * both be untrashed. Areas cannot be trashed (they delete permanently), so
 * the chain is at most heading → project. Trash-adjacent surfaces stay
 * exempt on purpose: `things trash` lists directly-flagged rows, and a
 * trashed project's OWN view shows its would-be-recovered children.
 */
export const CONTAINER_UNTRASHED = `(t.heading IS NULL OR EXISTS (
     SELECT 1 FROM TMTask hh WHERE hh.uuid = t.heading AND hh.trashed = 0))
 AND (${EFF_PROJECT} IS NULL OR EXISTS (
     SELECT 1 FROM TMTask cc WHERE cc.uuid = ${EFF_PROJECT} AND cc.trashed = 0))`;
