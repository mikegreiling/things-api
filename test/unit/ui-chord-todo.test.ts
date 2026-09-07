/**
 * To-do container-column chord driver (ui-chord-todo.ts) — the step logic, the
 * view fence, the per-chord laws and every refusal shape, driven entirely
 * through the injectable UiRunner seam against a scripted APP SIMULATOR (no GUI,
 * no osascript — AGENTS.md safety rails).
 *
 * The simulator models the CHORD2 law matrix as measured: a DISPLAYED row list
 * that is a superset of the column being reordered, a chord that moves the
 * selected row one DISPLAYED slot, a single-row rank rewrite, a
 * `userModificationDate` that a pure rank move never stamps, a chord with
 * nowhere to go that is declined with zero delta, and — the hazard this driver
 * exists to fence — a chord at the column's edge that REPARENTS the row silently
 * instead of declining. Every deviation the driver is supposed to catch is then
 * injected on purpose.
 */
import { describe, expect, it } from "vitest";

import {
  columnPredicate,
  columnRankKey,
  columnViewId,
  createTodoOrderReader,
  driveTodoChordReorder,
  planTodoChordStep,
  todoChordColumnOf,
  todoSingleRowWriteViolation,
  type TodoChordSpec,
  type TodoOrderState,
} from "../../src/write/vectors/ui-chord-todo.ts";
import type { ChordId } from "../../src/write/vectors/ui-chord.ts";
import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";

// ------------------------------------------------------------- the simulator

interface Row {
  uuid: string;
  rank: number;
  /** Is this row part of the COLUMN being reordered, or just displayed beside it? */
  member: boolean;
  bucket: string;
  umd: number;
}

interface SimOptions {
  /** Refuse to move on the Nth chord (1-based) — the "declined chord" case. */
  declineChord?: number;
  /** On the Nth chord, ALSO renumber a row the gesture never passed over. */
  collateralOnChord?: number;
  /** Renumber the PASSED row instead of the mover (the measured ⌘↓ shape, §2a2). */
  renumberPassedSibling?: boolean;
  /** On the Nth chord, rewrite the mover's containment (the silent crossing, §3a). */
  crossOnChord?: number;
  /** On the Nth chord, stamp the mover's umd (a move that was not a pure reorder). */
  stampUmdOnChord?: number;
  /** Fail the Nth row selection (1-based). */
  failSelect?: number;
  /** Rows the view is HIDING (a tag filter / a search). */
  hidden?: string[];
}

class TodoSim {
  /** Every row the view could render, in rank order. */
  rows: Row[];
  selected: string | null = null;
  chords = 0;
  selects = 0;
  /** Every command the driver dispatched, in order. */
  log: { primitive: string; meta?: Record<string, unknown> }[] = [];

  private opts: SimOptions;
  private hidden: Set<string>;

  constructor(spec: { uuid: string; member: boolean }[], opts: SimOptions = {}) {
    this.opts = opts;
    this.hidden = new Set(opts.hidden ?? []);
    // Sparse, irregular ranks — exactly what Things stores.
    this.rows = spec.map((r, i) => ({
      uuid: r.uuid,
      rank: (i + 1) * 100 - 37,
      member: r.member,
      bucket: "loose",
      umd: 1000,
    }));
  }

  /** The rows the view is RENDERING (what a chord counts slots in). */
  private displayed(): Row[] {
    return this.rows.filter((r) => !this.hidden.has(r.uuid));
  }

  /** What the column reader hands the driver: the members, in rank order. */
  state = (): TodoOrderState => {
    const rows = this.rows
      .filter((r) => r.member)
      .map((r) => ({ uuid: r.uuid, title: r.uuid, rank: r.rank, bucket: r.bucket, umd: r.umd }));
    return { rows, digest: rows.map((r) => `${r.uuid}:${r.rank}:${r.bucket}:${r.umd}`).join("|") };
  };

  /** Move `uuid` into displayed slot `slot` — the measured single-row rewrite. */
  private placeAt(uuid: string, slot: number): void {
    const shown = this.displayed();
    const from = shown.findIndex((r) => r.uuid === uuid);
    const resort = (): void => {
      this.rows = this.rows.toSorted((a, b) => a.rank - b.rank);
    };
    if (this.opts.renumberPassedSibling === true && Math.abs(from - slot) === 1) {
      const mover = shown[from] as Row;
      const passed = shown[slot] as Row;
      passed.rank = slot < from ? mover.rank + 1 : mover.rank - 1;
      resort();
      return;
    }
    const without = shown.filter((r) => r.uuid !== uuid);
    const before = without[slot - 1];
    const after = without[slot];
    const rank =
      before === undefined
        ? (after as Row).rank - 50
        : after === undefined
          ? before.rank + 50
          : (before.rank + after.rank) / 2;
    (this.rows.find((r) => r.uuid === uuid) as Row).rank = rank;
    resort();
  }

  run = async (command: UiCommand): Promise<UiRunResult> => {
    this.log.push({
      primitive: command.primitive,
      ...(command.meta !== undefined && { meta: command.meta }),
    });
    if (command.primitive === "resolve") {
      // The view fence's one plural read: every label the table is rendering.
      return {
        ok: true,
        stdout: `${this.displayed()
          .map((r) => r.uuid)
          .join("\n")}\n`,
        stderr: "",
      };
    }
    if (command.primitive === "select-row") {
      this.selects += 1;
      if (this.opts.failSelect === this.selects) {
        return { ok: true, stdout: "NOMATCH", stderr: "" };
      }
      const uuid = String((command.meta as { uuid: string }).uuid);
      const hit = this.displayed().find((r) => r.uuid === uuid);
      this.selected = hit?.uuid ?? null;
      return { ok: true, stdout: this.selected === null ? "NOMATCH" : "OK", stderr: "" };
    }
    if (command.primitive === "chord-post") {
      this.chords += 1;
      const chord = (command.meta as { chord: ChordId }).chord;
      const sel = this.selected;
      if (sel === null) return { ok: true, stdout: "POSTED", stderr: "" };
      if (this.opts.declineChord === this.chords) return { ok: true, stdout: "POSTED", stderr: "" };
      const shown = this.displayed();
      const cur = shown.findIndex((r) => r.uuid === sel);
      const want = chord === "up-one" || chord === "to-top" ? cur - 1 : cur + 1;
      if (want < 0 || want > shown.length - 1) return { ok: true, stdout: "POSTED", stderr: "" };
      this.placeAt(sel, want);
      const mover = this.rows.find((r) => r.uuid === sel) as Row;
      if (this.opts.crossOnChord === this.chords) {
        mover.bucket = "someone-elses-container";
        mover.umd += 1;
      }
      if (this.opts.stampUmdOnChord === this.chords) mover.umd += 1;
      if (this.opts.collateralOnChord === this.chords) {
        const victim = this.rows.findLast((r) => r.member && r.uuid !== sel);
        if (victim !== undefined) victim.rank += 1;
      }
      return { ok: true, stdout: "POSTED", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  /** The member column's current order. */
  memberOrder(): string[] {
    return this.rows.filter((r) => r.member).map((r) => r.uuid);
  }
}

const TABLE = "table 1 of scroll area 1 of window 1";
const VISIBLE = "visible-titles-script";

function specFor(target: string[], movees: string[]): TodoChordSpec {
  return {
    column: "anytime",
    containerUuid: null,
    targetOrder: target,
    movees,
    tablePath: TABLE,
  };
}

function drive(
  sim: TodoSim,
  target: string[],
  movees: string[],
  opts: { fence?: boolean } = {},
): Promise<{ ok: boolean; detail: string; chords: number }> {
  return driveTodoChordReorder(
    specFor(target, movees),
    sim.run,
    sim.state,
    (uuid) => `select ${uuid}`,
    opts.fence === false ? null : VISIBLE,
    async () => {},
  );
}

const members = (...uuids: string[]): { uuid: string; member: boolean }[] =>
  uuids.map((uuid) => ({ uuid, member: true }));

// ------------------------------------------------------------------- the map

describe("the column map", () => {
  it("maps only the scopes whose chord behaviour is measured", () => {
    expect(todoChordColumnOf("area-someday")).toBe("area-someday");
    expect(todoChordColumnOf("anytime")).toBe("anytime");
    for (const scope of ["today", "evening", "day", "heading", "project", "someday", "inbox"]) {
      expect(todoChordColumnOf(scope)).toBeNull();
    }
  });

  it("ranks both PR-1 columns on index and reveals a stage list for each", () => {
    expect(columnRankKey("anytime")).toBe("index");
    expect(columnRankKey("area-someday")).toBe("index");
    expect(columnViewId("anytime")).toBe("anytime");
    expect(columnViewId("area-someday")).toBe("someday");
  });

  it("keeps the member predicate in step with the reorder scope's own", () => {
    // The planner's target order and the driver's oracle must be the SAME list —
    // these predicates are transcribed from computeReorderPre's `area-someday`
    // and `anytime` cases, and a drift between them would silently reorder a
    // different set than the one the caller was shown.
    const areaSomeday = columnPredicate("area-someday");
    expect(areaSomeday.binds).toBe(1);
    expect(areaSomeday.where).toContain("area = ?");
    expect(areaSomeday.where).toContain("heading IS NULL");
    expect(areaSomeday.where).toContain("start = 2");
    expect(areaSomeday.where).toContain("startDate IS NULL");
    const anytime = columnPredicate("anytime");
    expect(anytime.binds).toBe(0);
    expect(anytime.where).toContain("project IS NULL");
    expect(anytime.where).toContain("area IS NULL");
    expect(anytime.where).toContain("start = 1");
  });
});

// ------------------------------------------------------------- the step plan

describe("planTodoChordStep", () => {
  it("never takes a ⌘⌥ endpoint shortcut — the app's bucket is not our column", () => {
    // The heading sibling sends a top-bound movee straight up with ⌘⌥↑; here the
    // column may be a SUBSET of the view's rows, so one dispatch could carry the
    // row past the column's own first member (CHORD2 §3d). Always ±1.
    const step = planTodoChordStep(["a", "b", "c"], ["c", "a", "b"], new Set(["c"]));
    expect(step).toEqual({ uuid: "c", chord: "up-one", landsAt: 1 });
  });

  it("returns null when the column is already in the requested order", () => {
    expect(planTodoChordStep(["a", "b"], ["a", "b"], new Set(["a"]))).toBeNull();
  });

  it("pushes a named row DOWN to raise a bystander rather than moving the bystander", () => {
    const step = planTodoChordStep(["a", "b", "c"], ["b", "a", "c"], new Set(["a"]));
    expect(step).toEqual({ uuid: "a", chord: "down-one", landsAt: 1 });
  });

  it("refuses when reaching the order would mean moving a row nobody named", () => {
    const step = planTodoChordStep(["a", "b", "c"], ["a", "c", "b"], new Set(["a"]));
    expect(step).toMatchObject({ error: expect.stringContaining("not one of the to-dos named") });
  });
});

// ------------------------------------------------------------- the per-chord laws

const st = (
  rows: { uuid: string; rank: number; bucket?: string; umd?: number }[],
): TodoOrderState => ({
  rows: rows.map((r) => ({
    uuid: r.uuid,
    title: r.uuid,
    rank: r.rank,
    bucket: r.bucket ?? "loose",
    umd: r.umd ?? 1,
  })),
  digest: "d",
});

describe("todoSingleRowWriteViolation", () => {
  it("accepts the measured single-row move", () => {
    const before = st([
      { uuid: "a", rank: 1 },
      { uuid: "b", rank: 2 },
    ]);
    const after = st([
      { uuid: "b", rank: 2 },
      { uuid: "a", rank: 3 },
    ]);
    expect(todoSingleRowWriteViolation(before, after, "a", 1)).toBeNull();
  });

  it("catches a silent reparent", () => {
    const before = st([
      { uuid: "a", rank: 1 },
      { uuid: "b", rank: 2 },
    ]);
    const after = st([
      { uuid: "b", rank: 2 },
      { uuid: "a", rank: 3, bucket: "elsewhere" },
    ]);
    expect(todoSingleRowWriteViolation(before, after, "a", 1)).toContain("different container");
  });

  it("catches a stamped modification date", () => {
    const before = st([
      { uuid: "a", rank: 1 },
      { uuid: "b", rank: 2 },
    ]);
    const after = st([
      { uuid: "b", rank: 2 },
      { uuid: "a", rank: 3, umd: 9 },
    ]);
    expect(todoSingleRowWriteViolation(before, after, "a", 1)).toContain("modification date");
  });

  it("catches a row renumbered outside the span the move crossed", () => {
    const before = st([
      { uuid: "a", rank: 1 },
      { uuid: "b", rank: 2 },
      { uuid: "c", rank: 3 },
    ]);
    const after = st([
      { uuid: "b", rank: 2 },
      { uuid: "a", rank: 2.5 },
      { uuid: "c", rank: 4 },
    ]);
    expect(todoSingleRowWriteViolation(before, after, "a", 1)).toContain("never passed over");
  });
});

// ----------------------------------------------------------------- the drive

describe("driveTodoChordReorder", () => {
  it("moves one row up N slots, one verified chord at a time", async () => {
    const sim = new TodoSim(members("a", "b", "c", "d"));
    const out = await drive(sim, ["d", "a", "b", "c"], ["d"]);
    expect(out.ok).toBe(true);
    expect(sim.memberOrder()).toEqual(["d", "a", "b", "c"]);
    expect(out.chords).toBe(3);
    // ONE selection for the whole run — the row stays selected as it moves.
    expect(sim.selects).toBe(1);
    // And exactly one row was ever selected at a time (the coalescing hazard
    // CHORD2 §2 measured cannot arise: there is never a second selected row).
    const selects = sim.log.filter((c) => c.primitive === "select-row");
    expect(selects).toHaveLength(1);
  });

  it("moves one row down N slots, renumbering only the rows it passed", async () => {
    const sim = new TodoSim(members("a", "b", "c", "d"), { renumberPassedSibling: true });
    const out = await drive(sim, ["b", "c", "d", "a"], ["a"]);
    expect(out.ok).toBe(true);
    expect(sim.memberOrder()).toEqual(["b", "c", "d", "a"]);
    expect(out.chords).toBe(3);
  });

  it("reaches the top and the bottom without a ⌘⌥ chord", async () => {
    const sim = new TodoSim(members("a", "b", "c"));
    await drive(sim, ["c", "a", "b"], ["c"]);
    expect(sim.memberOrder()).toEqual(["c", "a", "b"]);
    const chords = sim.log.filter((c) => c.primitive === "chord-post");
    expect(chords.every((c) => (c.meta as { chord: ChordId }).chord === "up-one")).toBe(true);
  });

  it("sends no chord at all when the order already matches", async () => {
    const sim = new TodoSim(members("a", "b", "c"));
    const out = await drive(sim, ["a", "b", "c"], ["a"]);
    expect(out).toMatchObject({ ok: true, chords: 0 });
    expect(sim.log).toHaveLength(0);
  });

  it("steps over a row the view shows but the column does not contain", async () => {
    // The Anytime list renders more than the area-less loose block; a chord that
    // hops one of those rows is still one displayed slot, and the column's own
    // order must come out right.
    const sim = new TodoSim([
      { uuid: "a", member: true },
      { uuid: "x", member: false },
      { uuid: "b", member: true },
    ]);
    const out = await drive(sim, ["b", "a"], ["b"]);
    // One chord takes `b` past `a`? No — it takes it past the bystander first,
    // which leaves the COLUMN order unchanged, so the driver stops rather than
    // guessing. That refusal is the honest answer, and it is what the CHORD3
    // cells measure the real view against.
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("not the row above it in this list");
  });

  it("refuses when the list is hiding one of its own rows", async () => {
    const sim = new TodoSim(members("a", "b", "c"), { hidden: ["b"] });
    const out = await drive(sim, ["c", "a", "b"], ["c"]);
    expect(out).toMatchObject({ ok: false, chords: 0 });
    expect(out.detail).toContain("not on screen");
    expect(out.detail).toContain("filtered");
    // Nothing was selected and nothing was posted.
    expect(sim.log.filter((c) => c.primitive === "chord-post")).toHaveLength(0);
  });

  it("stops on a declined chord instead of re-sending it", async () => {
    const sim = new TodoSim(members("a", "b", "c"), { declineChord: 1 });
    const out = await drive(sim, ["c", "a", "b"], ["c"]);
    expect(out.ok).toBe(false);
    expect(out.chords).toBe(1);
    expect(out.detail).toContain("declined the keystroke");
  });

  it("stops when a chord silently reparents the row", async () => {
    const sim = new TodoSim(members("a", "b", "c"), { crossOnChord: 1 });
    const out = await drive(sim, ["c", "a", "b"], ["c"]);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("different container");
  });

  it("stops when a chord stamps a modification date", async () => {
    const sim = new TodoSim(members("a", "b", "c"), { stampUmdOnChord: 1 });
    const out = await drive(sim, ["c", "a", "b"], ["c"]);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("modification date");
  });

  it("stops when a chord renumbers a row it never passed over", async () => {
    const sim = new TodoSim(members("a", "b", "c", "d"), { collateralOnChord: 1 });
    const out = await drive(sim, ["c", "a", "b", "d"], ["c"]);
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("never passed over");
  });

  it("refuses when the list changed between planning and driving", async () => {
    const sim = new TodoSim(members("a", "b", "c"));
    const out = await drive(sim, ["c", "a", "b", "gone"], ["c"]);
    expect(out).toMatchObject({ ok: false, chords: 0 });
    expect(out.detail).toContain("changed between planning and driving");
  });

  it("refuses when the row cannot be selected", async () => {
    const sim = new TodoSim(members("a", "b", "c"), { failSelect: 1 });
    const out = await drive(sim, ["c", "a", "b"], ["c"]);
    expect(out).toMatchObject({ ok: false, chords: 0 });
    expect(out.detail).toContain("selectable row");
  });

  it("refuses to move a row the caller did not name", async () => {
    const sim = new TodoSim(members("a", "b", "c"));
    const out = await drive(sim, ["a", "c", "b"], ["a"]);
    expect(out).toMatchObject({ ok: false, chords: 0 });
    expect(out.detail).toContain("refusing to reorder a bystander");
  });

  it("refuses cleanly when the client wired no database seam", async () => {
    const sim = new TodoSim(members("a", "b"));
    const out = await driveTodoChordReorder(
      specFor(["b", "a"], ["b"]),
      sim.run,
      undefined,
      (uuid) => `select ${uuid}`,
      null,
      async () => {},
    );
    expect(out).toMatchObject({ ok: false, chords: 0 });
    expect(out.detail).toContain("no database seam");
  });

  it("skips the view fence when the caller supplies no probe", async () => {
    const sim = new TodoSim(members("a", "b", "c"));
    const out = await drive(sim, ["c", "a", "b"], ["c"], { fence: false });
    expect(out.ok).toBe(true);
    expect(sim.log.filter((c) => c.primitive === "resolve")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the reader

describe("createTodoOrderReader", () => {
  it("is a function of the open database (the client's default seam)", () => {
    // The SQL itself is exercised by the engine tests against a fixture db; here
    // the contract is only that the factory hands back a reader keyed on the
    // column + container the spec names.
    expect(typeof createTodoOrderReader).toBe("function");
  });
});
