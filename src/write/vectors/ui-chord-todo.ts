/**
 * IN-CONTAINER TO-DO ORDER on the arrow-chord vector (CHORD2 — the full law
 * matrix, docs/lab/chord2-reorder-laws.md; built as CHORD3,
 * docs/lab/chord3-todo-chord-op.md; extended to the DAY axis by CHORD4,
 * docs/lab/chord4-today-cohort.md).
 *
 * THE LAW THIS RIDES (measured, Things 3.23 / golden-v4, CHORD2 cells 1B/1C,
 * 2a, 3, 4, 6a):
 *
 *   With ONE to-do row selected in a rendered list, ⌘↑ / ⌘↓ move it one
 *   DISPLAYED slot up / down. The write is a single row's rank column — `index`
 *   for a project / Inbox / Someday / Anytime list, `todayIndex` for Today /
 *   Evening / an Upcoming day-group — and `userModificationDate` is NOT stamped.
 *   A chord with nowhere to go is DECLINED: zero delta, one macOS alert beep.
 *   The whole gesture (reveal, select, chord) runs with Things BACKGROUNDED at
 *   tier 0, Finder frontmost, zero disruption events.
 *
 * THE THREE HAZARDS THAT SHAPE THIS DRIVER, all measured by CHORD2:
 *
 *  1. **A crossing is SILENT.** A chord fired at a row already sitting at its
 *     bucket's edge does not decline — it performs a MEMBERSHIP change (§3a a
 *     headed child deported to the project root; §3f a loose row adopted by the
 *     first heading; §3e a bucket crossing under ⌘⌥; §4be2 an Evening row
 *     carried into the daytime section). No beep marks it. So the driver never
 *     fires a chord that could take a row past its column's own first/last
 *     member, and it uses the `umd` stamp as the post-hoc tripwire (§6a: a pure
 *     rank move is umd-SILENT; every measured crossing stamped it).
 *  2. **The chord is VIEW-relative** (§4bf). Under a tag filter a single ±1
 *     jumps every hidden row. The recipe reveals the column's own unfiltered
 *     view and refuses on a positive filter sighting; the per-chord assertion
 *     below is the backstop that catches a view we did not model.
 *  3. **A non-contiguous multi-selection COALESCES** (§2) — a silent
 *     destructive collapse. This driver selects exactly ONE row at a time, so
 *     the shape cannot arise; the op's own fence refuses a non-contiguous
 *     request before the drive starts.
 *  4. **On the DAY axis, a cohort crossing is silent AND `umd`-silent**
 *     (CHORD4 §3) — the one exception to hazard 1's tripwire. The Today list is
 *     grouped by the day each row ENTERED Today before it is ordered by hand,
 *     and a chord that would cross a group boundary does not decline: it
 *     re-dates the mover's entry to the destination group, durably, one-way,
 *     with no `userModificationDate` on any row. So the day-axis columns carry a
 *     PRE-FLIGHT cohort fence (`cohortFenceViolation`, asked by the pipeline one
 *     read before the drive so a refusal can fall back to the bounce with
 *     nothing mutated) and the per-chord assertion below compares the cohort as
 *     well as the containment digest.
 *
 * WHY IT IS A CLOSED LOOP. A bare keybinding on an undocumented surface has no
 * contract (harness.md §AX-drive scrutiny): the DATABASE is the only oracle. So
 * each step is read the column → compute the ONE chord that advances it → post
 * exactly that chord → read the column back and prove the intended row moved
 * exactly one slot with nothing else renumbered outside the span it crossed, no
 * member's containment rewritten and no member's `umd` stamped. A step that
 * produces NO delta stops the drive and names the boundary; it is never
 * re-fired blind.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { todayPlacement } from "../../model/today-placement.ts";
import { todayOrderBy } from "../../read/predicates.ts";
import { chordCommand, chordGlyph, planChordStep, type ChordStep } from "./ui-chord.ts";
import type { UiCommand, UiRunner } from "./ui.ts";

// ------------------------------------------------------------------- types

/**
 * The container columns this vector re-ranks. Each names a MEMBER PREDICATE (the
 * rows the column contains) and the VIEW that renders them — the two facts the
 * chord needs, because the gesture moves a row one DISPLAYED slot and the
 * assertion is made against the member column.
 */
export type TodoChordColumn = "area-someday" | "anytime" | "today" | "evening";

/** The day-axis columns — the two whose rank key is `todayIndex` (CHORD4). */
export function isDayAxisColumn(column: TodoChordColumn): boolean {
  return column === "today" || column === "evening";
}

/**
 * The chord column a `reorder` SCOPE maps onto, or null when the scope has no
 * measured chord behaviour and must stay on its headless surface.
 *
 * The gate is evidence, not capability: the chord reaches every `index`-axis
 * container order in the app (CHORD2 §8.1), and the scopes are migrated one
 * certified batch at a time so each arrives with its own cell verdicts.
 */
export function todoChordColumnOf(scope: string): TodoChordColumn | null {
  return scope === "area-someday" || scope === "anytime" || scope === "today" || scope === "evening"
    ? scope
    : null;
}

/** The rank column a {@link TodoChordColumn} is ordered on. */
export function columnRankKey(column: TodoChordColumn): "index" | "todayIndex" {
  // CHORD2 §4's per-view column map: Someday and Anytime re-rank on `index`,
  // Today and This Evening on `todayIndex`.
  return isDayAxisColumn(column) ? "todayIndex" : "index";
}

/**
 * The `things:///show?id=` value whose view renders the column, contiguously and
 * unfiltered.
 *
 * `area-someday` reveals the SOMEDAY stage list rather than the area's own view:
 * Someday groups its rows by area, so an area's someday members are adjacent
 * there, whereas an area view ranks every direct member — someday and anytime
 * alike — on one interleaved `index` axis. `anytime` reveals the Anytime stage
 * list, where the area-less loose rows are the ungrouped block at the top.
 *
 * `today` and `evening` BOTH reveal `today`: This Evening is a SECTION of the
 * Today view, not a view of its own (CHORD2 §4, CHORD4 §1 — the AX census shows
 * one table with a `This Evening` header row inside it).
 */
export function columnViewId(column: TodoChordColumn): string {
  if (isDayAxisColumn(column)) return "today";
  return column === "area-someday" ? "someday" : "anytime";
}

/** The move a `chord-reorder-todo` step performs, compiled from the pre-state. */
export interface TodoChordSpec {
  column: TodoChordColumn;
  /** The area whose someday members are being reordered; null for `anytime`. */
  containerUuid: string | null;
  /**
   * The consumer day, packed — the clock the day-axis columns' membership is
   * judged against ({@link todayPlacement}). Pinned at PLAN time and reused for
   * every read the drive makes, so a drive that straddles local midnight keeps
   * asserting against the list it planned for instead of silently switching
   * columns mid-walk. Ignored by the `index` columns.
   */
  packedToday: number;
  /**
   * Every member of the column, in the order they must end up in — the full end
   * state, not just the moved block, so it doubles as the verification target.
   */
  targetOrder: string[];
  /**
   * The to-dos the caller named. Only these may ever be chorded: if the
   * placement walk would have to move a row the caller did not name, the drive
   * refuses rather than touch a bystander.
   */
  movees: string[];
  /** The revealed view's content table (the recipe supplies the one path). */
  tablePath: string;
}

/** One member row, as the database sees it between chords. */
export interface TodoColumnRow {
  uuid: string;
  /** The row's title — what the view renders, and the visibility fence's key. */
  title: string;
  /** The column's rank value (`index` or `todayIndex`). */
  rank: number;
  /**
   * Containment digest — `project|heading|area|start|startBucket`. A chord that
   * silently reparents a row (CHORD2 §3a/§3e/§3f/§4be2) changes exactly this,
   * and it is the field set the column's membership predicate is built on, so a
   * crossing shows up here or as a member that vanished.
   */
  bucket: string;
  /**
   * `userModificationDate`. A pure rank move leaves it alone (§6a); every
   * measured CONTAINER crossing stamped it. The cheap tripwire for "did this
   * chord silently reparent something?".
   */
  umd: number | null;
  /**
   * The Today ENTRY COHORT — `COALESCE(todayIndexReferenceDate, startDate,
   * deadline)`, the second key of {@link todayOrderBy} — or null on the `index`
   * columns, which have no such dimension.
   *
   * It is a tripwire in its own right, and the ONE the `umd` field cannot serve
   * (CHORD4 §3): a chord across a cohort boundary re-stamps the mover's entry
   * date to the destination cohort's key, durably and one-way, with **no** `umd`
   * on any row. So the cohort is asserted per chord as well, behind the
   * pre-flight fence that stops such a chord being posted at all.
   */
  cohort: number | null;
}

/** The database read the driver asserts against between chords. */
export interface TodoOrderState {
  /** The column's members, in rank order (the rows the view renders). */
  rows: TodoColumnRow[];
  /** Digest over `uuid:rank:bucket:umd` for every member (cheap whole-column compare). */
  digest: string;
}

/** The database seam the to-do chord driver reads its ground truth through. */
export type TodoOrderReader = (spec: {
  column: TodoChordColumn;
  containerUuid: string | null;
  /** The consumer day, packed — see {@link TodoChordSpec.packedToday}. */
  packedToday: number;
}) => TodoOrderState;

/** `project|heading|area|start|startBucket` — see {@link TodoColumnRow.bucket}. */
const BUCKET_EXPR =
  "COALESCE(project,'')||'|'||COALESCE(heading,'')||'|'||COALESCE(area,'')||'|'||" +
  "COALESCE(start,-1)||'|'||COALESCE(startBucket,-1)";

/** `COALESCE(todayIndexReferenceDate, startDate, deadline)` — {@link todayOrderBy}'s cohort key. */
const COHORT_EXPR = "COALESCE(todayIndexReferenceDate, startDate, deadline)";

/** The rows a chord ROW is never counted among, on any column. */
const NOT_TEMPLATE = "(rt1_recurrenceRule IS NULL AND repeater IS NULL)";

/**
 * The DERIVED-trash chain (A24B): a row whose heading or effective project is
 * trashed is not rendered, so it is not a slot the gesture can step over.
 */
const EFF_PROJECT =
  "COALESCE(TMTask.project, (SELECT h.project FROM TMTask h WHERE h.uuid = TMTask.heading))";
const CONTAINER_UNTRASHED =
  "(TMTask.heading IS NULL OR EXISTS (SELECT 1 FROM TMTask hh WHERE hh.uuid = TMTask.heading AND hh.trashed = 0)) " +
  `AND (${EFF_PROJECT} IS NULL OR EXISTS (SELECT 1 FROM TMTask cc WHERE cc.uuid = ${EFF_PROJECT} AND cc.trashed = 0))`;

/**
 * The member predicate per column, in the order the VIEW renders them.
 *
 * The `index` columns are the SAME predicate `computeReorderPre` uses for the
 * scope, so the planner's target order and the driver's oracle are the one list.
 *
 * THE DAY-AXIS COLUMNS ARE NOT (CHORD4 §1, §5.3), and the difference is the
 * reason this takes a clock:
 *
 *  - Membership is SQL **plus a host-side placement rule** — `startBucket = 1`
 *    alone is not This Evening, because evening expires daily and a STALE
 *    bucket-1 row is rendered in Today PROPER ({@link todayPlacement}, STEV1).
 *    So the SQL admits the arrived set and {@link todayPlacement} splits it.
 *  - The `today` column is a **SUPERSET of the `today` reorder scope**: a
 *    DEADLINE-PULLED row (undated, dragged into Today by a due deadline) is
 *    rendered, ranks on the same `todayIndex` axis, and CHORD4 measured a chord
 *    stepping over one renumbering it. The gesture counts DISPLAYED slots, so
 *    the driver's column has to be what the view renders. Such a row is never a
 *    movee — `movees` fences that — it is a slot to step over.
 *  - The order is {@link todayOrderBy}, not the rank column: the entry COHORT
 *    outranks `todayIndex`. CHORD4 confirmed that comparator reproduces the
 *    app's rendered order to the `uuid` tiebreak.
 */
export function columnPredicate(
  column: TodoChordColumn,
  packedToday: number,
): { where: string; binds: (string | number)[]; orderBy: string } {
  if (column === "area-someday") {
    return {
      where:
        "type = 0 AND trashed = 0 AND status = 0 AND area = ? AND heading IS NULL " +
        "AND start = 2 AND startDate IS NULL",
      binds: [""],
      orderBy: `"index", uuid`,
    };
  }
  if (column === "anytime") {
    return {
      where:
        "type = 0 AND trashed = 0 AND status = 0 AND project IS NULL AND area IS NULL " +
        "AND heading IS NULL AND start = 1 AND startDate IS NULL",
      binds: [],
      orderBy: `"index", uuid`,
    };
  }
  const orderBy = todayOrderBy();
  if (column === "evening") {
    // The live This Evening section: arrived, bucket-1 — and the host-side
    // placement filter keeps only the rows whose evening flag is still LIVE.
    return {
      where:
        `type IN (0, 1) AND trashed = 0 AND status = 0 AND ${NOT_TEMPLATE} AND ${CONTAINER_UNTRASHED} ` +
        "AND startDate IS NOT NULL AND startDate <= ? AND start IN (1, 2) AND startBucket = 1",
      binds: [packedToday],
      orderBy,
    };
  }
  // `today`: the rendered Today-PROPER section — the scheduled arm plus the
  // BANNER1 deadline-pull arm, with the live evening rows removed host-side.
  return {
    where:
      `type IN (0, 1) AND trashed = 0 AND status = 0 AND ${NOT_TEMPLATE} AND ${CONTAINER_UNTRASHED} ` +
      "AND ((startDate IS NOT NULL AND startDate <= ? AND start IN (1, 2)) " +
      "OR (deadline IS NOT NULL AND deadline <= ? AND startDate IS NULL " +
      "AND (deadlineSuppressionDate IS NULL OR deadlineSuppressionDate < deadline)))",
    binds: [packedToday, packedToday],
    orderBy,
  };
}

/** The client-side default: the column's members + their crossing tripwires. */
export function createTodoOrderReader(db: DatabaseSync): TodoOrderReader {
  return ({ column, containerUuid, packedToday }): TodoOrderState => {
    const { where, binds, orderBy } = columnPredicate(column, packedToday);
    const rankCol = columnRankKey(column) === "index" ? `"index"` : "todayIndex";
    const rows = (
      db
        .prepare(
          `SELECT uuid, COALESCE(title,'') AS title, ${rankCol} AS rank, ${BUCKET_EXPR} AS bucket, ` +
            `${COHORT_EXPR} AS cohort, start, startDate, startBucket, ` +
            `userModificationDate AS umd FROM TMTask WHERE ${where} ORDER BY ${orderBy}`,
        )
        .all(...(column === "area-someday" ? [containerUuid ?? ""] : binds)) as unknown as {
        uuid: string;
        title: string;
        rank: number;
        bucket: string;
        cohort: number | null;
        start: number;
        startDate: number | null;
        startBucket: number | null;
        umd: number | null;
      }[]
    ).filter((r) => {
      // The host-side half of the day-axis membership ({@link todayPlacement}).
      // A deadline-pulled row (startDate NULL) has no placement and is never an
      // evening member; it belongs to the rendered `today` column.
      if (column === "today") return todayPlacement(r, packedToday) !== "evening";
      if (column === "evening") return todayPlacement(r, packedToday) === "evening";
      return true;
    });
    const hash = createHash("sha256");
    for (const r of rows) hash.update(`${r.uuid}:${r.rank}:${r.bucket}:${r.cohort}:${r.umd}\n`);
    return {
      rows: rows.map((r) => ({
        uuid: r.uuid,
        title: r.title,
        rank: r.rank,
        bucket: r.bucket,
        cohort: r.cohort,
        umd: r.umd,
      })),
      digest: hash.digest("hex"),
    };
  };
}

/**
 * The chord's end state for a DAY-AXIS column: the rendered column with the
 * movee block lifted out and spliced back in at the requested position.
 *
 * The `index` columns can use `wireList` directly, because there the wire order
 * IS the displayed order and the wire covers the whole column. On the day axis
 * neither holds (CHORD4 §1): the displayed order is {@link todayOrderBy}, and
 * the rendered column includes rows the reorder SCOPE does not admit. So the
 * target is derived instead — every non-movee keeps its displayed position
 * relative to the others, and the movees land as one block.
 *
 * The insertion point is read out of `requested`, which already encodes the
 * caller's placement: `--first` puts the movees at the head (no preceding
 * non-movee → the front of the column), `--last` and `--before`/`--after` put
 * them after a specific row, which is the row this looks for.
 */
export function chordTargetOrder(
  displayed: readonly string[],
  requested: readonly string[],
  movees: ReadonlySet<string>,
): string[] {
  const inColumn = new Set(displayed);
  const block = requested.filter((u) => movees.has(u) && inColumn.has(u));
  if (block.length === 0) return [...displayed];
  const firstMoveeAt = requested.findIndex((u) => movees.has(u));
  let anchorBefore: string | null = null;
  for (let i = firstMoveeAt - 1; i >= 0; i--) {
    const u = requested[i] as string;
    if (!movees.has(u) && inColumn.has(u)) {
      anchorBefore = u;
      break;
    }
  }
  const rest = displayed.filter((u) => !movees.has(u));
  const anchorAt = anchorBefore === null ? -1 : rest.indexOf(anchorBefore);
  const insertAt = anchorBefore === null ? 0 : anchorAt < 0 ? rest.length : anchorAt + 1;
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
}

/**
 * THE COHORT FENCE (CHORD4, ruling 2026-09-07) — pre-flight, before any chord.
 *
 * The Today list is grouped by ENTRY COHORT before it is ordered by the manual
 * rank ({@link todayOrderBy}), and a chord that would carry a row across a
 * cohort boundary does NOT decline: it re-stamps the mover's
 * `todayIndexReferenceDate` to the destination cohort's key — backwards,
 * durably, one-way — and stamps no `userModificationDate` on any row, so
 * nothing downstream of the gesture can notice (CHORD4 §3, oddities §35).
 *
 * So the crossing is refused before it is posted. Two conditions, both cheap:
 *
 *  1. every named movee shares ONE cohort (a set spanning cohorts cannot be
 *     gathered into a contiguous block without a crossing), and
 *  2. the target order preserves the column's cohort SEQUENCE — every row stays
 *     inside its own cohort's block, so every ±1 the walk plans is intra-cohort.
 *
 * Returns the refusal sentence, or null when the move is inside one cohort.
 * `index` columns have no cohort dimension and always pass.
 */
export function cohortFenceViolation(
  rows: readonly TodoColumnRow[],
  target: readonly string[],
  movees: ReadonlySet<string>,
): string | null {
  if (rows.every((r) => r.cohort === null)) return null;
  const cohortOf = new Map(rows.map((r) => [r.uuid, r.cohort]));
  const named = [...movees].filter((u) => cohortOf.has(u));
  const moveeCohorts = new Set(named.map((u) => cohortOf.get(u)));
  if (moveeCohorts.size > 1) {
    return (
      `the ${named.length} to-do(s) named do not share one Today entry group — this list is ` +
      "grouped by the day each item entered Today before it is ordered by hand, and the " +
      "keyboard reorder cannot move an item between groups without silently re-dating its " +
      "entry. Reorder the items of one group at a time"
    );
  }
  const current = rows.map((r) => r.cohort);
  const wanted = target.map((u) => cohortOf.get(u) ?? null);
  for (let i = 0; i < current.length; i++) {
    if (current[i] === wanted[i]) continue;
    const uuid = target[i] ?? "";
    const row = rows.find((r) => r.uuid === uuid);
    return (
      `the requested position would move "${row?.title ?? uuid}" into a different Today entry ` +
      "group — this list is grouped by the day each item entered Today before it is ordered by " +
      "hand, and the keyboard reorder reaches that position only by silently re-dating the " +
      "item's entry. Reschedule the item (`things todo update <ref> --when today`) to move it " +
      "into today's group first, then reorder inside it"
    );
  }
  return null;
}

// -------------------------------------------------------------- the ladder

/**
 * Absolute backstop on posted chords. The placement walk is O(n²) hops in the
 * worst case (a fully reversed column) and the per-step progress guard already
 * stops a drive that is not converging — this only bounds a pathological
 * request. Deliberately the same ceiling the heading driver carries.
 */
const MAX_CHORDS_CEILING = 200;
const ASSERT_ATTEMPTS = 12;
const ASSERT_DELAY_MS = 250;
const STEP_TIMEOUT_MS = 30_000;

export interface TodoChordDriveResult {
  ok: boolean;
  /** Human-readable outcome (chords posted) or the refusal reason. */
  detail: string;
  /** How many chords were posted before the outcome (partial-state honesty). */
  chords: number;
}

interface TodoCtx {
  run: UiRunner;
  state: () => TodoOrderState;
  sleep: (ms: number) => Promise<void>;
  selectScript: (uuid: string) => string;
  visibleTitlesScript: string | null;
}

function orderOf(state: TodoOrderState): string[] {
  return state.rows.map((r) => r.uuid);
}

function positionOf(state: TodoOrderState, uuid: string): number {
  return state.rows.findIndex((r) => r.uuid === uuid);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

/** Select the row carrying `uuid` in the revealed view (identity by uuid readback). */
export function todoChordSelectCommand(uuid: string, script: string): UiCommand {
  return {
    primitive: "select-row",
    label: "select the to-do row to move",
    script,
    meta: { uuid },
  };
}

/**
 * The per-chord law assertion (CHORD2 §2 + §6a), in the shape the app actually
 * implements it.
 *
 * The order must be EXACTLY the order the chord was supposed to produce. Exactly
 * ONE member's rank may differ, and it must lie inside the span the move
 * crossed — moving a row UP rewrites the mover, moving one DOWN rewrites the
 * sibling it passed (§2a/§2a2), and either way the app picks whichever single
 * write is cheapest. No member's containment digest may change (a silent
 * crossing — §3a/§3e/§3f/§4be2) and no member's `umd` may be stamped (§6a: a
 * pure rank move does not stamp it, every crossing did).
 */
export function todoSingleRowWriteViolation(
  before: TodoOrderState,
  after: TodoOrderState,
  moved: string,
  landsAt: number,
): string | null {
  const beforeOrder = orderOf(before);
  const from = beforeOrder.indexOf(moved);
  const expected = beforeOrder.filter((u) => u !== moved);
  expected.splice(landsAt, 0, moved);
  const observed = orderOf(after);
  if (!sameOrder(observed, expected)) {
    return `the list order after the chord is not the order the step aimed for (${observed.length} row(s))`;
  }
  const lo = Math.min(from, landsAt);
  const hi = Math.max(from, landsAt);
  const spanned = new Set(beforeOrder.slice(lo, hi + 1));
  const rewritten: string[] = [];
  for (const row of before.rows) {
    const now = after.rows.find((r) => r.uuid === row.uuid);
    if (now === undefined) return `to-do ${row.uuid} left the list`;
    if (now.bucket !== row.bucket) {
      return (
        `it moved to-do ${row.uuid} into a different container (a chord at a bucket edge ` +
        "reparents the row silently instead of declining)"
      );
    }
    if (now.umd !== row.umd) {
      return (
        `it stamped to-do ${row.uuid}'s modification date — a pure reorder does not, so this ` +
        "chord changed something other than the order"
      );
    }
    if (now.cohort !== row.cohort) {
      // CHORD4 §3: the one silent crossing `umd` does NOT mark. Behind the
      // pre-flight fence this is unreachable; it is the backstop for a column
      // whose cohort structure changed between planning and this chord.
      return (
        `it re-dated to-do ${row.uuid}'s entry into Today — a reorder does not, so this chord ` +
        "moved the row into a different entry group instead of reordering it"
      );
    }
    if (now.rank !== row.rank) rewritten.push(row.uuid);
  }
  const outside = rewritten.filter((u) => !spanned.has(u));
  if (outside.length > 0) {
    return `it also renumbered to-do ${outside[0]}, which the move never passed over`;
  }
  if (rewritten.length > 1) {
    return `it renumbered ${rewritten.length} to-dos at once — a chord rewrites exactly one row`;
  }
  return null;
}

/** Poll the database until `check` passes, or the attempts run out. */
async function pollState(
  ctx: TodoCtx,
  check: (state: TodoOrderState) => boolean,
): Promise<TodoOrderState | null> {
  for (let i = 0; i < ASSERT_ATTEMPTS; i++) {
    const state = ctx.state();
    if (check(state)) return state;
    // polling the same database condition is inherently sequential
    await ctx.sleep(ASSERT_DELAY_MS);
  }
  return null;
}

/**
 * The step schedule, ±1 only. Shares the heading driver's walk (which is pure
 * uuid arithmetic) with the ⌘⌥ endpoint shortcuts turned OFF: for a to-do column
 * that is a SUBSET of its view's rows, ⌘⌥ is scoped to the APP's bucket rather
 * than to ours (CHORD2 §3d), so a to-top would carry the row past the column's
 * own first member in one dispatch. Whether the two bucket notions coincide for
 * these columns is measured by CHORD3's `to top` / `to bottom` cells; until then
 * the walk pays N dispatches and stays inside the column.
 */
export function planTodoChordStep(
  order: readonly string[],
  target: readonly string[],
  movees: ReadonlySet<string>,
): ChordStep | { error: string } | null {
  return planChordStep(order, target, movees, { endpointShortcuts: false, noun: "to-do" });
}

/**
 * Drive a container column into `spec.targetOrder`, one verified chord at a
 * time. Nothing here trusts the plan it made a moment ago: every step is
 * re-derived from a fresh database read, and a step counts only once the
 * database says the row landed where it was aimed with nothing else touched.
 */
export async function driveTodoChordReorder(
  spec: TodoChordSpec,
  run: UiRunner,
  reader: TodoOrderReader | undefined,
  selectScript: (uuid: string) => string,
  visibleTitlesScript: string | null = null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<TodoChordDriveResult> {
  if (reader === undefined) {
    return {
      ok: false,
      chords: 0,
      detail:
        "the to-do order driver has no database seam on this surface — this operation can " +
        "only run through the full client",
    };
  }
  const ctx: TodoCtx = {
    run,
    state: () =>
      reader({
        column: spec.column,
        containerUuid: spec.containerUuid,
        packedToday: spec.packedToday,
      }),
    sleep,
    selectScript,
    visibleTitlesScript,
  };
  const target = spec.targetOrder;
  const pre = ctx.state();
  const preOrder = orderOf(pre);

  // The order was computed from a read taken before the GUI was touched; if the
  // column's membership has changed since (another client, or the app), the whole
  // plan is stale — including which row sits at which displayed slot. Refuse.
  if (
    preOrder.length !== target.length ||
    !preOrder.every((u) => target.includes(u)) ||
    !target.every((u) => preOrder.includes(u))
  ) {
    return {
      ok: false,
      chords: 0,
      detail:
        `the list changed between planning and driving (planned for ${target.length} to-do(s), ` +
        `found ${preOrder.length}) — nothing was moved; re-read the list and reissue the move`,
    };
  }
  if (sameOrder(preOrder, target)) {
    return { ok: true, chords: 0, detail: "already in the requested order — no chord was sent" };
  }

  // THE COHORT FENCE (CHORD4). The pipeline runs it too, one read earlier, so
  // that a refusal can fall back to the schedule round-trip with nothing
  // mutated; this is the same question asked of the list as it stands NOW, the
  // moment before the first chord.
  const cohortRefusal = cohortFenceViolation(pre.rows, target, new Set(spec.movees));
  if (cohortRefusal !== null) {
    return { ok: false, chords: 0, detail: `${cohortRefusal}. Nothing was moved` };
  }

  // THE VIEW FENCE (CHORD2 §4bf). The chord moves a row one DISPLAYED slot, so
  // the drive is only sound while every member of the column is ON SCREEN as a
  // row: a filter or a search that hides one makes a single ±1 jump two slots of
  // the list the caller asked about. Hidden NON-members are harmless — they sit
  // between two members the gesture still swaps — so the fence asks the one
  // question that matters and no more. One Apple event: the plural read
  // `value of static texts of <table>` realizes every rendered row label at once.
  // A probe that cannot answer is permissive (the MODALX1 preflight precedent);
  // the per-chord assertion below catches a view we mis-modelled before a second
  // chord can compound it.
  if (ctx.visibleTitlesScript !== null) {
    const probe = await ctx.run(
      {
        primitive: "resolve",
        label: "confirm every to-do in this list is on screen (no filter or search)",
        script: ctx.visibleTitlesScript,
      },
      STEP_TIMEOUT_MS,
    );
    if (probe.ok) {
      const shown = new Set(
        probe.stdout
          .split("\n")
          .map((t) => t.trim())
          .filter((t) => t !== ""),
      );
      const missing = pre.rows.filter((r) => r.title !== "" && !shown.has(r.title));
      if (shown.size > 0 && missing.length > 0) {
        return {
          ok: false,
          chords: 0,
          detail:
            `${missing.length} of the ${pre.rows.length} to-do(s) in this list are not on screen ` +
            `(the first is "${missing[0]?.title ?? ""}") — the list is filtered, searched, or ` +
            "collapsed. The reorder gesture moves a row past the row ABOVE IT ON SCREEN, which " +
            "in a filtered list is not its neighbour here. Clear the filter in Things and run " +
            "the same command again. Nothing was moved",
        };
      }
    }
  }

  const moveeSet = new Set(spec.movees);
  const cap = Math.min(MAX_CHORDS_CEILING, target.length * target.length + target.length);
  let chords = 0;
  /** Which row the last select landed on — the selection FOLLOWS the row it moves. */
  let selected: string | null = null;

  for (;;) {
    const before = ctx.state();
    const plan = planTodoChordStep(orderOf(before), target, moveeSet);
    if (plan === null) break;
    if ("error" in plan) {
      return { ok: false, chords, detail: `${plan.error} — refusing to reorder a bystander` };
    }
    if (chords >= cap) {
      return {
        ok: false,
        chords,
        detail: `the move exceeded its chord budget (${cap}) without reaching the requested order`,
      };
    }
    const want = plan.uuid;

    // (1) Selection, by UUID readback — the only honest oracle when two rows can
    //     share a title (CHORD2 §10.3). A row stays selected as it moves, so a run
    //     of hops on the same row costs ONE walk of the table.
    if (selected !== want) {
      const sel = await ctx.run(
        todoChordSelectCommand(want, ctx.selectScript(want)),
        STEP_TIMEOUT_MS,
      );
      if (!sel.ok || sel.stdout.trim() !== "OK") {
        return {
          ok: false,
          chords,
          detail:
            "the list did not show the to-do being moved as a selectable row " +
            `(${sel.ok ? sel.stdout.trim() || "no match" : sel.stderr.trim() || "the selection step failed"})` +
            (chords > 0 ? ` — ${chords} chord(s) had already landed` : " — nothing was moved"),
        };
      }
      selected = want;
    }

    // (2) Exactly one chord, chosen from the database, never fired blind.
    const post = await ctx.run(chordCommand(plan.chord), STEP_TIMEOUT_MS);
    chords += 1;
    if (!post.ok) {
      return {
        ok: false,
        chords,
        detail: `posting ${chordGlyph(plan.chord)} to Things failed (${post.stderr.trim() || "no detail"})`,
      };
    }

    // (3) The database is the oracle. STRICT progress: the row must be at the
    //     slot the chord was supposed to put it in.
    const after = await pollState(ctx, (s) => positionOf(s, want) === plan.landsAt);
    if (after === null) {
      const now = ctx.state();
      const landed = chords > 1 ? `; ${chords - 1} earlier chord(s) did land` : "";
      const at = positionOf(now, want) + 1;
      // Three distinguishable outcomes, and each names a different thing to do.
      if (now.digest === before.digest) {
        // Nothing moved at all: the app declined (and beeped once). It only does
        // that at the end of what it is rendering, so either the row is already
        // there or the list is not the one the plan modelled.
        return {
          ok: false,
          chords,
          detail:
            `${chordGlyph(plan.chord)} did not move the to-do — it is still at position ` +
            `${at} of ${now.rows.length}, and Things declined the keystroke. The drive stopped ` +
            `rather than re-send it${landed}`,
        };
      }
      if (at === positionOf(before, want) + 1) {
        // It moved on SCREEN and not in this list: the row it passed belongs to
        // something else the view is showing. Nothing is mis-placed — the row is
        // one screen slot along, inside the same container — but the drive
        // cannot promise the next chord lands either, so it stops here.
        return {
          ok: false,
          chords,
          detail:
            `${chordGlyph(plan.chord)} moved the to-do one place on screen but not within this ` +
            `list — the row above it on screen is not the row above it in this list, so the ` +
            `list Things is showing holds more than the ${now.rows.length} to-do(s) being ` +
            `reordered. The drive stopped rather than keep sending keystrokes it cannot ` +
            `account for${landed}`,
        };
      }
      return {
        ok: false,
        chords,
        detail:
          `${chordGlyph(plan.chord)} moved the to-do to position ${at}, not the expected ` +
          `${plan.landsAt + 1} — the drive stopped rather than continue from a position it ` +
          `cannot vouch for${landed}`,
      };
    }

    // (4) The single-row-write, containment and umd laws, per chord.
    const violation = todoSingleRowWriteViolation(before, after, want, plan.landsAt);
    if (violation !== null) {
      return {
        ok: false,
        chords,
        detail: `${chordGlyph(plan.chord)} did not behave as a single-row move — ${violation}. The drive stopped`,
      };
    }
  }

  const finalOrder = orderOf(ctx.state());
  if (!sameOrder(finalOrder, target)) {
    return {
      ok: false,
      chords,
      detail: `the drive ended in an order that is not the requested one (after ${chords} chord(s))`,
    };
  }
  return { ok: true, chords, detail: `${chords} chord(s) posted` };
}
