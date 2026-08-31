/**
 * Sidebar drag driver (ui-drag.ts) — geometry + ladder logic, driven entirely
 * through the injectable UiRunner seam against a scripted sidebar SIMULATOR
 * (no GUI, no osascript — CLAUDE.md safety rails). The simulator models the
 * AXDRAG1 layout: entity rows + spacer rows, a scrollable viewport, drop
 * resolution against the LIVE (source-lifted) layout, and the sparse-index
 * rewrite on drop.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";
import {
  areaRowsInOrder,
  areaTitleRank,
  boundaryAboveRow,
  boundaryBelowLast,
  correctedDropY,
  describeSnapshotFailure,
  driveSidebarAreaReorder,
  findAreaRow,
  findAreaRowNth,
  jxaSidebarSnapshotScript,
  jxaSidebarVisibilityScript,
  parseSidebarSnapshot,
  placementSatisfied,
  rowMatchesTitle,
  sectionBlocks,
  slotPitch,
  sourceGroupSpan,
  tallestSectionInSpan,
  usableDragSpan,
  type AreaSidebarState,
  type SidebarPlacement,
  type SidebarRect,
  type SidebarRowInfo,
  type SidebarSectionSpan,
} from "../../src/write/vectors/ui-drag.ts";

// ------------------------------------------------------------- helpers

const ROW_H = 24;
const SPACER_H = 16;
const PITCH = ROW_H + SPACER_H; // 40 — the lab-observed slot, produced by frames here
const VIEW_X = 44;
const VIEW_Y = 63;

function entityRow(title: string, y: number): SidebarRowInfo {
  return { text: `${title}.|Source Toggle Template|${title}`, x: VIEW_X, y, w: 240, h: ROW_H };
}
function spacerRow(y: number): SidebarRowInfo {
  return { text: "", x: VIEW_X, y, w: 240, h: SPACER_H };
}

/** Static rows for a list of area titles starting at VIEW_Y (no scroll). */
function rowsFor(titles: string[], offset = 0): SidebarRowInfo[] {
  const rows: SidebarRowInfo[] = [];
  titles.forEach((t, i) => {
    const y = VIEW_Y + i * PITCH - offset;
    rows.push(entityRow(t, y));
    rows.push(spacerRow(y + ROW_H));
  });
  return rows;
}

// ------------------------------------------------------------ geometry

describe("row identity", () => {
  it("matches exact static-text segments (with the trailing-dot variant), not substrings", () => {
    expect(rowMatchesTitle("Area-1.|Tmpl|Area-1", "Area-1")).toBe(true);
    expect(rowMatchesTitle("Area-11.|Tmpl|Area-11", "Area-1")).toBe(false);
    expect(rowMatchesTitle("Other|Area-1 extra", "Area-1")).toBe(false);
  });

  it("findAreaRow refuses ambiguity (two rows carrying the title)", () => {
    const rows = [entityRow("A", 100), entityRow("A", 200)];
    expect(findAreaRow(rows, "A")).toBeNull();
  });

  it("findAreaRowNth picks the Nth same-titled row in visual (y) order (ORDFIN2 AXDRAG3)", () => {
    const rows = [entityRow("A", 300), entityRow("B", 100), entityRow("A", 200)];
    expect(findAreaRowNth(rows, "A", 0)?.y).toBe(200); // topmost A by y
    expect(findAreaRowNth(rows, "A", 1)?.y).toBe(300);
    expect(findAreaRowNth(rows, "A", 2)).toBeNull(); // only two A rows
  });

  it("areaTitleRank ranks a uuid among same-titled by (index,uuid) order; -1 when unique", () => {
    const areas = [
      { uuid: "u1", title: "Dupe" },
      { uuid: "u2", title: "Solo" },
      { uuid: "u3", title: "Dupe" },
    ];
    expect(areaTitleRank(areas, "u1", "Dupe")).toBe(0);
    expect(areaTitleRank(areas, "u3", "Dupe")).toBe(1);
    expect(areaTitleRank(areas, "u2", "Solo")).toBe(-1); // unique — no disambiguation
  });
});

describe("frame-derived geometry (no hardcoded pixels)", () => {
  const titles = ["A1", "A2", "A3", "A4"];
  const rows = rowsFor(titles);
  const ordered = areaRowsInOrder(rows, titles);

  it("orders area rows by resolved y", () => {
    expect(ordered.map((a) => a.title)).toEqual(titles);
  });

  it("slot pitch is the median adjacent area-row delta", () => {
    expect(slotPitch(ordered, rows)).toBe(PITCH);
  });

  it("the boundary above a row is the spacer row's center", () => {
    const a3 = ordered[2] as { row: SidebarRowInfo };
    // spacer above A3 spans [A2.bottom, A3.top]; its center is top − spacer/2
    expect(boundaryAboveRow(rows, a3.row)).toBe(a3.row.y - SPACER_H / 2);
  });

  it("the boundary below the last row is the trailing spacer's center", () => {
    const last = rows.toSorted((a, b) => a.y - b.y).at(-1) as SidebarRowInfo;
    expect(last.text).toBe("");
    expect(boundaryBelowLast(rows)).toBe(last.y + last.h / 2);
  });

  it("downward drags subtract the source group span; upward drags do not (AXDRAG1-a)", () => {
    // Evidence anchor: ref static top 632 → boundary 624; downward with a
    // 40px span corrects to 584 (the live gap above the shifted row).
    const staticBoundary = 632 - SPACER_H / 2;
    expect(correctedDropY(staticBoundary, 400, PITCH)).toBe(staticBoundary - PITCH);
    expect(correctedDropY(staticBoundary, 700, PITCH)).toBe(staticBoundary);
  });

  it("the source group span covers nested project rows (next area top − source top)", () => {
    // A2 has two project rows under it: A3 starts 2*PITCH below A2.
    const rowsWithProjects: SidebarRowInfo[] = [
      entityRow("A1", VIEW_Y),
      spacerRow(VIEW_Y + ROW_H),
      entityRow("A2", VIEW_Y + PITCH),
      spacerRow(VIEW_Y + PITCH + ROW_H),
      entityRow("Proj-X", VIEW_Y + 2 * PITCH),
      spacerRow(VIEW_Y + 2 * PITCH + ROW_H),
      entityRow("A3", VIEW_Y + 3 * PITCH),
      spacerRow(VIEW_Y + 3 * PITCH + ROW_H),
    ];
    const orderedAreas = areaRowsInOrder(rowsWithProjects, ["A1", "A2", "A3"]);
    expect(sourceGroupSpan(orderedAreas, "A2", rowsWithProjects)).toBe(2 * PITCH);
    expect(sourceGroupSpan(orderedAreas, "A1", rowsWithProjects)).toBe(PITCH);
    // Last area falls back to the median adjacent delta (never load-bearing:
    // a downward correction cannot apply to the bottom-most area).
    expect(sourceGroupSpan(orderedAreas, "A3", rowsWithProjects)).toBe(2 * PITCH);
  });
});

describe("snapshot parsing", () => {
  it("accepts the driver JSON and drops frameless rows", () => {
    const out = parseSidebarSnapshot(
      JSON.stringify({
        ok: true,
        viewport: { x: VIEW_X, y: VIEW_Y, w: 240, h: 610 },
        scroll: 0.5,
        rows: [entityRow("A", 100), { text: "ghost", x: null, y: null, w: null, h: null }],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected a snapshot");
    expect(out.snapshot.rows).toHaveLength(1);
    expect(out.snapshot.scroll).toBe(0.5);
  });
  it("reports unreadable output as its own cause", () => {
    const out = parseSidebarSnapshot("execution error: …");
    expect(out).toEqual({ ok: false, why: "unparsable" });
  });

  // THE #665/#651 REGRESSION SURFACE. Every one of these used to arrive as the
  // single sentence "the sidebar did not resolve (is the window open and the
  // sidebar visible?)" — which was false for most of them.
  it.each([
    ["no-window", "no open window"],
    ["no-list-candidates", "no list at all"],
    ["sidebar-hidden", "View ▸ Show Sidebar"],
    ["ambiguous-sidebar", "two lists"],
    ["no-rows", "exposed no rows"],
  ] as const)("carries %s through to its own remediation", (why, phrase) => {
    const out = parseSidebarSnapshot(JSON.stringify({ ok: false, why }));
    expect(out).toEqual({ ok: false, why });
    if (out.ok) throw new Error("expected a refusal");
    expect(describeSnapshotFailure(out)).toContain(phrase);
  });

  it("names what the locator searched when nothing matched", () => {
    const out = parseSidebarSnapshot(
      JSON.stringify({
        ok: false,
        why: "no-title-match",
        titles: 3,
        searched: [{ frame: { x: 0, y: 0, w: 742, h: 500 }, rows: 12 }],
      }),
    );
    if (out.ok) throw new Error("expected a refusal");
    const text = describeSnapshotFailure(out);
    expect(text).toContain("3 area(s)");
    expect(text).toContain("12 row(s)");
    expect(text).toContain("742pt wide");
  });

  it("distinguishes a timeout from a locator miss", () => {
    expect(describeSnapshotFailure({ ok: false, why: "timeout" })).toContain("longer than 30s");
    expect(describeSnapshotFailure({ ok: false, why: "timeout" })).toContain("nothing was dragged");
  });

  it("refuses a resolved-but-empty sidebar rather than reporting an empty snapshot", () => {
    const out = parseSidebarSnapshot(
      JSON.stringify({
        ok: true,
        viewport: { x: 0, y: 0, w: 240, h: 600 },
        scroll: null,
        rows: [],
      }),
    );
    expect(out).toEqual({ ok: false, why: "no-rows" });
  });
});

// ------------------------------------------------- the sidebar simulator

interface SimOptions {
  titles: string[];
  viewportH: number;
  /** Corrupt the assignments digest after the first drop (damage injection). */
  corruptDigestAfterDrag?: boolean;
  /** Make snapshots fail (fail-closed test). */
  failSnapshots?: boolean;
  /** Make the scroll-while-held gesture Escape-abort (rung-3 fall-through). */
  failHeldDrag?: boolean;
  /** Make the held gesture land ONE SLOT SHORT (benign off-slot landing). */
  heldDragOffByOne?: boolean;
  /**
   * The sidebar starts HIDDEN (View ▸ Hide Sidebar): every snapshot refuses
   * `sidebar-hidden` until the drive runs the normalization rung (SBRES1).
   */
  sidebarHidden?: boolean;
  /** The View menu has no Show Sidebar item — the rung cannot normalize. */
  revealRefused?: boolean;
}

interface Sim {
  run: (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>;
  aux: { areaState: () => AreaSidebarState };
  log: string[];
  order: () => string[];
}

const uuidOf = (t: string): string => `u-${t}`;

function makeSim(options: SimOptions): Sim {
  let order = [...options.titles];
  let offset = 0;
  let drags = 0;
  let digest = "D0";
  const log: string[] = [];
  // A realistic sidebar: built-in rows (Inbox/Today) sit ABOVE the area block.
  const BUILTINS = ["Inbox", "Today"];
  const contentH = (BUILTINS.length + order.length) * PITCH;
  const maxOffset = Math.max(0, contentH - options.viewportH);

  const staticTop = (i: number): number => VIEW_Y + (BUILTINS.length + i) * PITCH - offset;
  const builtinTop = (i: number): number => VIEW_Y + i * PITCH - offset;

  const snapshot = (): string =>
    JSON.stringify({
      ok: true,
      viewport: { x: VIEW_X, y: VIEW_Y, w: 240, h: options.viewportH },
      scroll: maxOffset === 0 ? 0 : offset / maxOffset,
      rows: [
        ...BUILTINS.flatMap((t, i) => [
          entityRow(t, builtinTop(i)),
          spacerRow(builtinTop(i) + ROW_H),
        ]),
        ...order.flatMap((t, i) => [entityRow(t, staticTop(i)), spacerRow(staticTop(i) + ROW_H)]),
      ],
    });

  const applyDrag = (sy: number, ty: number): void => {
    const si = order.findIndex((_, i) => sy >= staticTop(i) && sy <= staticTop(i) + ROW_H);
    if (si < 0) return; // grab missed — no-op, like the real app
    const source = order[si] as string;
    const remaining = order.filter((_, i) => i !== si);
    // Live tops after the lift: rows below the source shift up one slot.
    const liveTop = (j: number): number => {
      const origIdx = order.indexOf(remaining[j] as string);
      return origIdx > si ? staticTop(origIdx) - PITCH : staticTop(origIdx);
    };
    let k = remaining.length;
    for (let j = 0; j < remaining.length; j++) {
      if (ty < liveTop(j) + ROW_H / 2) {
        k = j;
        break;
      }
    }
    remaining.splice(k, 0, source);
    order = remaining;
    drags += 1;
    if (options.corruptDigestAfterDrag === true && drags === 1) digest = "D-CORRUPT";
  };

  let hidden = options.sidebarHidden === true;

  const run = (command: UiCommand): Promise<UiRunResult> => {
    log.push(command.primitive);
    const script = command.script ?? "";
    if (command.primitive === "sidebar-snapshot") {
      if (options.failSnapshots === true) {
        return Promise.resolve({ ok: false, stdout: "", stderr: "-1719" });
      }
      if (hidden) {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ ok: false, why: "sidebar-hidden" }),
          stderr: "",
        });
      }
      return Promise.resolve({ ok: true, stdout: snapshot(), stderr: "" });
    }
    if (command.primitive === "sidebar-visibility") {
      const showing = script.includes("Show Sidebar");
      if (showing && options.revealRefused === true) {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({
            clicked: false,
            why: 'the View menu has no "Show Sidebar" item',
          }),
          stderr: "",
        });
      }
      hidden = !showing;
      return Promise.resolve({ ok: true, stdout: JSON.stringify({ clicked: true }), stderr: "" });
    }
    if (command.primitive === "sidebar-scroll") {
      const m = script.match(/var n = (-?\d+)/);
      const clicks = m === null ? 0 : Number(m[1]);
      // Negative clicks reveal lower rows (row y shrinks) — AXDRAG1-b.
      offset = Math.max(0, Math.min(maxOffset, offset - clicks * 30));
      return Promise.resolve({ ok: true, stdout: "DONE", stderr: "" });
    }
    if (command.primitive === "sidebar-drag") {
      const m = script.match(/var sx=(-?\d+), sy=(-?\d+), tx=(-?\d+), ty=(-?\d+)/);
      if (m !== null) applyDrag(Number(m[2]), Number(m[4]));
      return Promise.resolve({ ok: true, stdout: "DONE", stderr: "" });
    }
    if (command.primitive === "sidebar-held-drag") {
      if (options.failHeldDrag === true) {
        return Promise.resolve({ ok: true, stdout: JSON.stringify({ aborted: true }), stderr: "" });
      }
      const meta = command.meta as { sy: number; anchorTitle: string | null };
      const si = order.findIndex(
        (_, i) => meta.sy >= staticTop(i) && meta.sy <= staticTop(i) + ROW_H,
      );
      if (si < 0) {
        return Promise.resolve({ ok: true, stdout: JSON.stringify({ aborted: true }), stderr: "" });
      }
      const source = order[si] as string;
      const remaining = order.filter((_, i) => i !== si);
      let k = meta.anchorTitle === null ? remaining.length : remaining.indexOf(meta.anchorTitle);
      if (k < 0) {
        return Promise.resolve({ ok: true, stdout: JSON.stringify({ aborted: true }), stderr: "" });
      }
      if (options.heldDragOffByOne === true) k = Math.max(0, k - 1);
      remaining.splice(k, 0, source);
      order = remaining;
      drags += 1;
      if (options.corruptDigestAfterDrag === true && drags === 1) digest = "D-CORRUPT";
      return Promise.resolve({
        ok: true,
        stdout: JSON.stringify({ dropped: true, ticks: 7 }),
        stderr: "",
      });
    }
    return Promise.resolve({ ok: true, stdout: "", stderr: "" });
  };

  return {
    run,
    log,
    order: () => [...order],
    aux: {
      areaState: (): AreaSidebarState => ({
        areas: order.map((t, i) => ({ uuid: uuidOf(t), title: t, index: (i + 1) * 10 })),
        assignmentsDigest: digest,
      }),
    },
  };
}

const instantSleep = (): Promise<void> => Promise.resolve();

function drive(
  sim: Sim,
  target: string,
  placement: SidebarPlacement,
): ReturnType<typeof driveSidebarAreaReorder> {
  return driveSidebarAreaReorder(
    { targetUuid: `u-${target}`, targetTitle: target, placement },
    sim.run,
    sim.aux,
    instantSleep,
  );
}

const before = (t: string): SidebarPlacement => ({ kind: "before", uuid: `u-${t}`, title: t });
const after = (t: string): SidebarPlacement => ({ kind: "after", uuid: `u-${t}`, title: t });

// ------------------------------------------------------------ the ladder

describe("ladder — rung 1 (shared viewport)", () => {
  it("moves with a single drag when source and destination are both visible", async () => {
    const sim = makeSim({ titles: ["A1", "A2", "A3", "A4", "A5"], viewportH: 610 });
    const res = await drive(sim, "A2", after("A4"));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("one drag");
    expect(sim.order()).toEqual(["A1", "A3", "A4", "A2", "A5"]);
    expect(sim.log.filter((p) => p === "sidebar-drag")).toHaveLength(1);
  });

  it("moves upward to-first with a single drag (static coordinates)", async () => {
    const sim = makeSim({ titles: ["A1", "A2", "A3", "A4"], viewportH: 610 });
    const res = await drive(sim, "A3", { kind: "first" });
    expect(res.ok).toBe(true);
    expect(sim.order()).toEqual(["A3", "A1", "A2", "A4"]);
  });

  it("pre-scrolls when the pair is off-viewport but fits one screen together", async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300 });
    const res = await drive(sim, "A20", before("A22"));
    expect(res.ok).toBe(true);
    expect(sim.log).toContain("sidebar-scroll");
    expect(sim.log.filter((p) => p === "sidebar-drag")).toHaveLength(1);
    const order = sim.order();
    expect(order.indexOf("A20")).toBe(order.indexOf("A22") - 1);
  });

  it("no-ops (zero gestures) when the placement is already satisfied", async () => {
    const sim = makeSim({ titles: ["A1", "A2", "A3"], viewportH: 610 });
    const res = await drive(sim, "A2", after("A1"));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("nothing to move");
    expect(sim.log).toHaveLength(0);
  });
});

describe("ladder — rung 2 (scroll-while-held — built, opt-in via lab knob)", () => {
  beforeEach(() => {
    process.env["THINGS_UI_DRAG_LADDER"] = "held-scroll";
  });
  afterEach(() => {
    delete process.env["THINGS_UI_DRAG_LADDER"];
  });

  it("moves a mid-distance target with one held-scroll gesture and DB-asserts the result", async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300 });
    // Travel ≈ 11 slots (440px) — beyond rung 1 (300px viewport) but inside
    // the 1.5-viewport held-scroll cap (450px).
    const res = await drive(sim, "A1", before("A13"));
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("scroll-while-held");
    const order = sim.order();
    expect(order.indexOf("A1")).toBe(order.indexOf("A13") - 1);
    expect(sim.log.filter((x) => x === "sidebar-held-drag")).toHaveLength(1);
    expect(sim.log.filter((x) => x === "sidebar-drag")).toHaveLength(0);
  });

  it("skips the held gesture entirely for far travels (the AX-ghost travel cap)", async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300 });
    const res = await drive(sim, "A1", { kind: "last" });
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/hop/);
    expect(sim.order().at(-1)).toBe("A1");
    expect(sim.log.filter((x) => x === "sidebar-held-drag")).toHaveLength(0);
  });

  it("finishes via the lower rungs when the held drop lands one slot off (benign)", async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300, heldDragOffByOne: true });
    const res = await drive(sim, "A1", before("A13"));
    expect(res.ok).toBe(true);
    const order = sim.order();
    expect(order.indexOf("A1")).toBe(order.indexOf("A13") - 1);
    expect(sim.log.filter((x) => x === "sidebar-held-drag")).toHaveLength(1);
    expect(sim.log.filter((x) => x === "sidebar-drag").length).toBeGreaterThan(0);
  });

  it("falls through to the multi-hop floor when the held gesture aborts cleanly", async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300, failHeldDrag: true });
    const res = await drive(sim, "A1", before("A13"));
    expect(res.ok).toBe(true);
    const order = sim.order();
    expect(order.indexOf("A1")).toBe(order.indexOf("A13") - 1);
    expect(sim.log.filter((x) => x === "sidebar-held-drag")).toHaveLength(1);
    expect(sim.log.filter((x) => x === "sidebar-drag").length).toBeGreaterThan(0);
  });
});

describe("ladder — rung 3 (multi-hop fallback — the default floor)", () => {
  it("hops one viewport at a time, asserting the DB between hops, and converges", async () => {
    const titles = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300 });
    const res = await drive(sim, "A1", { kind: "last" });
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/hop/);
    expect(sim.order().at(-1)).toBe("A1");
    // A genuine multi-hop: more than one drag gesture.
    expect(sim.log.filter((p) => p === "sidebar-drag").length).toBeGreaterThan(1);
  });

  it("hops upward too (to-first from the bottom)", async () => {
    const titles = Array.from({ length: 24 }, (_, i) => `A${i + 1}`);
    const sim = makeSim({ titles, viewportH: 300 });
    const res = await drive(sim, "A24", { kind: "first" });
    expect(res.ok).toBe(true);
    expect(sim.order()[0]).toBe("A24");
    expect(sim.log.filter((p) => p === "sidebar-drag").length).toBeGreaterThan(1);
  });
});

describe("fail-closed + recovery", () => {
  it("refuses before any synthesis when the sidebar does not resolve", async () => {
    const sim = makeSim({ titles: ["A1", "A2", "A3"], viewportH: 610, failSnapshots: true });
    const res = await drive(sim, "A1", { kind: "last" });
    expect(res.ok).toBe(false);
    expect(sim.log).not.toContain("sidebar-drag");
    expect(res.detail).toContain("No sidebar change was left behind");
  });

  it("refuses without gestures when no database seam is wired", async () => {
    const sim = makeSim({ titles: ["A1", "A2"], viewportH: 610 });
    const res = await driveSidebarAreaReorder(
      { targetUuid: "u-A1", targetTitle: "A1", placement: { kind: "last" } },
      sim.run,
      {},
      instantSleep,
    );
    expect(res.ok).toBe(false);
    expect(sim.log).toHaveLength(0);
  });

  it("refuses when the target row cannot be resolved by its visible name", async () => {
    const sim = makeSim({ titles: ["A1", "A2", "A3"], viewportH: 610 });
    // The DB knows "Ghost" but the sidebar shows no such row.
    sim.aux.areaState = () => ({
      areas: [
        { uuid: "u-Ghost", title: "Ghost", index: 5 },
        { uuid: "u-A1", title: "A1", index: 10 },
        { uuid: "u-A2", title: "A2", index: 20 },
        { uuid: "u-A3", title: "A3", index: 30 },
      ],
      assignmentsDigest: "D0",
    });
    const res = await driveSidebarAreaReorder(
      { targetUuid: "u-Ghost", targetTitle: "Ghost", placement: { kind: "last" } },
      sim.run,
      sim.aux,
      instantSleep,
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('"Ghost"');
    expect(sim.log).not.toContain("sidebar-drag");
  });

  it("drags back (verified) when an invariant breaks after the drop", async () => {
    const sim = makeSim({
      titles: ["A1", "A2", "A3", "A4"],
      viewportH: 610,
      corruptDigestAfterDrag: true,
    });
    const res = await drive(sim, "A2", { kind: "last" });
    expect(res.ok).toBe(false);
    expect(res.recovered).toBe(true);
    expect(res.detail).toContain("dragged back");
    // The recovery drag restored the original order.
    expect(sim.order()).toEqual(["A1", "A2", "A3", "A4"]);
    expect(sim.log.filter((p) => p === "sidebar-drag")).toHaveLength(2);
  });
});

describe("placementSatisfied", () => {
  const state: AreaSidebarState = {
    areas: [
      { uuid: "a", title: "A", index: 10 },
      { uuid: "b", title: "B", index: 20 },
      { uuid: "c", title: "C", index: 30 },
    ],
    assignmentsDigest: "D",
  };
  it("evaluates all four placement kinds by RELATIVE position", () => {
    expect(placementSatisfied(state, "a", { kind: "first" })).toBe(true);
    expect(placementSatisfied(state, "c", { kind: "last" })).toBe(true);
    expect(placementSatisfied(state, "a", { kind: "before", uuid: "b", title: "B" })).toBe(true);
    expect(placementSatisfied(state, "b", { kind: "after", uuid: "a", title: "A" })).toBe(true);
    expect(placementSatisfied(state, "a", { kind: "last" })).toBe(false);
    expect(placementSatisfied(state, "a", { kind: "after", uuid: "c", title: "C" })).toBe(false);
  });
});

// ------------------------------------------- the tall-section wall (#658)
//
// A real sidebar renders every area's PROJECTS beneath it, so ONE area's
// section can be taller than the whole viewport. Both shipped rungs need the
// grab point and the drop boundary visible at once, so such a section can never
// be crossed — the driver must say so up front instead of hopping until no
// anchor fits and then blaming the window size (AXDRAG5).

const WALL_VIEWPORT: SidebarRect = { x: VIEW_X, y: VIEW_Y, w: 240, h: 346 };

/** A5 at the bottom, A3 carrying `projects` nested rows — the field geometry. */
function wallRows(projects: number): SidebarRowInfo[] {
  const rows: SidebarRowInfo[] = [];
  let y = VIEW_Y;
  const push = (title: string): void => {
    rows.push(entityRow(title, y));
    rows.push(spacerRow(y + ROW_H));
    y += PITCH;
  };
  push("A1");
  push("A2");
  push("A3");
  for (let i = 0; i < projects; i++) push(`Proj-${i}`);
  push("A4");
  push("A5");
  return rows;
}

describe("tall-section geometry", () => {
  it("measures each area SECTION (its row plus the rows Things renders under it)", () => {
    const rows = wallRows(20);
    const ordered = areaRowsInOrder(rows, ["A1", "A2", "A3", "A4", "A5"]);
    const src = ordered.find((a) => a.title === "A5") as { row: SidebarRowInfo };
    const wall = tallestSectionInSpan(
      ordered,
      rows,
      src.row.y + src.row.h / 2,
      boundaryAboveRow(rows, (ordered[1] as { row: SidebarRowInfo }).row),
      "A5",
    );
    expect(wall?.title).toBe("A3");
    expect(wall?.height).toBe(21 * PITCH); // A3 + its 20 project rows
    expect(sectionBlocks(wall as SidebarSectionSpan, WALL_VIEWPORT)).toBe(true);
  });

  it("does not call a NARROW section a wall, and never counts the source's own", () => {
    const rows = wallRows(2); // A3 = 3 slots = 120pt, well inside the 322pt span
    const ordered = areaRowsInOrder(rows, ["A1", "A2", "A3", "A4", "A5"]);
    const wall = tallestSectionInSpan(ordered, rows, VIEW_Y + 500, VIEW_Y, "A5");
    expect(wall === null || !sectionBlocks(wall, WALL_VIEWPORT)).toBe(true);
    expect(usableDragSpan(WALL_VIEWPORT)).toBe(322);
  });
});

describe("ladder — the tall-section wall", () => {
  /** A runner whose sidebar snapshot is fixed; records every primitive it sees. */
  function wallSim(projects: number): {
    run: (command: UiCommand) => Promise<UiRunResult>;
    aux: { areaState: () => AreaSidebarState };
    log: string[];
  } {
    const titles = ["A1", "A2", "A3", "A4", "A5"];
    const log: string[] = [];
    const rows = wallRows(projects);
    return {
      log,
      run: (command: UiCommand): Promise<UiRunResult> => {
        log.push(command.primitive);
        if (command.primitive === "sidebar-snapshot") {
          return Promise.resolve({
            ok: true,
            stdout: JSON.stringify({ ok: true, viewport: WALL_VIEWPORT, scroll: 0, rows }),
            stderr: "",
          });
        }
        return Promise.resolve({ ok: true, stdout: "DONE", stderr: "" });
      },
      aux: {
        areaState: (): AreaSidebarState => ({
          areas: titles.map((t, i) => ({ uuid: `u-${t}`, title: t, index: (i + 1) * 10 })),
          assignmentsDigest: "D",
        }),
      },
    };
  }

  it("refuses honestly when the chevron will not respond, naming the section AND why", async () => {
    // This simulator's chevron answers "DONE" rather than a click verdict — the
    // shape of a toggle that did not actuate. The rung must fast-fail to the
    // refusal, never proceed on the assumption that the fold worked (SBCOL1).
    const sim = wallSim(20);
    const res = await driveSidebarAreaReorder(
      { targetUuid: "u-A5", targetTitle: "A5", placement: before("A2") },
      sim.run,
      sim.aux,
      instantSleep,
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('"A3"');
    expect(res.detail).toContain("taller than the sidebar shows at once");
    expect(res.detail).toContain("did not work");
    // the honest refusal never blames the window size for a geometry no window fixes
    expect(res.detail).not.toContain("viewport is too small");
    // NO drag is ever attempted across an uncleared wall
    expect(sim.log.filter((p) => p === "sidebar-drag")).toHaveLength(0);
    // one chevron attempt, then it stops — it does not click at it again
    expect(sim.log.filter((p) => p === "sidebar-chevron")).toHaveLength(1);
  });

  it("leaves a move whose path crosses only NORMAL sections to the ladder", async () => {
    const sim = wallSim(1); // A3 = 2 slots — crossable
    const res = await driveSidebarAreaReorder(
      { targetUuid: "u-A5", targetTitle: "A5", placement: before("A2") },
      sim.run,
      sim.aux,
      instantSleep,
    );
    // the fixed snapshot never reflects the drag, so the drive cannot SUCCEED —
    // what matters is that it reached the gesture instead of refusing up front.
    expect(sim.log).toContain("sidebar-drag");
    expect(res.detail).not.toContain("taller than the sidebar shows at once");
  });
});

// ------------------------------------------- the collapse rung (SBCOL1)
//
// SBCOL1 measured the way out of the AXDRAG5 wall: an area row's disclosure
// chevron is frame-resolvable, and a synthesized click at its own frame
// ACTUATES it (an `AXPress` on the node that advertises the action is
// decorative — REPX1 §1.2). So a section too tall to drag past is not a dead
// end: it is folded away, crossed, and put back. The disclosure state lives in
// Things' own preferences and SURVIVES A RELAUNCH, so restoring it is not
// politeness — an unrestored collapse is a durable change to the user's sidebar.

const SUBJECT = "Zeta";
const ANCHOR = "Gamma";
/** Gamma … Zeta with ONE oversized section (Eta) between them. */
const ONE_WALL = ["Gamma", "Delta", "Eta", "Theta", "Zeta"];
/** …and a second one (Sigma) on the same travel span. */
const TWO_WALLS = ["Gamma", "Sigma", "Delta", "Eta", "Theta", "Zeta"];

/**
 * A sidebar backed by a MODEL rather than a fixed row list: areas with project
 * counts, a collapsed set the chevron primitive mutates, and an order the drag
 * primitive rewrites. It is the smallest simulator that can tell the whole
 * story of the rung — fold, cross, unfold — in one pass.
 */
function collapseSim(opts: {
  /** Area title → how many project rows Things renders under it. */
  projects: Record<string, number>;
  order: string[];
  /** The chevron does nothing (a toggle that will not actuate). */
  inertChevron?: boolean;
  /** The drag gesture never completes (forces a failure AFTER the fold). */
  brokenDrag?: boolean;
}): {
  run: (command: UiCommand) => Promise<UiRunResult>;
  aux: { areaState: () => AreaSidebarState };
  log: string[];
  chevrons: string[];
  collapsedNow: () => string[];
} {
  const order = [...opts.order];
  const collapsed = new Set<string>();
  const log: string[] = [];
  const chevrons: string[] = [];
  const viewport: SidebarRect = { x: VIEW_X, y: VIEW_Y, w: 240, h: 346 };
  let offset = 0;

  /** Slots the list currently occupies (an area + the rows drawn under it). */
  const slots = (): number =>
    order.reduce((n, a) => n + 1 + (collapsed.has(a) ? 0 : (opts.projects[a] ?? 0)), 0);

  const render = (): SidebarRowInfo[] => {
    const rows: SidebarRowInfo[] = [];
    let y = VIEW_Y - offset;
    const push = (title: string): void => {
      rows.push(entityRow(title, y));
      rows.push(spacerRow(y + ROW_H));
      y += PITCH;
    };
    for (const area of order) {
      push(area);
      if (collapsed.has(area)) continue;
      for (let i = 0; i < (opts.projects[area] ?? 0); i++) push(`${area}-P${i}`);
    }
    return rows;
  };

  return {
    log,
    chevrons,
    collapsedNow: () => [...collapsed],
    run: (command: UiCommand): Promise<UiRunResult> => {
      log.push(command.primitive);
      if (command.primitive === "sidebar-snapshot") {
        return Promise.resolve({
          ok: true,
          stdout: JSON.stringify({ ok: true, viewport, scroll: 0, rows: render() }),
          stderr: "",
        });
      }
      if (command.primitive === "sidebar-scroll") {
        // Negative clicks reveal lower rows (row y shrinks) — AXDRAG1-b.
        const m = (command.script ?? "").match(/var n = (-?\d+)/);
        const clicks = m === null ? 0 : Number(m[1]);
        const maxOffset = Math.max(0, slots() * PITCH - viewport.h);
        offset = Math.max(0, Math.min(maxOffset, offset - clicks * 30));
        return Promise.resolve({ ok: true, stdout: "DONE", stderr: "" });
      }
      if (command.primitive === "sidebar-chevron") {
        const title = (command.meta as { title: string }).title;
        chevrons.push(title);
        if (opts.inertChevron === true) {
          return Promise.resolve({
            ok: true,
            stdout: JSON.stringify({
              clicked: false,
              why: "the row exposes no disclosure chevron",
            }),
            stderr: "",
          });
        }
        if (collapsed.has(title)) collapsed.delete(title);
        else collapsed.add(title);
        return Promise.resolve({ ok: true, stdout: JSON.stringify({ clicked: true }), stderr: "" });
      }
      if (command.primitive === "sidebar-drag") {
        if (opts.brokenDrag === true) {
          return Promise.resolve({ ok: false, stdout: "", stderr: "the gesture did not complete" });
        }
        // The only move this fixture needs: pull the subject out and reinsert
        // it directly above the anchor.
        const from = order.indexOf(SUBJECT);
        if (from >= 0) {
          order.splice(from, 1);
          order.splice(order.indexOf(ANCHOR), 0, SUBJECT);
        }
        return Promise.resolve({ ok: true, stdout: "DONE", stderr: "" });
      }
      return Promise.resolve({ ok: true, stdout: "DONE", stderr: "" });
    },
    aux: {
      areaState: (): AreaSidebarState => ({
        areas: order.map((t, i) => ({ uuid: `u-${t}`, title: t, index: (i + 1) * 10 })),
        assignmentsDigest: "D",
      }),
    },
  };
}

const driveWall = (
  run: (command: UiCommand) => Promise<UiRunResult>,
  aux: { areaState: () => AreaSidebarState },
): ReturnType<typeof driveSidebarAreaReorder> =>
  driveSidebarAreaReorder(
    { targetUuid: `u-${SUBJECT}`, targetTitle: SUBJECT, placement: before(ANCHOR) },
    run,
    aux,
    instantSleep,
  );

describe("collapse rung — folding a wall away and putting it back", () => {
  it("collapses the blocking section, crosses it, and re-expands it", async () => {
    const sim = collapseSim({ projects: { Eta: 20 }, order: ONE_WALL });
    const res = await driveWall(sim.run, sim.aux);
    expect(res.ok).toBe(true);
    expect(res.collapsed).toEqual(["Eta"]);
    expect(res.restoreFailed).toBeUndefined();
    expect(res.detail).toContain("collapsed to clear the path");
    expect(res.detail).toContain("expanded again afterwards");
    // the gesture DID happen — the wall stopped being a wall
    expect(sim.log).toContain("sidebar-drag");
    // folded once, unfolded once, and the sidebar is left as it was found
    expect(sim.chevrons).toEqual(["Eta", "Eta"]);
    expect(sim.collapsedNow()).toEqual([]);
  });

  it("folds BOTH walls on the span and unwinds them last-in-first-out", async () => {
    const sim = collapseSim({ projects: { Eta: 20, Sigma: 18 }, order: TWO_WALLS });
    const res = await driveWall(sim.run, sim.aux);
    expect(res.ok, res.detail).toBe(true);
    // tallest first on the way down; reversed on the way back
    expect(res.collapsed).toEqual(["Eta", "Sigma"]);
    expect(sim.chevrons).toEqual(["Eta", "Sigma", "Sigma", "Eta"]);
    expect(sim.collapsedNow()).toEqual([]);
  });

  it("RESTORES the sidebar even when the move itself fails afterwards", async () => {
    // The whole point of the epilogue: a drive that folds the sidebar and then
    // dies must not leave the fold behind — the state survives a relaunch.
    const sim = collapseSim({ projects: { Eta: 20 }, order: ONE_WALL, brokenDrag: true });
    const res = await driveWall(sim.run, sim.aux);
    expect(res.ok).toBe(false);
    expect(res.collapsed).toEqual(["Eta"]);
    expect(sim.collapsedNow()).toEqual([]);
    expect(sim.chevrons).toEqual(["Eta", "Eta"]);
  });

  it("reports a failed re-expansion instead of leaving it unsaid", async () => {
    // The chevron works on the way down and stops working on the way back: the
    // move succeeded, but the sidebar is durably different and must say so.
    let folds = 0;
    const base = collapseSim({ projects: { Eta: 20 }, order: ONE_WALL });
    const run = (command: UiCommand): Promise<UiRunResult> => {
      if (command.primitive === "sidebar-chevron") {
        folds += 1;
        if (folds > 1) {
          base.chevrons.push((command.meta as { title: string }).title);
          return Promise.resolve({
            ok: true,
            stdout: JSON.stringify({ clicked: false, why: "the chevron is outside the band" }),
            stderr: "",
          });
        }
      }
      return base.run(command);
    };
    const res = await driveWall(run, base.aux);
    expect(res.ok).toBe(true);
    expect(res.restoreFailed).toEqual(["Eta"]);
    expect(res.detail).toContain("could not be expanded again");
    expect(base.collapsedNow()).toEqual(["Eta"]);
  });

  it("answers for a fold whose CONFIRMATION never came back", async () => {
    // SBCOL1 §6, found by killing Things mid-fold in the clone: the chevron
    // click landed and the app collapsed the area, then the re-census could not
    // run. A ledger written only on success held nothing, so a change that
    // survives a relaunch went unmentioned. The ledger keys off the CLICK.
    const base = collapseSim({ projects: { Eta: 20 }, order: ONE_WALL });
    let clicks = 0;
    const run = (command: UiCommand): Promise<UiRunResult> => {
      if (command.primitive === "sidebar-chevron") clicks += 1;
      // the sidebar stops answering the moment the fold has gone out
      if (clicks > 0 && command.primitive === "sidebar-snapshot") {
        return Promise.resolve({ ok: false, stdout: "", stderr: "-1719" });
      }
      return base.run(command);
    };
    const res = await driveWall(run, base.aux);
    expect(res.ok).toBe(false);
    // the fold IS reported, and reported as unrestored
    expect(res.collapsed).toEqual(["Eta"]);
    expect(res.restoreFailed).toEqual(["Eta"]);
    expect(res.detail).toContain("could not be expanded again");
  });

  it("never drags across a wall it could not fold", async () => {
    const sim = collapseSim({ projects: { Eta: 20 }, order: ONE_WALL, inertChevron: true });
    const res = await driveWall(sim.run, sim.aux);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("no disclosure chevron");
    expect(sim.log).not.toContain("sidebar-drag");
    // nothing was folded, so nothing is reported as folded
    expect(res.collapsed).toBeUndefined();
  });
});

// ---------------------------------- the normalization rung (SBRES1, #665/#651)
//
// MEASURED in the lab: View ▸ Hide Sidebar does NOT remove the sidebar from the
// Accessibility tree — the pane keeps its old frame while the content list
// slides over it — so the old driver "resolved" a hidden sidebar and then
// synthesized drags at coordinates that had become the content list. The
// snapshot now reports `sidebar-hidden`, and the ladder normalizes it through
// Things' own View menu rather than refusing (or, worse, dragging blind).
describe("normalization rung — a hidden sidebar", () => {
  it("shows the sidebar, completes the move, and hides it again", async () => {
    const sim = makeSim({ titles: ["A1", "A2", "A3"], viewportH: 610, sidebarHidden: true });
    const res = await drive(sim, "A1", { kind: "last" });
    expect(res.ok).toBe(true);
    expect(sim.order().at(-1)).toBe("A1");
    // shown once for the move, hidden once in the epilogue
    expect(sim.log.filter((p) => p === "sidebar-visibility")).toHaveLength(2);
    expect(res.detail).toContain("hidden again afterwards");
  });

  it("restores the sidebar even when the move fails", async () => {
    const sim = makeSim({
      titles: ["A1", "A2", "A3"],
      viewportH: 610,
      sidebarHidden: true,
      corruptDigestAfterDrag: true,
    });
    const res = await drive(sim, "A1", { kind: "last" });
    expect(res.ok).toBe(false);
    expect(sim.log.filter((p) => p === "sidebar-visibility")).toHaveLength(2);
  });

  it("refuses honestly — naming the View menu — when it cannot be shown", async () => {
    const sim = makeSim({
      titles: ["A1", "A2", "A3"],
      viewportH: 610,
      sidebarHidden: true,
      revealRefused: true,
    });
    const res = await drive(sim, "A1", { kind: "last" });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("hidden");
    expect(res.detail).toContain("Show Sidebar");
    // nothing was dragged at a phantom frame
    expect(sim.log).not.toContain("sidebar-drag");
  });
});

// --------------------------------------------- the locator itself (SBRES1)
describe("the sidebar locator script", () => {
  it("carries the caller's area titles — the semantic anchor", () => {
    const script = jxaSidebarSnapshotScript(["Work", "Home"]);
    expect(script).toContain('var TITLES = ["Work","Home"]');
    expect(script).toContain("resolveSidebar(TITLES");
  });

  it("keys on NO frame width at all", () => {
    // The #665/#651 bug in one assertion: the old locator picked "the narrowest
    // AXTable under 400pt", so a sidebar dragged to 612pt (measured — the
    // handle goes to at least 790) silently resolved to nothing.
    const script = jxaSidebarSnapshotScript(["Work"]);
    expect(script).not.toMatch(/\.\s*w\s*[<>]=?\s*\d{2,}/);
  });

  it("addresses the window by AXMain, never by position in AXChildren", () => {
    // MEASURED: the Things application element always exposes a 40x40 untitled
    // placeholder window and its menu bar alongside the real window(s), and with
    // two main windows open only one carries AXMain.
    const script = jxaSidebarSnapshotScript(["Work"]);
    expect(script).toContain("AXMain");
    expect(script).toContain("AXStandardWindow");
  });

  it("builds show/hide from Things' own View-menu items", () => {
    expect(jxaSidebarVisibilityScript("show")).toContain('"Show Sidebar"');
    expect(jxaSidebarVisibilityScript("hide")).toContain('"Hide Sidebar"');
  });
});
