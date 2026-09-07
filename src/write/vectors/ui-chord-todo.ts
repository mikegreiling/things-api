/**
 * IN-CONTAINER TO-DO ORDER on the arrow-chord vector (CHORD2 — the full law
 * matrix, docs/lab/chord2-reorder-laws.md; built as CHORD3,
 * docs/lab/chord3-todo-chord-op.md).
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

import { chordCommand, chordGlyph, planChordStep, type ChordStep } from "./ui-chord.ts";
import type { UiCommand, UiRunner } from "./ui.ts";

// ------------------------------------------------------------------- types

/**
 * The container columns this vector re-ranks. Each names a MEMBER PREDICATE (the
 * rows the column contains) and the VIEW that renders them — the two facts the
 * chord needs, because the gesture moves a row one DISPLAYED slot and the
 * assertion is made against the member column.
 */
export type TodoChordColumn = "area-someday" | "anytime";

/**
 * The chord column a `reorder` SCOPE maps onto, or null when the scope has no
 * measured chord behaviour and must stay on its headless surface.
 *
 * The gate is evidence, not capability: the chord reaches every `index`-axis
 * container order in the app (CHORD2 §8.1), and the scopes are migrated one
 * certified batch at a time so each arrives with its own cell verdicts.
 */
export function todoChordColumnOf(scope: string): TodoChordColumn | null {
  return scope === "area-someday" || scope === "anytime" ? scope : null;
}

/** The rank column a {@link TodoChordColumn} is ordered on. */
export function columnRankKey(_column: TodoChordColumn): "index" | "todayIndex" {
  // Both PR-1 columns are `index` columns (CHORD2 §4: Someday and Anytime both
  // re-rank on `index`). The signature carries the day-axis columns that the
  // `today` / `evening` migration adds next.
  return "index";
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
 */
export function columnViewId(column: TodoChordColumn): string {
  return column === "area-someday" ? "someday" : "anytime";
}

/** The move a `chord-reorder-todo` step performs, compiled from the pre-state. */
export interface TodoChordSpec {
  column: TodoChordColumn;
  /** The area whose someday members are being reordered; null for `anytime`. */
  containerUuid: string | null;
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
   * measured crossing stamped it. The cheap tripwire for "did this chord
   * silently reparent something?".
   */
  umd: number | null;
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
}) => TodoOrderState;

/** `project|heading|area|start|startBucket` — see {@link TodoColumnRow.bucket}. */
const BUCKET_EXPR =
  "COALESCE(project,'')||'|'||COALESCE(heading,'')||'|'||COALESCE(area,'')||'|'||" +
  "COALESCE(start,-1)||'|'||COALESCE(startBucket,-1)";

/**
 * The member predicate per column — the SAME predicate `computeReorderPre` uses
 * for the scope, so the planner's target order and the driver's oracle are the
 * one list. Kept here as data so the two can be diff-tested against each other.
 */
export function columnPredicate(column: TodoChordColumn): { where: string; binds: number } {
  return column === "area-someday"
    ? {
        where:
          "type = 0 AND trashed = 0 AND status = 0 AND area = ? AND heading IS NULL " +
          "AND start = 2 AND startDate IS NULL",
        binds: 1,
      }
    : {
        where:
          "type = 0 AND trashed = 0 AND status = 0 AND project IS NULL AND area IS NULL " +
          "AND heading IS NULL AND start = 1 AND startDate IS NULL",
        binds: 0,
      };
}

/** The client-side default: the column's members + their crossing tripwires. */
export function createTodoOrderReader(db: DatabaseSync): TodoOrderReader {
  return ({ column, containerUuid }): TodoOrderState => {
    const { where, binds } = columnPredicate(column);
    const rankCol = columnRankKey(column) === "index" ? `"index"` : "todayIndex";
    const rows = db
      .prepare(
        `SELECT uuid, COALESCE(title,'') AS title, ${rankCol} AS rank, ${BUCKET_EXPR} AS bucket, ` +
          `userModificationDate AS umd FROM TMTask WHERE ${where} ORDER BY ${rankCol}, uuid`,
      )
      .all(...(binds === 1 ? [containerUuid ?? ""] : [])) as unknown as {
      uuid: string;
      title: string;
      rank: number;
      bucket: string;
      umd: number | null;
    }[];
    const hash = createHash("sha256");
    for (const r of rows) hash.update(`${r.uuid}:${r.rank}:${r.bucket}:${r.umd}\n`);
    return {
      rows: rows.map((r) => ({
        uuid: r.uuid,
        title: r.title,
        rank: r.rank,
        bucket: r.bucket,
        umd: r.umd,
      })),
      digest: hash.digest("hex"),
    };
  };
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
    state: () => reader({ column: spec.column, containerUuid: spec.containerUuid }),
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
