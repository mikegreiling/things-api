/**
 * Heading-order chord driver (ui-chord.ts) — the step logic, the chord budget,
 * the progress guard and every refusal shape, driven entirely through the
 * injectable UiRunner seam against a scripted APP SIMULATOR (no GUI, no
 * osascript — CLAUDE.md safety rails).
 *
 * The simulator models exactly the HEADORD1 law the driver is built on: a
 * selected heading row, four chords that move it ±1 / to an end, a SINGLE-ROW
 * `index` rewrite that slots the moved heading between its new neighbours
 * without renumbering anyone, children that never move, and a chord with
 * nowhere to go that is declined with zero delta. Every deviation the driver is
 * supposed to catch is then injected on purpose.
 */
import { describe, expect, it } from "vitest";

import {
  chordGlyph,
  createHeadingOrderReader,
  driveHeadingChordReorder,
  jxaChordScript,
  planChordStep,
  type ChordId,
  type HeadingChordSpec,
  type HeadingOrderState,
} from "../../src/write/vectors/ui-chord.ts";
import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";
import { buildFixtureDb } from "../fixtures/build-db.ts";
import { seedHeading, seedProject, seedTodo } from "../fixtures/seed.ts";

// ------------------------------------------------------------- the simulator

interface SimOptions {
  /** Refuse to move on the Nth chord (1-based) — the "declined chord" case. */
  declineChord?: number;
  /** On the Nth chord, ALSO renumber a heading the gesture never passed over. */
  collateralOnChord?: number;
  /** Renumber the PASSED sibling instead of the mover (the measured ⌘↓ shape). */
  renumberPassedSibling?: boolean;
  /** On the Nth chord, move a child's index (the children-touched case). */
  disturbChildOnChord?: number;
  /** Fail the Nth select-heading-row (1-based). */
  failSelect?: number;
  /** Move the selected heading by ±1 regardless of the chord (a lying app). */
  ignoreEndpointChords?: boolean;
  /**
   * Headings with a CLOSED status. They hold a slot in the one `index` axis but
   * render no content row, so they take no ordinal in the positional walk and a
   * live heading's ±1 skips straight over them (CHORD2 cell 7a′).
   */
  archived?: string[];
}

class HeadingSim {
  /** uuid → index, ordered by index — EVERY heading row, live and archived. */
  order: { uuid: string; index: number }[];
  childIndex = 0;
  selected: string | null = null;
  chords = 0;
  selects = 0;
  /** Every command the driver dispatched, in order. */
  log: { primitive: string; meta?: Record<string, unknown> }[] = [];

  private opts: SimOptions;
  private archived: Set<string>;

  constructor(uuids: string[], opts: SimOptions = {}) {
    this.opts = opts;
    this.archived = new Set(opts.archived ?? []);
    // Sparse, irregular indexes — exactly what Things stores.
    this.order = uuids.map((uuid, i) => ({ uuid, index: (i + 1) * 100 - 37 }));
  }

  /**
   * The RENDERED rows — the `index` axis filtered to the open headings. Every
   * ordinal the app exposes, and every slot a chord counts in, is a position in
   * THIS list; the archived rows are simply not there (CHORD2 cell 7a′).
   */
  private live(): { uuid: string; index: number }[] {
    return this.order.filter((h) => !this.archived.has(h.uuid));
  }

  /** What a `status = 0`-filtered reader hands the driver. */
  state(): HeadingOrderState {
    return {
      headings: this.live().map((h) => ({ uuid: h.uuid, index: h.index })),
      childDigest: `children@${this.childIndex}`,
      childCount: 3,
    };
  }

  /** An archived row's raw index — the byte the drive must never write. */
  indexOfRow(uuid: string): number | undefined {
    return this.order.find((h) => h.uuid === uuid)?.index;
  }

  /**
   * The measured single-row rewrite. Moving a row into `slot` — a position among
   * the LIVE rows — renumbers exactly ONE row: normally the mover (it takes a
   * value between its new RENDERED neighbours, which is how a ±1 hops straight
   * over an archived row's index in one dispatch); with `renumberPassedSibling`
   * it instead renumbers the sibling being passed on a ±1 swap, which is what
   * Things actually does on a ⌘↓ (CHORDMH1 arm 2).
   */
  private placeAt(uuid: string, slot: number): void {
    const live = this.live();
    const from = live.findIndex((h) => h.uuid === uuid);
    const resort = (): void => {
      this.order = this.order.toSorted((a, b) => a.index - b.index);
    };
    if (this.opts.renumberPassedSibling === true && Math.abs(from - slot) === 1) {
      const mover = live[from] as { uuid: string; index: number };
      const passed = live[slot] as { uuid: string; index: number };
      // The passed row takes a value on the mover's far side; the mover is untouched.
      passed.index = slot < from ? mover.index + 1 : mover.index - 1;
      resort();
      return;
    }
    const without = live.filter((h) => h.uuid !== uuid);
    const before = without[slot - 1];
    const after = without[slot];
    const index =
      before === undefined
        ? (after as { index: number }).index - 50
        : after === undefined
          ? before.index + 50
          : (before.index + after.index) / 2;
    (this.order.find((h) => h.uuid === uuid) as { index: number }).index = index;
    resort();
  }

  run = async (command: UiCommand): Promise<UiRunResult> => {
    this.log.push({
      primitive: command.primitive,
      ...(command.meta !== undefined && { meta: command.meta }),
    });
    if (command.primitive === "select-heading-row") {
      this.selects += 1;
      if (this.opts.failSelect === this.selects) {
        return { ok: true, stdout: "NOMATCH", stderr: "" };
      }
      const ordinal = Number((command.meta as { ordinal: number }).ordinal);
      // The walk enumerates the RENDERED rows and then NOMATCHes — an archived
      // heading is never reachable through any ordinal.
      this.selected = this.live()[ordinal]?.uuid ?? null;
      return { ok: true, stdout: this.selected === null ? "NOMATCH" : "OK", stderr: "" };
    }
    if (command.primitive === "chord-post") {
      this.chords += 1;
      const chord = (command.meta as { chord: ChordId }).chord;
      const sel = this.selected;
      if (sel === null) return { ok: true, stdout: "POSTED", stderr: "" };
      if (this.opts.declineChord === this.chords) {
        // The app declines: zero delta (and, on a real Mac, one alert beep).
        return { ok: true, stdout: "POSTED", stderr: "" };
      }
      // The chord counts slots in the RENDERED list, so a ±1 across an archived
      // row's slot is still one hop.
      const liveNow = this.live();
      const cur = liveNow.findIndex((h) => h.uuid === sel);
      const last = liveNow.length - 1;
      let want: number;
      if (this.opts.ignoreEndpointChords === true) {
        want = chord === "up-one" || chord === "to-top" ? cur - 1 : cur + 1;
      } else {
        want =
          chord === "to-top"
            ? 0
            : chord === "to-bottom"
              ? last
              : chord === "up-one"
                ? cur - 1
                : cur + 1;
      }
      if (want < 0 || want > last) return { ok: true, stdout: "POSTED", stderr: "" };
      this.placeAt(sel, want);
      if (this.opts.collateralOnChord === this.chords) {
        // A row at the far END of the list — one the gesture never passed over.
        const victim = this.live().findLast((h) => h.uuid !== sel);
        if (victim !== undefined) victim.index += 1;
      }
      if (this.opts.disturbChildOnChord === this.chords) this.childIndex += 1;
      return { ok: true, stdout: "POSTED", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  /** Every row in index order, archived included — the raw database order. */
  titles(): string[] {
    return this.order.map((h) => h.uuid);
  }

  /** The rendered order — what the user (and the driver) sees. */
  liveTitles(): string[] {
    return this.live().map((h) => h.uuid);
  }
}

const TABLE = "table 1 of scroll area 1 of window 1";

function specFor(target: string[], movees: string[]): HeadingChordSpec {
  return { projectUuid: "P", targetOrder: target, movees, tablePath: TABLE };
}

const noSleep = async (): Promise<void> => {};

async function drive(
  sim: HeadingSim,
  spec: HeadingChordSpec,
): ReturnType<typeof driveHeadingChordReorder> {
  return driveHeadingChordReorder(
    spec,
    (cmd) => sim.run(cmd),
    () => sim.state(),
    (ordinal) => `select ${ordinal}`,
    noSleep,
  );
}

/** Which chords the driver actually posted, in order. */
function chordsPosted(sim: HeadingSim): string[] {
  return sim.log
    .filter((c) => c.primitive === "chord-post")
    .map((c) => String((c.meta as { chord: string }).chord));
}

// ------------------------------------------------------------- step planning

const set = (...u: string[]): ReadonlySet<string> => new Set(u);

describe("planChordStep — the step schedule", () => {
  it("returns null once the order matches", () => {
    expect(planChordStep(["A", "B"], ["A", "B"], set("A"))).toBeNull();
  });

  it("takes the one-dispatch ⌘⌥ chord when the movee's target IS an endpoint", () => {
    expect(planChordStep(["A", "B", "C"], ["C", "A", "B"], set("C"))).toEqual({
      uuid: "C",
      chord: "to-top",
      landsAt: 0,
    });
    expect(planChordStep(["A", "B", "C"], ["B", "C", "A"], set("A"))).toEqual({
      uuid: "A",
      chord: "to-bottom",
      landsAt: 2,
    });
  });

  it("steps a movee UP one slot when the first mismatch IS the movee", () => {
    expect(planChordStep(["A", "B", "C"], ["A", "C", "B"], set("C"))).toEqual({
      uuid: "C",
      chord: "up-one",
      landsAt: 1,
    });
  });

  it("moves the MOVEE, never the bystander the target happens to name first", () => {
    // "move A down one" produces the target [B, A, C] — whose first element is a
    // heading the caller never named. The step must push A down, not lift B.
    expect(planChordStep(["A", "B", "C", "D"], ["B", "A", "C", "D"], set("A"))).toEqual({
      uuid: "A",
      chord: "down-one",
      landsAt: 1,
    });
  });

  it("refuses when reaching the target would need a bystander moved", () => {
    // B and C both have to move, but only C was named.
    const step = planChordStep(["A", "B", "C"], ["B", "C", "A"], set("C"));
    expect(step).toMatchObject({ error: expect.stringContaining("not one of the headings named") });
  });
});

describe("the posted chords", () => {
  it("carry the arrow key codes and the command / command+option flag masks", () => {
    expect(jxaChordScript("up-one")).toContain("126");
    expect(jxaChordScript("up-one")).toContain("1048576"); // kCGEventFlagMaskCommand
    expect(jxaChordScript("down-one")).toContain("125");
    expect(jxaChordScript("to-top")).toContain("1572864"); // command + option
    expect(jxaChordScript("to-bottom")).toContain("1572864");
  });

  it("post to the Things PROCESS, never the HID tap (the background-delivery claim)", () => {
    for (const id of ["up-one", "down-one", "to-top", "to-bottom"] as const) {
      expect(jxaChordScript(id)).toContain("CGEventPostToPid");
      expect(jxaChordScript(id)).not.toContain("kCGHIDEventTap");
    }
  });

  it("name themselves by glyph for the failure text", () => {
    expect(chordGlyph("up-one")).toBe("⌘↑");
    expect(chordGlyph("to-bottom")).toBe("⌘⌥↓");
  });
});

// --------------------------------------------------------------- happy paths

describe("driveHeadingChordReorder — the certified moves", () => {
  it("±1 up: one ⌘↑, one selection, one row rewritten", async () => {
    const sim = new HeadingSim(["A", "B", "C"]);
    const before = sim.state();
    const out = await drive(sim, specFor(["A", "C", "B"], ["C"]));
    expect(out.ok).toBe(true);
    expect(out.chords).toBe(1);
    expect(sim.titles()).toEqual(["A", "C", "B"]);
    expect(chordsPosted(sim)).toEqual(["up-one"]);
    // The single-row law: only the moved heading's index differs.
    const after = sim.state();
    for (const uuid of ["A", "B"]) {
      const pre = before.headings.find((h) => h.uuid === uuid)?.index;
      const post = after.headings.find((h) => h.uuid === uuid)?.index;
      expect(post).toBe(pre);
    }
  });

  it("±1 down: one ⌘↓", async () => {
    const sim = new HeadingSim(["A", "B", "C"]);
    const out = await drive(sim, specFor(["B", "A", "C"], ["A"]));
    expect(out.ok).toBe(true);
    expect(chordsPosted(sim)).toEqual(["down-one"]);
    expect(sim.titles()).toEqual(["B", "A", "C"]);
  });

  it("an ENDPOINT target is one dispatch, not a walk", async () => {
    const sim = new HeadingSim(["A", "B", "C", "D", "E"]);
    const out = await drive(sim, specFor(["E", "A", "B", "C", "D"], ["E"]));
    expect(out.ok).toBe(true);
    expect(chordsPosted(sim)).toEqual(["to-top"]);
    const sim2 = new HeadingSim(["A", "B", "C", "D", "E"]);
    const out2 = await drive(sim2, specFor(["B", "C", "D", "E", "A"], ["A"]));
    expect(out2.ok).toBe(true);
    expect(chordsPosted(sim2)).toEqual(["to-bottom"]);
  });

  it("a multi-hop to an INTERIOR slot walks ±1 and re-selects only once", async () => {
    const sim = new HeadingSim(["A", "B", "C", "D", "E"]);
    // A must end up between D and E — three ⌘↓ hops, one selection (the row
    // stays selected as it moves, HEADORD1 cell 1h5).
    const out = await drive(sim, specFor(["B", "C", "D", "A", "E"], ["A"]));
    expect(out.ok).toBe(true);
    expect(chordsPosted(sim)).toEqual(["down-one", "down-one", "down-one"]);
    expect(sim.selects).toBe(1);
    expect(sim.titles()).toEqual(["B", "C", "D", "A", "E"]);
  });

  it("a BLOCK move places each named heading and touches no bystander", async () => {
    const sim = new HeadingSim(["A", "B", "C", "D"]);
    const out = await drive(sim, specFor(["C", "D", "A", "B"], ["C", "D"]));
    expect(out.ok).toBe(true);
    expect(sim.titles()).toEqual(["C", "D", "A", "B"]);
  });

  it("accepts the app renumbering the PASSED SIBLING instead of the mover (CHORDMH1 arm 2)", async () => {
    // Things does not always renumber the row that moved: a ⌘↓ leaves the mover's
    // index alone and gives the sibling it passes a value below it (measured —
    // HEADORD1 had only ever measured a ⌘↑, which renumbers the mover). Either
    // shape is ONE row rewritten, and both are legal.
    const sim = new HeadingSim(["A", "B", "C"], { renumberPassedSibling: true });
    const before = sim.state();
    const out = await drive(sim, specFor(["B", "A", "C"], ["A"]));
    expect(out.ok).toBe(true);
    expect(sim.titles()).toEqual(["B", "A", "C"]);
    const after = sim.state();
    const rewritten = before.headings
      .filter((h) => after.headings.find((n) => n.uuid === h.uuid)?.index !== h.index)
      .map((h) => h.uuid);
    expect(rewritten).toEqual(["B"]);
  });

  it("CHORDMH2: a ±1 SKIPS an archived heading's slot in one chord, leaving its row untouched", async () => {
    // Live G1 < G2 < G3 < G4, with an archived row sitting between G2 and G3.
    // Moving G3 up one puts it between G1 and G2 — ONE ⌘↑ that hops straight over
    // the archived slot, exactly as measured (CHORD2 cell 7a′).
    const sim = new HeadingSim(["G1", "G2", "ARCH", "G3", "G4"], { archived: ["ARCH"] });
    const archBefore = sim.indexOfRow("ARCH");
    const out = await drive(sim, specFor(["G1", "G3", "G2", "G4"], ["G3"]));
    expect(out.ok).toBe(true);
    expect(out.chords).toBe(1);
    expect(chordsPosted(sim)).toEqual(["up-one"]);
    expect(sim.liveTitles()).toEqual(["G1", "G3", "G2", "G4"]);
    // The archived row's own index is never rewritten — the chord passed over it
    // without addressing it.
    expect(sim.indexOfRow("ARCH")).toBe(archBefore);
  });

  it("CHORDMH2: every row address is an ordinal in the LIVE list, never the raw one", async () => {
    // The archived row is at raw slot 1; the movee G3 is at raw slot 3 but at
    // RENDERED slot 2, and that is the ordinal the driver must select.
    const sim = new HeadingSim(["G1", "ARCH", "G2", "G3"], { archived: ["ARCH"] });
    const archBefore = sim.indexOfRow("ARCH");
    const out = await drive(sim, specFor(["G3", "G1", "G2"], ["G3"]));
    expect(out.ok).toBe(true);
    expect(chordsPosted(sim)).toEqual(["to-top"]);
    const ordinals = sim.log
      .filter((c) => c.primitive === "select-heading-row")
      .map((c) => (c.meta as { ordinal: number }).ordinal);
    expect(ordinals).toEqual([2]);
    expect(sim.liveTitles()).toEqual(["G3", "G1", "G2"]);
    expect(sim.indexOfRow("ARCH")).toBe(archBefore);
  });

  it("already in the requested order: zero chords, zero selections, zero beeps", async () => {
    const sim = new HeadingSim(["A", "B", "C"]);
    const out = await drive(sim, specFor(["A", "B", "C"], ["A"]));
    expect(out.ok).toBe(true);
    expect(out.chords).toBe(0);
    expect(out.detail).toContain("no chord was sent");
    expect(sim.log).toEqual([]);
  });
});

// ------------------------------------------------------------- the fail modes

describe("driveHeadingChordReorder — fail-closed behavior", () => {
  it("a DECLINED chord stops the drive and names the boundary, never re-fires", async () => {
    const sim = new HeadingSim(["A", "B", "C", "D"], { declineChord: 2 });
    const out = await drive(sim, specFor(["B", "C", "A", "D"], ["A"]));
    expect(out.ok).toBe(false);
    expect(out.chords).toBe(2);
    // Exactly two chords posted: the one that landed and the one that did not.
    // A driver that re-fired blind would show more.
    expect(chordsPosted(sim)).toEqual(["down-one", "down-one"]);
    expect(out.detail).toContain("did not move the heading");
    expect(out.detail).toContain("declined");
    expect(out.detail).toContain("1 earlier chord(s) did land");
  });

  it("a chord that renumbers a row it never passed over stops the drive", async () => {
    const sim = new HeadingSim(["A", "B", "C", "D"], { collateralOnChord: 1 });
    // Swapping B and C never touches D — a D renumber means the chord landed
    // somewhere the plan cannot account for.
    const out = await drive(sim, specFor(["A", "C", "B", "D"], ["C"]));
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("did not behave as a single-row move");
    expect(out.detail).toContain("never passed over");
  });

  it("a chord that disturbs a CHILD stops the drive (the FK/index integrity law)", async () => {
    const sim = new HeadingSim(["A", "B", "C"], { disturbChildOnChord: 1 });
    const out = await drive(sim, specFor(["A", "C", "B"], ["C"]));
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("changed a to-do's heading or position");
  });

  it("a chord that lands SOMEWHERE ELSE stops the drive rather than continue", async () => {
    // An app that treats ⌘⌥↑ as ⌘↑ moves the row one slot, not to the top.
    const sim = new HeadingSim(["A", "B", "C", "D"], { ignoreEndpointChords: true });
    const out = await drive(sim, specFor(["D", "A", "B", "C"], ["D"]));
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("not the expected");
    expect(out.chords).toBe(1);
  });

  it("a lost row selection is a named refusal, not a silent no-op", async () => {
    const sim = new HeadingSim(["A", "B", "C"], { failSelect: 1 });
    const out = await drive(sim, specFor(["A", "C", "B"], ["C"]));
    expect(out.ok).toBe(false);
    expect(out.chords).toBe(0);
    expect(out.detail).toContain("no selectable heading row at position");
    expect(out.detail).toContain("nothing was moved");
  });

  it("a stale plan (the heading set changed since the read) refuses with zero chords", async () => {
    const sim = new HeadingSim(["A", "B", "C"]);
    const out = await drive(sim, specFor(["A", "B", "C", "D"], ["D"]));
    expect(out.ok).toBe(false);
    expect(out.chords).toBe(0);
    expect(out.detail).toContain("changed between planning and driving");
    expect(sim.log).toEqual([]);
  });

  it("refuses to chord a heading the caller never named", async () => {
    const sim = new HeadingSim(["A", "B", "C"]);
    // The target needs B moved, but only C is a declared movee.
    const out = await drive(sim, specFor(["B", "A", "C"], ["C"]));
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("refusing to reorder a bystander");
    expect(out.chords).toBe(0);
  });

  it("without a database seam it refuses cleanly rather than drive blind", async () => {
    const sim = new HeadingSim(["A", "B", "C"]);
    const out = await driveHeadingChordReorder(
      specFor(["A", "C", "B"], ["C"]),
      (cmd) => sim.run(cmd),
      undefined,
      (o) => `select ${o}`,
      noSleep,
    );
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("no database seam");
    expect(sim.log).toEqual([]);
  });

  it("the chord budget bounds a pathological drive", async () => {
    // An app that never moves anything past the first chord would otherwise loop:
    // the progress guard catches it first, which is the point — the budget is the
    // backstop behind it. Prove the guard fires before any budget is reachable.
    const sim = new HeadingSim(["A", "B", "C", "D", "E"], { declineChord: 1 });
    const out = await drive(sim, specFor(["E", "A", "B", "C", "D"], ["E"]));
    expect(out.ok).toBe(false);
    expect(out.chords).toBe(1);
  });
});

// --------------------------------------------------------- the database seam

describe("createHeadingOrderReader — the ordinal ground truth", () => {
  it("CHORDMH2: returns the RENDERED order — index order filtered to status = 0", () => {
    const fixture = buildFixtureDb();
    try {
      const project = seedProject(fixture.db, { title: "P" });
      const g1 = seedHeading(fixture.db, { title: "G1", project, index: 1 });
      const arch = seedHeading(fixture.db, {
        title: "GARCH",
        project,
        index: 2,
        status: "completed",
        stopDate: 1,
      });
      const g2 = seedHeading(fixture.db, { title: "G2", project, index: 3 });
      const g3 = seedHeading(fixture.db, { title: "G3", project, index: 4 });
      const trashed = seedHeading(fixture.db, { title: "GONE", project, index: 5 });
      fixture.db.prepare("UPDATE TMTask SET trashed = 1 WHERE uuid = ?").run(trashed);
      // A child of the ARCHIVED heading still counts into the digest: no heading
      // chord may disturb any child of any heading of the project.
      seedTodo(fixture.db, { title: "kid", heading: arch });

      const state = createHeadingOrderReader(fixture.db)(project);
      // The archived row holds a slot in the index axis and is absent from the
      // walk — so ordinal 1 is G2, not the archived row.
      expect(state.headings.map((h) => h.uuid)).toEqual([g1, g2, g3]);
      expect(state.childCount).toBe(1);
    } finally {
      fixture.close();
    }
  });
});
