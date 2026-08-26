/**
 * Within-project HEADING ORDER on the arrow-chord vector (CHORDMH1, built on
 * the HEADORD1 law — docs/lab/headord1-heading-order.md, docs/lab/chordmh1-move-heading-build.md).
 *
 * THE LAW THIS RIDES (measured, Things 3.23 / golden-v4, HEADORD1 cells 1e /
 * 1g1–1g4 / 1h / 1i3):
 *
 *   With a heading row selected in its project view, ⌘↑ / ⌘↓ move that heading
 *   one slot up / down and ⌘⌥↑ / ⌘⌥↓ move it to the top / bottom of the
 *   project's heading list. The move rewrites the MOVED heading's `index` and
 *   nothing else: no sibling heading, loose to-do or child row is renumbered,
 *   and the heading's children follow through their intact heading FK. A chord
 *   with nowhere to go is DECLINED — zero delta, one macOS alert beep. The
 *   chords carry no menu item and no AX action; they are bare keybindings.
 *
 * WHY THIS FILE IS A CLOSED LOOP AND NOT A KEYSTROKE MACRO. Two facts force it.
 * A bare keybinding on an undocumented private surface has no contract at all
 * (harness.md §AX-drive scrutiny), so nothing may be assumed to have happened
 * because a chord was posted — the DATABASE is the only oracle. And a chord the
 * app declines costs the user an audible error tone, so the move count must be
 * COMPUTED from the pre-state rather than discovered by firing until nothing
 * changes (HEADORD1 cell 1h5: six wasted chords, six beeps, all writes green).
 *
 * So each step is: read the order from the database → compute the ONE chord that
 * advances it → post exactly that chord → read the order back and prove the
 * intended heading moved exactly one slot (or reached the endpoint) with every
 * other row's `index` byte-identical and every child still behind its heading FK.
 * A step that produces NO delta stops the drive and names the boundary; it is
 * never re-fired blind. A step that produces the WRONG delta stops the drive and
 * reports what actually moved. Both are the over-caution direction the doctrine
 * requires: a refused drive is a bug report, a mis-landed write is corruption.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { UiCommand, UiRunner, UiRunResult } from "./ui.ts";

// ------------------------------------------------------------------- types

/** The move a `chord-reorder` step performs, compiled from the pre-state. */
export interface HeadingChordSpec {
  /** The project whose headings are being reordered. */
  projectUuid: string;
  /**
   * EVERY non-trashed heading of the project, in the order they must end up in
   * — the full end state, not just the moved block. The driver places them
   * left to right, so this doubles as the verification target.
   */
  targetOrder: string[];
  /**
   * The headings the caller named. Only these may ever be chorded: if the
   * driver's placement walk would have to move a heading the caller did not
   * name, it refuses rather than touch a bystander.
   */
  movees: string[];
  /** The project view's content table (the recipe supplies the one path). */
  tablePath: string;
}

/** The database read the driver asserts against between chords. */
export interface HeadingOrderState {
  /** The project's non-trashed headings in `index` order, with their raw index. */
  headings: { uuid: string; index: number }[];
  /**
   * Digest over every non-trashed child of those headings: `uuid:headingFK:index`.
   * The chord law says children are untouched behind their FK — this is what
   * proves it, and what catches the one measured hazard in the family (a row
   * driven across a heading boundary has its heading FK rewritten, HEADORD1 §2
   * cells 1h4/1i2; it cannot happen to a heading, and this asserts that).
   */
  childDigest: string;
  /** How many child rows the digest covers (reported in the failure text). */
  childCount: number;
}

/** The database seam the chord driver reads its ground truth through. */
export type HeadingOrderReader = (projectUuid: string) => HeadingOrderState;

/** The client-side default: heading order + child containment, from the open DB. */
export function createHeadingOrderReader(db: DatabaseSync): HeadingOrderReader {
  return (projectUuid: string): HeadingOrderState => {
    const headings = db
      .prepare(
        `SELECT uuid, "index" AS idx FROM TMTask
          WHERE type = 2 AND trashed = 0 AND project = ? ORDER BY "index", uuid`,
      )
      .all(projectUuid) as unknown as { uuid: string; idx: number }[];
    const children = db
      .prepare(
        `SELECT c.uuid AS uuid, c.heading AS h, c."index" AS idx FROM TMTask c
          JOIN TMTask hh ON c.heading = hh.uuid
          WHERE hh.project = ? AND hh.type = 2 AND c.trashed = 0
          ORDER BY c.uuid`,
      )
      .all(projectUuid) as unknown as { uuid: string; h: string; idx: number }[];
    const hash = createHash("sha256");
    for (const row of children) hash.update(`${row.uuid}:${row.h}:${row.idx}\n`);
    return {
      headings: headings.map((h) => ({ uuid: h.uuid, index: h.idx })),
      childDigest: hash.digest("hex"),
      childCount: children.length,
    };
  };
}

// -------------------------------------------------- the chord command shapes

/**
 * The four chords, as `(key code, CGEventFlags)` pairs. `126`/`125` are the
 * arrow keys; `0x100000` is `kCGEventFlagMaskCommand` and `0x80000`
 * `kCGEventFlagMaskAlternate`. Named rather than inlined so the recipe trace and
 * the failure text can say which chord was posted.
 */
export type ChordId = "up-one" | "down-one" | "to-top" | "to-bottom";

const CHORDS: Record<ChordId, { code: number; flags: number; glyph: string }> = {
  "up-one": { code: 126, flags: 0x100000, glyph: "⌘↑" },
  "down-one": { code: 125, flags: 0x100000, glyph: "⌘↓" },
  "to-top": { code: 126, flags: 0x180000, glyph: "⌘⌥↑" },
  "to-bottom": { code: 125, flags: 0x180000, glyph: "⌘⌥↓" },
};

export function chordGlyph(id: ChordId): string {
  return CHORDS[id].glyph;
}

/**
 * Post ONE modifier-bearing key event pair straight at the Things process
 * (`CGEventPostToPid`), through the same JXA ObjC bridge every other synthetic
 * input in this codebase rides.
 *
 * Why not System Events. The shipped `key` primitive emits `key code N` with no
 * modifier support at all, and the System-Events spelling that DOES carry
 * modifiers only lands while Things is FRONTMOST (HEADORD1 cell 1h2b: with
 * Finder frontmost it produced no delta). `CGEventPostToPid` addresses the
 * process rather than the focused surface, so the whole gesture — reveal,
 * select, chord — runs with Things in the background and the user's focus
 * untouched. Measured on Things 3.23 / golden-v4 (HEADORD1 1h2a; re-measured end
 * to end, with Things never activated at all, by CHORDMH1's delivery gate).
 *
 * Note this is the KEYBOARD tap only. NATIVE1-e measured `CGEventPostToPid` as
 * inert for Things' MOUSE hit-testing, which is why click synthesis still uses
 * the HID tap and stays foreground-bound; keyboard events to the pid are a
 * different path and do land.
 */
export function jxaChordScript(id: ChordId): string {
  const { code, flags } = CHORDS[id];
  return `ObjC.import('AppKit'); ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
function pidOf(n){ return Application('System Events').processes.byName(n).unixId() }
function sleepMs(ms){ $.NSThread.sleepForTimeInterval(ms/1000) }
function run(){
  var pid = pidOf('Things3');
  if (!pid) return 'NOPID';
  var d = $.CGEventCreateKeyboardEvent($(), ${code}, true);
  var u = $.CGEventCreateKeyboardEvent($(), ${code}, false);
  $.CGEventSetFlags(d, ${flags}); $.CGEventSetFlags(u, ${flags});
  $.CGEventPostToPid(pid, d); sleepMs(70);
  $.CGEventPostToPid(pid, u); sleepMs(70);
  return 'POSTED';
}`;
}

export function chordCommand(id: ChordId): UiCommand {
  return {
    primitive: "chord-post",
    label: `post ${CHORDS[id].glyph} to the Things process`,
    lang: "javascript",
    script: jxaChordScript(id),
    meta: { chord: id, code: CHORDS[id].code, flags: CHORDS[id].flags },
  };
}

/** Select the Nth heading row of the revealed project view (the shipped primitive). */
export function chordSelectCommand(tablePath: string, ordinal: number, script: string): UiCommand {
  return {
    primitive: "select-heading-row",
    label: `select the heading row at position ${ordinal + 1}`,
    script,
    meta: { ordinal },
  };
}

// -------------------------------------------------------------- the ladder

/**
 * Absolute backstop on posted chords. The placement walk below is O(n²) hops in
 * the worst case (every heading reversed), and the per-step progress guard
 * already stops a drive that is not converging — this only bounds a pathological
 * request. 200 chords at ~100ms is well inside the drive budget.
 */
const MAX_CHORDS_CEILING = 200;
/** DB assert poll after a chord: attempts × delay (Things writes `index` on the move). */
const ASSERT_ATTEMPTS = 12;
const ASSERT_DELAY_MS = 250;
const STEP_TIMEOUT_MS = 30_000;

export interface ChordDriveResult {
  ok: boolean;
  /** Human-readable outcome (chords posted) or the refusal reason. */
  detail: string;
  /** How many chords were posted before the outcome (partial-state honesty). */
  chords: number;
}

interface ChordCtx {
  run: UiRunner;
  state: () => HeadingOrderState;
  sleep: (ms: number) => Promise<void>;
  selectScript: (ordinal: number) => string;
}

async function runCmd(ctx: ChordCtx, cmd: UiCommand): Promise<UiRunResult> {
  return ctx.run(cmd, STEP_TIMEOUT_MS);
}

function orderOf(state: HeadingOrderState): string[] {
  return state.headings.map((h) => h.uuid);
}

function positionOf(state: HeadingOrderState, uuid: string): number {
  return state.headings.findIndex((h) => h.uuid === uuid);
}

function indexOf(state: HeadingOrderState, uuid: string): number | null {
  return state.headings.find((h) => h.uuid === uuid)?.index ?? null;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

/**
 * The SINGLE-ROW-WRITE law, asserted per chord (RRF1's untouched-siblings law in
 * the shape the app actually implements it). Returns a complaint, or null.
 *
 * HEADORD1 recorded the law as "the moved heading's `index` is rewritten and no
 * sibling is renumbered", measured on a ⌘↑. CHORDMH1's certification found that
 * is half of it: which of the two swapped rows gets the new number depends on
 * the direction. Moving a heading UP rewrites the MOVER (it takes a value
 * between its new neighbours: `C 0 → -343`, between `A -532` and `B -246`);
 * moving one DOWN rewrites the SIBLING it passes (that sibling takes a value
 * below the mover: `B -201 → -1152`, below `A -543`, which itself did not move).
 * The ⌘⌥ endpoint chords rewrite the mover. In every measured case exactly ONE
 * row is renumbered — the app picks whichever single write is cheapest — and it
 * is always one of the rows the gesture actually passed over.
 *
 * So the assertion is: the order must be EXACTLY the order the chord was
 * supposed to produce, exactly ONE heading's `index` may differ, and that
 * heading must lie inside the span the move crossed. Anything else — two rows
 * renumbered, a row outside the span renumbered, an unexpected order — is the
 * signature of a chord that landed on a row the plan did not address, which is
 * the one failure a positional heading selection cannot rule out by readback (a
 * heading exposes no title to the Accessibility tree, so the readback proves
 * only that A heading is selected, never WHICH — HEADCERT1).
 */
function singleRowWriteViolation(
  before: HeadingOrderState,
  after: HeadingOrderState,
  moved: string,
  landsAt: number,
): string | null {
  const beforeOrder = orderOf(before);
  const from = beforeOrder.indexOf(moved);
  const expected = beforeOrder.filter((u) => u !== moved);
  expected.splice(landsAt, 0, moved);
  const observed = orderOf(after);
  if (!sameOrder(observed, expected)) {
    return `the heading order after the chord is not the order the step aimed for (${observed.join(" < ")})`;
  }
  const lo = Math.min(from, landsAt);
  const hi = Math.max(from, landsAt);
  const spanned = new Set(beforeOrder.slice(lo, hi + 1));
  const rewritten: string[] = [];
  for (const row of before.headings) {
    const now = after.headings.find((h) => h.uuid === row.uuid);
    if (now === undefined) return `heading ${row.uuid} disappeared from the project`;
    if (now.index !== row.index) rewritten.push(row.uuid);
  }
  const outside = rewritten.filter((u) => !spanned.has(u));
  if (outside.length > 0) {
    return `it also renumbered heading ${outside[0]}, which the move never passed over`;
  }
  if (rewritten.length > 1) {
    return `it renumbered ${rewritten.length} headings at once (${rewritten.join(", ")}) — a chord rewrites exactly one row`;
  }
  return null;
}

/** Poll the database until `check` passes, or the attempts run out. */
async function pollState(
  ctx: ChordCtx,
  check: (state: HeadingOrderState) => boolean,
): Promise<HeadingOrderState | null> {
  for (let i = 0; i < ASSERT_ATTEMPTS; i++) {
    const state = ctx.state();
    if (check(state)) return state;
    // polling the same database condition is inherently sequential
    await ctx.sleep(ASSERT_DELAY_MS);
  }
  return null;
}

/** One scheduled step: which heading to chord, with what, and where it must land. */
export interface ChordStep {
  /** The heading to select and move — ALWAYS one the caller named. */
  uuid: string;
  chord: ChordId;
  /** The position the heading must occupy afterwards (the progress assertion). */
  landsAt: number;
}

/**
 * The next chord that advances `order` towards `target`, or null when they
 * already agree. `movees` is the only set of rows a chord may ever move.
 *
 * THE SCHEDULE, and why it is this one. The obvious walk — "put target[i] into
 * slot i, left to right" — is WRONG here, because target[i] is very often a row
 * the caller never named: asking to move heading A down one slot produces a
 * target whose first element is the BYSTANDER B. Moving B is not an option (it
 * would break the untouched-siblings law the whole vector rests on), and the
 * equally obvious repair — "push whichever movee sits at slot i down" — thrashes
 * forever when two movees sit side by side, each pushing the other back.
 *
 * So the rule fixes the first mismatched slot `i` from the row's own side:
 *
 *  - target[i] IS a movee → it is necessarily BELOW slot i (everything above
 *    already matches), so step it UP; from slot 0 the one-dispatch ⌘⌥↑ takes it
 *    there directly.
 *  - target[i] is a bystander `R` → every row between slot i and R's current
 *    position is provably a movee (the non-movees keep their relative order, so
 *    R is the first non-movee at or below i), and pushing the ONE movee directly
 *    above R down past it moves R up by exactly one slot.
 *
 * Both branches strictly reduce a distance that cannot go below zero, so the
 * schedule terminates, and every chord it emits moves a named heading by one
 * slot. Two endpoint shortcuts run first, because they are the common single
 * heading requests and each costs one dispatch instead of a walk: a movee whose
 * target is the very top or the very bottom is sent there with ⌘⌥↑ / ⌘⌥↓.
 */
export function planChordStep(
  order: readonly string[],
  target: readonly string[],
  movees: ReadonlySet<string>,
): ChordStep | { error: string } | null {
  const last = target.length - 1;
  // Endpoint shortcuts, taken before the walk.
  const top = target[0];
  if (top !== undefined && movees.has(top) && order[0] !== top) {
    return { uuid: top, chord: "to-top", landsAt: 0 };
  }
  const bottom = target[last];
  if (bottom !== undefined && movees.has(bottom) && order[last] !== bottom) {
    return { uuid: bottom, chord: "to-bottom", landsAt: last };
  }
  for (let i = 0; i <= last; i++) {
    const want = target[i] as string;
    if (order[i] === want) continue;
    const at = order.indexOf(want);
    if (at < 0) return { error: `heading ${want} is no longer in the project` };
    if (movees.has(want)) {
      // Below slot i by construction — step it up one.
      return { uuid: want, chord: "up-one", landsAt: at - 1 };
    }
    // A bystander has to rise: push the movee immediately above it down past it.
    const pusher = order[at - 1];
    if (pusher === undefined || !movees.has(pusher)) {
      return {
        error:
          `reaching the requested order would mean moving heading ${pusher ?? want}, which was ` +
          "not one of the headings named in the move",
      };
    }
    return { uuid: pusher, chord: "down-one", landsAt: at };
  }
  return null;
}

/**
 * Drive a project's headings into `spec.targetOrder`, one verified chord at a
 * time (see {@link planChordStep} for the schedule). Nothing here trusts the
 * plan it made a moment ago: every step is re-derived from a fresh database
 * read, and the step is only counted once the database says it landed where it
 * was aimed with nothing else touched.
 */
export async function driveHeadingChordReorder(
  spec: HeadingChordSpec,
  run: UiRunner,
  reader: HeadingOrderReader | undefined,
  selectScript: (ordinal: number) => string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ChordDriveResult> {
  if (reader === undefined) {
    return {
      ok: false,
      chords: 0,
      detail:
        "the heading-order driver has no database seam on this surface — this operation can " +
        "only run through the full client",
    };
  }
  const ctx: ChordCtx = {
    run,
    state: () => reader(spec.projectUuid),
    sleep,
    selectScript,
  };
  const pre = ctx.state();
  const target = spec.targetOrder;

  // The order was computed from a read taken before the GUI was touched; if the
  // project's heading SET has changed since (another client, or the app), the
  // whole plan — including every positional row address in it — is stale. Refuse.
  const preOrder = orderOf(pre);
  if (
    preOrder.length !== target.length ||
    !preOrder.every((u) => target.includes(u)) ||
    !target.every((u) => preOrder.includes(u))
  ) {
    return {
      ok: false,
      chords: 0,
      detail:
        `the project's headings changed between planning and driving (planned for ` +
        `${target.length}, found ${preOrder.length}) — nothing was moved; re-read the project ` +
        "and reissue the move",
    };
  }
  if (sameOrder(preOrder, target)) {
    return { ok: true, chords: 0, detail: "already in the requested order — no chord was sent" };
  }

  const moveeSet = new Set(spec.movees);
  const cap = Math.min(MAX_CHORDS_CEILING, target.length * target.length + target.length);
  let chords = 0;
  /** Which heading the last select landed on — the selection FOLLOWS the row it moves. */
  let selected: string | null = null;

  for (;;) {
    const before = ctx.state();
    const plan = planChordStep(orderOf(before), target, moveeSet);
    if (plan === null) break;
    if ("error" in plan) {
      return {
        ok: false,
        chords,
        detail: `${plan.error} — refusing to reorder a bystander`,
      };
    }
    if (chords >= cap) {
      return {
        ok: false,
        chords,
        detail: `the move exceeded its chord budget (${cap}) without reaching the requested order`,
      };
    }
    const want = plan.uuid;
    const cur = positionOf(before, want);

    // (1) Selection. The row a chord moves stays selected as it moves (HEADORD1
    //     cell 1h5 fired ten chords on one selection), so a run of hops on the
    //     same heading costs ONE positional walk — which is where essentially
    //     all the wall time goes (~0.25s per row the walk probes).
    if (selected !== want) {
      const sel = await runCmd(ctx, chordSelectCommand(spec.tablePath, cur, ctx.selectScript(cur)));
      if (!sel.ok || sel.stdout.trim() !== "OK") {
        return {
          ok: false,
          chords,
          detail:
            `the project view exposed no selectable heading row at position ${cur + 1} ` +
            `(${sel.ok ? sel.stdout.trim() || "no match" : sel.stderr.trim() || "the selection step failed"})` +
            (chords > 0 ? ` — ${chords} chord(s) had already landed` : " — nothing was moved"),
        };
      }
      selected = want;
    }

    // (2) Exactly one chord, chosen from the database, never fired blind.
    const post = await runCmd(ctx, chordCommand(plan.chord));
    chords += 1;
    if (!post.ok) {
      return {
        ok: false,
        chords,
        detail: `posting ${chordGlyph(plan.chord)} to Things failed (${post.stderr.trim() || "no detail"})`,
      };
    }

    // (3) The database is the oracle. STRICT progress: the heading must be at
    //     the slot the chord was supposed to put it in.
    const after = await pollState(ctx, (s) => positionOf(s, want) === plan.landsAt);
    if (after === null) {
      const now = ctx.state();
      const stalled = indexOf(now, want) === indexOf(before, want);
      return {
        ok: false,
        chords,
        detail: stalled
          ? `${chordGlyph(plan.chord)} did not move the heading — it is at position ` +
            `${positionOf(now, want) + 1} of ${now.headings.length} and the app declined the ` +
            "chord (a heading at the top declines ⌘↑ and one at the bottom declines ⌘↓), or the " +
            "row selection was lost. The drive stopped rather than re-sending it" +
            (chords > 1 ? `; ${chords - 1} earlier chord(s) did land` : "")
          : `${chordGlyph(plan.chord)} moved the heading to position ` +
            `${positionOf(now, want) + 1}, not the expected ${plan.landsAt + 1} — the drive ` +
            "stopped rather than continue from a position it cannot vouch for",
      };
    }

    // (4) The single-row-write law and the children law, per chord.
    const violation = singleRowWriteViolation(before, after, want, plan.landsAt);
    if (violation !== null) {
      return {
        ok: false,
        chords,
        detail:
          `${chordGlyph(plan.chord)} did not behave as a single-row move — ${violation}. The row ` +
          "that was selected may not be the row the plan addressed; the drive stopped",
      };
    }
    if (after.childDigest !== before.childDigest) {
      return {
        ok: false,
        chords,
        detail:
          `${chordGlyph(plan.chord)} changed a to-do's heading or position (${before.childCount} ` +
          `child row(s) before, ${after.childCount} after) — a heading move must leave every ` +
          "child untouched behind its heading link. The drive stopped",
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
  return {
    ok: true,
    chords,
    detail: `${chords} chord(s) posted`,
  };
}
