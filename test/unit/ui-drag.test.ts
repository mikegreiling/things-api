/**
 * Sidebar drag driver (ui-drag.ts) — geometry + ladder logic, driven entirely
 * through the injectable UiRunner seam against a scripted sidebar SIMULATOR
 * (no GUI, no osascript — CLAUDE.md safety rails). The simulator models the
 * AXDRAG1 layout: entity rows + spacer rows, a scrollable viewport, drop
 * resolution against the LIVE (source-lifted) layout, and the sparse-index
 * rewrite on drop.
 */
import { describe, expect, it } from "vitest";

import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";
import {
  areaRowsInOrder,
  boundaryAboveRow,
  boundaryBelowLast,
  correctedDropY,
  driveSidebarAreaReorder,
  findAreaRow,
  parseSidebarSnapshot,
  placementSatisfied,
  rowMatchesTitle,
  slotPitch,
  sourceGroupSpan,
  type AreaSidebarState,
  type SidebarPlacement,
  type SidebarRowInfo,
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
    const snap = parseSidebarSnapshot(
      JSON.stringify({
        viewport: { x: VIEW_X, y: VIEW_Y, w: 240, h: 610 },
        scroll: 0.5,
        rows: [entityRow("A", 100), { text: "ghost", x: null, y: null, w: null, h: null }],
      }),
    );
    expect(snap?.rows).toHaveLength(1);
    expect(snap?.scroll).toBe(0.5);
  });
  it("returns null on non-JSON output", () => {
    expect(parseSidebarSnapshot("execution error: …")).toBeNull();
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

  const run = (command: UiCommand): Promise<UiRunResult> => {
    log.push(command.primitive);
    const script = command.script ?? "";
    if (command.primitive === "sidebar-snapshot") {
      if (options.failSnapshots === true) {
        return Promise.resolve({ ok: false, stdout: "", stderr: "-1719" });
      }
      return Promise.resolve({ ok: true, stdout: snapshot(), stderr: "" });
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

describe("ladder — rung 3 (multi-hop fallback)", () => {
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
