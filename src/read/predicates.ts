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
 * The Today DEADLINE-PULL arm (BANNER1 / BANNER1b, docs/lab/banner1-research.md):
 * an UNDATED row (startDate NULL) that a due/overdue, un-dismissed deadline pulls
 * into Today — even from the Inbox or Someday, while its raw `start` still reads
 * 0/2. This is the EXACT second arm {@link todayView} uses; it is written ONCE
 * here so the three GUI-faithful memberships that turn on it can never drift from
 * the pull the Today view claims (BANNER1 law L-A):
 *   - `todayView` INCLUDES it (a deadline pulls the row into Today);
 *   - `anytimeView` INCLUDES it (Anytime ⊇ Today's to-dos — the pull re-files the
 *     row into Anytime, BANNER1b);
 *   - `somedayView` / `inboxView` EXCLUDE it (the GUI removes a pulled row from
 *     Someday/Inbox even before it materializes, BANNER1 Q1b).
 * The `startDate IS NULL` clause scopes it to UNMATERIALIZED pulls; the
 * suppression guard drops a dismissed nag (supp == deadline) and lets a re-armed
 * one (supp < deadline) through (oddities §8e). ONE bind: today as a packed-date
 * int (encodePackedDate(localToday(now))), the same injected clock every view uses.
 */
export const DEADLINE_PULLED = `(t.deadline IS NOT NULL AND t.deadline <= ? AND t.startDate IS NULL
    AND (t.deadlineSuppressionDate IS NULL OR t.deadlineSuppressionDate < t.deadline))`;

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

/**
 * The Today/Evening VISIBLE comparator (today-order-research; the {@link ../views.ts}
 * `todayView` ORDER BY). ONE law, ONE implementation — the reader's Today
 * ordering AND the reorder census's visible-order enumeration (the today-axis
 * minimal-wire builder, src/write/pre-state.ts) share it, so the wire the engine
 * sends to `_private_experimental_ reorder to dos in list "Today"` can never
 * drift from the order the reader renders (TODWIRE, [docs/lab/todwire-partial-wires-today.md]).
 * `p` prefixes the columns (`"t."` for the reader's aliased rows, `""` for the
 * bare-TMTask reorder census). `startBucket` first (today above evening), then the
 * newest ENTRY cohort (`COALESCE(tiRef, startDate, deadline) DESC`), then the
 * within-cohort manual order (`todayIndex ASC`), then the observed `uuid` tiebreak.
 */
export const todayOrderBy = (p = ""): string =>
  `${p}startBucket ASC, COALESCE(${p}todayIndexReferenceDate, ${p}startDate, ${p}deadline) DESC, ${p}todayIndex ASC, ${p}uuid ASC`;
