/**
 * THE SPARSE CENSUS's arithmetic (ui-sidebar-map.ts) — the predictors, the
 * spacer classification and the carry-forward transforms, against synthetic
 * snapshots (no GUI, no osascript — AGENTS.md safety rails; the row shapes here
 * are invented, never copied from a real database).
 *
 * These functions are where a sparse read can go quietly wrong: a census that
 * realizes 14 of 174 rows is only sound if the 14 it picked really are the area
 * rows and the other 160 are classified correctly without being read. So every
 * predictor below is tested for what it does when it is RIGHT and for what it
 * says when it is wrong — the second half is the one the drive depends on,
 * because a prediction that cannot confirm must escalate to the full sweep
 * rather than be believed.
 */
import { describe, expect, it } from "vitest";

import {
  alignAreaOrdinals,
  classifySpacerRows,
  isRowRead,
  isSpacerRow,
  mapAfterReorder,
  mapFromCensus,
  modalRowHeight,
  ordinalsToRealize,
  predictAreaOrdinalsFromDb,
  rowMatchesTitle,
  sectionRowsFor,
  sectionStartOrdinals,
  type SidebarAreaMap,
  type SidebarRowInfo,
} from "../../src/write/vectors/ui-sidebar-map.ts";

// ------------------------------------------------------------- fixtures

const ROW_H = 24;
const SPACER_H = 16;

/** A row nobody realized: geometry only, exactly what a sparse census returns. */
function unread(y: number, h = ROW_H): SidebarRowInfo {
  return { x: 44, y, w: 240, h, text: "", read: false };
}
/** A row this census DID realize, carrying an area row's segment shape. */
function read(y: number, title: string, h = ROW_H): SidebarRowInfo {
  return { x: 44, y, w: 240, h, text: `${title}.|Source Toggle Template|${title}`, read: true };
}

/**
 * A sidebar shaped like the SBCHV1 fixture: built-in rows, then per area a
 * spacer, the area's own row, and its project rows. `realize` says which
 * ordinals this census read.
 */
function sidebar(
  areas: { title: string; projects: number }[],
  opts: { builtins?: number; realize?: (i: number) => string | null } = {},
): SidebarRowInfo[] {
  const rows: SidebarRowInfo[] = [];
  let y = 63;
  const push = (h: number): number => {
    const at = rows.length;
    rows.push(unread(y, h));
    y += h;
    return at;
  };
  for (let b = 0; b < (opts.builtins ?? 5); b++) push(ROW_H);
  push(SPACER_H);
  for (const area of areas) {
    push(ROW_H);
    for (let p = 0; p < area.projects; p++) push(ROW_H);
    push(SPACER_H);
  }
  if (opts.realize !== undefined) {
    for (const [i, row] of rows.entries()) {
      const title = opts.realize(i);
      if (title === null) continue;
      rows[i] = read(row.y, title, row.h);
    }
  }
  return rows;
}

/**
 * The area-row ordinals the fixture above actually produced — computed
 * independently of the predictor, so a predictor that agrees with it is
 * agreeing with the LAYOUT rather than with itself.
 */
function areaOrdinalsOf(areas: { title: string; projects: number }[], builtins = 5): number[] {
  const out: number[] = [];
  let cursor = builtins + 1; // the built-in rows, then the separating spacer
  for (const area of areas) {
    out.push(cursor);
    cursor += 1 + area.projects + 1; // the row, its projects, the trailing spacer
  }
  return out;
}

// ------------------------------------------------------- classification

describe("row kinds without reading a row", () => {
  it("an unrealized row is not 'a row with no content' — read() says which", () => {
    expect(isRowRead(unread(0))).toBe(false);
    expect(isRowRead(read(0, "Alpha"))).toBe(true);
    // A row from before sparse reads existed carries no flag and IS read.
    expect(isRowRead({ x: 0, y: 0, w: 1, h: 1, text: "" })).toBe(true);
  });

  it("the modal height is the ENTITY height, not the spacer's", () => {
    const rows = sidebar([{ title: "Alpha", projects: 3 }]);
    expect(modalRowHeight(rows)).toBe(ROW_H);
  });

  it("classifies unrealized rows by height class and realized ones by text", () => {
    const areas = [{ title: "Alpha", projects: 2 }];
    const ords = areaOrdinalsOf(areas);
    const rows = sidebar(areas, { realize: (i) => (i === ords[0] ? "Alpha" : null) });
    const out = classifySpacerRows(rows);
    expect(out.disagreements).toBe(0);
    expect(out.modalHeight).toBe(ROW_H);
    // The 16pt rows are spacers even though nobody read them.
    expect(out.rows.filter((r) => isSpacerRow(r)).map((r) => r.h)).toEqual([SPACER_H, SPACER_H]);
    expect(isSpacerRow(out.rows[ords[0] as number] as SidebarRowInfo)).toBe(false);
  });

  it("REPORTS a disagreement rather than picking a side (the sparse tripwire)", () => {
    // A realized row that harvested no text at the ENTITY height: the two
    // discriminators contradict each other, and the caller must escalate.
    const rows: SidebarRowInfo[] = [
      { x: 0, y: 0, w: 240, h: ROW_H, text: "", read: true },
      { x: 0, y: 24, w: 240, h: ROW_H, text: "Alpha", read: true },
      { x: 0, y: 48, w: 240, h: ROW_H, text: "Beta", read: true },
    ];
    expect(classifySpacerRows(rows).disagreements).toBe(1);
  });

  it("a sidebar with no spacers at all classifies nothing as a spacer", () => {
    const rows = [unread(0), unread(24), unread(48)];
    const out = classifySpacerRows(rows);
    expect(out.rows.every((r) => !isSpacerRow(r))).toBe(true);
    expect(out.disagreements).toBe(0);
  });
});

// ------------------------------------------------------------ predictors

describe("section starts (the geometry's own candidate set)", () => {
  it("finds every area row plus the built-in block, and no spacer", () => {
    const areas = [
      { title: "Alpha", projects: 3 },
      { title: "Beta", projects: 0 },
      { title: "Gamma", projects: 2 },
    ];
    const rows = classifySpacerRows(sidebar(areas)).rows;
    const starts = sectionStartOrdinals(rows);
    // Row 0 (the built-in block) plus one per area.
    expect(starts[0]).toBe(0);
    for (const ordinal of areaOrdinalsOf(areas)) expect(starts).toContain(ordinal);
    expect(starts.some((i) => isSpacerRow(rows[i] as SidebarRowInfo))).toBe(false);
  });

  it("is far cheaper than the sweep it replaces (candidate count, not row count)", () => {
    const areas = Array.from({ length: 14 }, (_, i) => ({ title: `A${i}`, projects: 6 }));
    const rows = classifySpacerRows(sidebar(areas)).rows;
    expect(rows.length).toBeGreaterThan(100);
    expect(sectionStartOrdinals(rows).length).toBe(15); // 14 areas + the built-in block
  });
});

describe("the database's arithmetic prediction (VOPAT1 §8 R1)", () => {
  const areas = [
    { uuid: "u1", title: "Alpha" },
    { uuid: "u2", title: "Beta" },
    { uuid: "u3", title: "Gamma" },
  ];
  const projectRows = { u1: 3, u2: 0, u3: 2 };

  it("predicts exactly the ordinals the same layout produces", () => {
    const shaped = [
      { title: "Alpha", projects: 3 },
      { title: "Beta", projects: 0 },
      { title: "Gamma", projects: 2 },
    ];
    // The fixture's shape, stated as the model's parameters: five built-in rows,
    // then one spacer per section ahead of each area row.
    expect(
      predictAreaOrdinalsFromDb({
        headerRows: 5,
        spacerPerSection: true,
        areas,
        projectRows,
        collapsed: null,
      }),
    ).toEqual(areaOrdinalsOf(shaped));
  });

  it("a FOLDED area contributes one row, so everything below it moves up", () => {
    const expanded = predictAreaOrdinalsFromDb({
      headerRows: 5,
      spacerPerSection: true,
      areas,
      projectRows,
      collapsed: [],
    });
    const folded = predictAreaOrdinalsFromDb({
      headerRows: 5,
      spacerPerSection: true,
      areas,
      projectRows,
      collapsed: ["u1"],
    });
    expect(folded[0]).toBe(expanded[0]);
    expect((expanded[1] as number) - (folded[1] as number)).toBe(3);
    expect((expanded[2] as number) - (folded[2] as number)).toBe(3);
  });

  it("every term is a parameter — a build that drops the per-section spacer shifts", () => {
    const flat = predictAreaOrdinalsFromDb({
      headerRows: 5,
      spacerPerSection: false,
      areas,
      projectRows,
      collapsed: null,
    });
    expect(flat).toEqual([5, 9, 10]);
  });
});

// ------------------------------------------------------------- alignment

describe("alignment against the database's own area order", () => {
  const dbTitles = ["Alpha", "Beta", "Gamma"];
  const shaped = [
    { title: "Alpha", projects: 3 },
    { title: "Beta", projects: 0 },
    { title: "Gamma", projects: 2 },
  ];
  const ords = areaOrdinalsOf(shaped);
  const realizeAreas = (i: number): string | null => {
    const at = ords.indexOf(i);
    return at < 0 ? null : (dbTitles[at] as string);
  };

  it("maps the realized rows onto the areas, in order", () => {
    const rows = classifySpacerRows(sidebar(shaped, { realize: realizeAreas })).rows;
    const out = alignAreaOrdinals(rows, dbTitles);
    expect(out).toEqual({ ok: true, ordinals: ords });
  });

  it("refuses when a predicted row did not carry the title it was predicted for", () => {
    const rows = classifySpacerRows(
      sidebar(shaped, { realize: (i) => (i === ords[1] ? "Somewhere Else" : realizeAreas(i)) }),
    ).rows;
    const out = alignAreaOrdinals(rows, dbTitles);
    expect(out.ok).toBe(false);
    // "Beta" was expected at that ordinal; the next area title the scan meets is
    // "Gamma", which is an area title in the WRONG PLACE — the loudest of the
    // two refusals, and the one that must never be reconciled silently.
    if (!out.ok) expect(out.why).toContain("out of database order");
  });

  it("refuses when the prediction simply missed an area row", () => {
    // Gamma's row was never realized: the census read two of three areas, which
    // is a prediction that cannot be believed rather than a two-area sidebar.
    const rows = classifySpacerRows(
      sidebar(shaped, { realize: (i) => (i === ords[2] ? null : realizeAreas(i)) }),
    ).rows;
    const out = alignAreaOrdinals(rows, dbTitles);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.why).toContain("only 2 of 3");
  });

  it("refuses when the app's order disagrees with the database's", () => {
    const swapped = ["Beta", "Alpha", "Gamma"];
    const rows = classifySpacerRows(sidebar(shaped, { realize: realizeAreas })).rows;
    const out = alignAreaOrdinals(rows, swapped);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.why).toContain("out of database order");
  });

  it("refuses an empty area list rather than mapping nothing successfully", () => {
    expect(alignAreaOrdinals([], []).ok).toBe(false);
  });

  it("section row counts run area row → next area row, last one → the bottom", () => {
    expect(sectionRowsFor(20, [6, 10, 11])).toEqual([4, 1, 9]);
  });

  it("duplicate titles map positionally (AXDRAG3), never by identity", () => {
    const dupes = ["Dupe", "Dupe"];
    const shape = [
      { title: "Dupe", projects: 0 },
      { title: "Dupe", projects: 0 },
    ];
    const o = areaOrdinalsOf(shape);
    const rows = classifySpacerRows(
      sidebar(shape, { realize: (i) => (o.includes(i) ? "Dupe" : null) }),
    ).rows;
    expect(alignAreaOrdinals(rows, dupes)).toEqual({ ok: true, ordinals: o });
  });
});

// --------------------------------------------------------- carry-forward

describe("carrying the map through a gesture", () => {
  const dbTitles = ["Alpha", "Beta", "Gamma"];
  const shaped = [
    { title: "Alpha", projects: 3 },
    { title: "Beta", projects: 0 },
    { title: "Gamma", projects: 2 },
  ];
  const ords = areaOrdinalsOf(shaped);
  const built = (): SidebarAreaMap => {
    const rows = classifySpacerRows(
      sidebar(shaped, {
        realize: (i) => {
          const at = ords.indexOf(i);
          return at < 0 ? null : (dbTitles[at] as string);
        },
      }),
    ).rows;
    const out = mapFromCensus(rows, dbTitles, "sweep", 1);
    if (!out.ok) throw new Error(out.why);
    return out.map;
  };

  it("a drop reorders the sections and keeps their sizes (the area travels)", () => {
    const map = built();
    const moved = mapAfterReorder(map, ["Beta", "Alpha", "Gamma"]);
    expect(moved).not.toBeNull();
    expect(moved?.areas.map((a) => a.title)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(moved?.areas.map((a) => a.rows)).toEqual([2, 5, 4]);
    // The first area row's ordinal is unchanged: nothing above the area list moved.
    expect(moved?.areas[0]?.ordinal).toBe(map.areas[0]?.ordinal);
    // and the sections are laid end to end from there, in the new order
    expect(moved?.areas[1]?.ordinal).toBe((map.areas[0]?.ordinal as number) + 2);
  });

  it("refuses to carry a reorder that is not a permutation (an area appeared)", () => {
    const map = built();
    expect(mapAfterReorder(map, ["Alpha", "Beta", "Gamma", "Delta"])).toBeNull();
    expect(mapAfterReorder(map, ["Alpha", "Beta", "Delta"])).toBeNull();
  });
});

describe("ordinalsToRealize", () => {
  it("drops what the sidebar cannot have, de-duplicates and orders", () => {
    expect(ordinalsToRealize([9, 3, 3, -1, 42, 1.5], 10)).toEqual([3, 9]);
  });

  it("keeps everything when the row count is not known yet", () => {
    expect(ordinalsToRealize([9, 3], null)).toEqual([3, 9]);
  });
});

describe("row identity is unchanged by the move to this module", () => {
  it("matches exact segments and the trailing-dot variant", () => {
    expect(rowMatchesTitle("Area-1.|Tmpl|Area-1", "Area-1")).toBe(true);
    expect(rowMatchesTitle("Area-11.|Tmpl|Area-11", "Area-1")).toBe(false);
  });
});
