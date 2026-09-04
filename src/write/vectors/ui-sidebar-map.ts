/**
 * THE SIDEBAR ROW MAP — read like a screen reader, not like a crawler
 * (VOPAT2 PR 2, #676).
 *
 * The sidebar census used to REALIZE every row: one batched content read per
 * row, 174 rows, 862 AX round-trips — and the ladder ran it before every scroll
 * iteration, after every fold and before every hop. On the maintainer's M1 one
 * such census costs **16–18 s** (18.6 ms per round-trip against 0.73 ms in a
 * clone, SBCHV1 §4) because the expensive thing is not the protocol but
 * REALIZING a custom row view onto a real display — ~115 ms per row realized
 * (VOPAT1 §7). A one-wall move to the end measured **436.5 s** in the field on
 * 0.20.8, and the gestures were ~5 s of it.
 *
 * So the census splits in two, and this module is the arithmetic half:
 *
 *  - **GEOMETRY is free** — `AXRows` plus one batched position/size read per row
 *    realizes nothing (~2 ms for 174 rows in the field, VOPAT1). Every consumer
 *    that wants extents, counts, `scrollableSpan` or a drop boundary is served
 *    by geometry alone.
 *  - **CONTENT is what costs** — so it is spent only on the rows that have to be
 *    IDENTIFIED: the area rows the next gesture aims at. Which rows those are is
 *    PREDICTED (from the previous census, from the section geometry, or from the
 *    database's own arithmetic) and then CONFIRMED by reading them. A prediction
 *    that does not confirm is never assumed: the caller escalates to the full
 *    sweep, which is retained unchanged as the oracle — exactly as SBRES1 kept
 *    its depth-6 walk behind the depth-2 harvest.
 *
 * Nothing here talks to the app. Every function is pure and unit-tested against
 * synthetic snapshots, because the predictors are where a sparse read can go
 * quietly wrong, and "quietly" is the part the AX-scrutiny doctrine forbids.
 */

/** A resolved AX frame in screen points. */
export interface SidebarRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SidebarRowInfo extends SidebarRect {
  /**
   * Concatenated descendant static-text segments, joined with "|" — EMPTY on a
   * row this census did not realize (see `read`). Consumers must not read
   * emptiness as "this row has no content"; ask {@link isSpacerRow} instead.
   */
  text: string;
  /**
   * Did this census realize the row's content? Absent means yes (a full sweep
   * reads every row), so every pre-VOPAT2 consumer and fixture keeps working.
   */
  read?: boolean;
  /**
   * Is this a SPACER row (the 16 pt gap Things renders between sections) rather
   * than an entity row? Text-derived on a realized row, height-derived on one
   * that was not (see {@link classifySpacerRows}). Absent means "ask the text".
   */
  spacer?: boolean;
}

/**
 * Did this census realize the row's content? A row that was not read carries no
 * text, and no consumer may infer anything from that emptiness.
 */
export function isRowRead(row: SidebarRowInfo): boolean {
  return row.read ?? true;
}

/**
 * Is this row a spacer? The classification is explicit when the census set it
 * and text-derived otherwise, which is what the driver did before sparse reads
 * existed (a spacer row is the only kind that harvests no static text at all).
 */
export function isSpacerRow(row: SidebarRowInfo): boolean {
  return row.spacer ?? row.text === "";
}

/**
 * Does a row's static-text carry this exact title as a segment? Sidebar row
 * text concatenates descendant static texts with "|" (AXDRAG1: e.g.
 * "Area-05.|Source Toggle Template|Area-05") — an exact segment match avoids
 * substring collisions; the trailing-dot variant covers the AXDescription-like
 * first segment some rows carry.
 */
export function rowMatchesTitle(text: string, title: string): boolean {
  return text.split("|").some((seg) => seg === title || seg === `${title}.`);
}

/**
 * Row heights are CONSTANT PER KIND (SBCHV1 §0, measured over 174 rows: entity
 * rows 24 pt including an area with no projects and a collapsed area, spacer
 * rows 16 pt), which is the property that lets a geometry-only pass tell the
 * two apart. This is a tolerance, never an aim point, and it is expressed
 * against the sidebar's OWN modal height rather than a pixel constant — a text-
 * size change rescales both classes together.
 */
const HEIGHT_CLASS_TOLERANCE_PX = 1;

/** The most common row height in this census, or null when there are no rows. */
export function modalRowHeight(rows: readonly SidebarRowInfo[]): number | null {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const key = Math.round(row.h * 2) / 2;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [height, count] of counts) {
    // Ties break toward the TALLER height: entity rows are the tall class and
    // the majority class, and a tie is the shape a tiny sidebar makes.
    if (count > bestCount || (count === bestCount && best !== null && height > best)) {
      best = height;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Classify every row as spacer or entity, and say whether the two available
 * discriminators DISAGREED anywhere.
 *
 * A realized row is classified by its text (empty ⇒ spacer), which is what the
 * driver has always done. A row this census did not realize is classified by
 * its HEIGHT CLASS: shorter than the sidebar's modal row height ⇒ spacer. The
 * disagreement count is the sparse read's own tripwire — on a sidebar whose
 * spacers are NOT the short class the height rule would invert, and a caller
 * that sees a disagreement escalates to the full sweep rather than trusting a
 * classification it cannot check.
 */
export function classifySpacerRows(rows: readonly SidebarRowInfo[]): {
  rows: SidebarRowInfo[];
  /** Realized rows whose text and height classes disagree. */
  disagreements: number;
  /** The modal (entity) row height this classification used. */
  modalHeight: number | null;
} {
  const modalHeight = modalRowHeight(rows);
  let disagreements = 0;
  const out: SidebarRowInfo[] = [];
  for (const row of rows) {
    const byHeight = modalHeight !== null && row.h < modalHeight - HEIGHT_CLASS_TOLERANCE_PX;
    const byText = row.text === "";
    const read = isRowRead(row);
    if (read && byText !== byHeight) disagreements += 1;
    out.push({
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      text: row.text,
      read,
      spacer: read ? byText : byHeight,
    });
  }
  return { rows: out, disagreements, modalHeight };
}

/**
 * Where a SECTION begins, by geometry alone: the first row, and every entity
 * row whose predecessor is a spacer.
 *
 * This is the cheap candidate set for identifying area rows without a sweep.
 * Things renders a spacer between sections (SBCHV1 §0 counted 17 of them on a
 * 14-area sidebar), so an area row is nearly always a section start — but the
 * driver never ASSUMES that: the candidates are read, and the alignment below
 * either produces every area in database order or fails and escalates.
 *
 * Rows must be in visual (y) order.
 */
export function sectionStartOrdinals(rows: readonly SidebarRowInfo[]): number[] {
  const out: number[] = [];
  for (const [i, row] of rows.entries()) {
    if (isSpacerRow(row)) continue;
    const prev = i === 0 ? undefined : rows[i - 1];
    if (prev === undefined || isSpacerRow(prev)) out.push(i);
  }
  return out;
}

/** One area's sidebar section, as the map knows it. */
export interface MappedArea {
  /** The area row's ordinal in the census's row list. */
  ordinal: number;
  title: string;
  /** Rows the section renders, its own row included (geometry-derived). */
  rows: number;
}

/** How a census learned which rows are area rows. */
export type MapSource =
  /** A full depth-2 sweep read every row — the oracle. */
  | "sweep"
  /** Content read on the geometry's own section starts. */
  | "section-starts"
  /** Content read at ordinals predicted from the previous census. */
  | "carried"
  /** Content read at ordinals predicted from the database's row arithmetic. */
  | "db-arithmetic";

/**
 * The area rows a census identified, plus what it cost to identify them. Carried
 * across the drive so a cost paid once is not paid again.
 */
export interface SidebarAreaMap {
  areas: MappedArea[];
  /** Rows the census that produced this map saw (the shape guard). */
  totalRows: number;
  /** Which candidate list pane was the sidebar, for the next census's locator. */
  paneIndex: number | null;
  source: MapSource;
}

/**
 * Align the realized rows of a census against the database's own area order.
 *
 * The sidebar renders areas in `TMArea."index" ASC, uuid ASC` — the same order
 * the caller reads them in (AXDRAG3, pinned three times) — so the area rows are
 * the realized rows that carry those titles IN THAT ORDER. This requires an
 * exact, complete, in-order match: every database area, once, in sequence.
 * Anything else (a missing title, a title out of order, an extra realized row
 * carrying an area title outside the run) returns a refusal, and the caller
 * escalates. Duplicate titles are handled by position, which is what the
 * positional disambiguation everywhere else in this driver already assumes.
 */
export function alignAreaOrdinals(
  rows: readonly SidebarRowInfo[],
  dbTitles: readonly string[],
): { ok: true; ordinals: number[] } | { ok: false; why: string } {
  if (dbTitles.length === 0) return { ok: false, why: "the database holds no areas" };
  const ordinals: number[] = [];
  let want = 0;
  for (const [i, row] of rows.entries()) {
    if (!isRowRead(row) || isSpacerRow(row)) continue;
    const title = dbTitles[want];
    if (title !== undefined && rowMatchesTitle(row.text, title)) {
      ordinals.push(i);
      want += 1;
      continue;
    }
    // A realized row carrying an area title we are not expecting HERE means the
    // prediction and the app disagree about the order — never a thing to
    // reconcile silently.
    if (dbTitles.some((t) => rowMatchesTitle(row.text, t))) {
      return {
        ok: false,
        why: `row ${i} carries an area title out of database order (expected "${title ?? "—"}")`,
      };
    }
  }
  if (want < dbTitles.length) {
    return {
      ok: false,
      why: `only ${want} of ${dbTitles.length} area row(s) were identified`,
    };
  }
  return { ok: true, ordinals };
}

/**
 * Section row counts from the geometry: an area's section runs from its own row
 * to the next area row, and the last one to the bottom of the table — the same
 * span rule `sectionRowCount` has always used, computed on ordinals rather than
 * on y so it is available without content.
 */
export function sectionRowsFor(totalRows: number, ordinals: readonly number[]): number[] {
  return ordinals.map((ordinal, i) => Math.max(1, (ordinals[i + 1] ?? totalRows) - ordinal));
}

/** Build a map from a census's realized rows and the database's area order. */
export function mapFromCensus(
  rows: readonly SidebarRowInfo[],
  dbTitles: readonly string[],
  source: MapSource,
  paneIndex: number | null,
): { ok: true; map: SidebarAreaMap } | { ok: false; why: string } {
  const aligned = alignAreaOrdinals(rows, dbTitles);
  if (!aligned.ok) return aligned;
  const counts = sectionRowsFor(rows.length, aligned.ordinals);
  return {
    ok: true,
    map: {
      areas: aligned.ordinals.map((ordinal, i) => ({
        ordinal,
        title: dbTitles[i] as string,
        rows: counts[i] as number,
      })),
      totalRows: rows.length,
      paneIndex,
      source,
    },
  };
}

/**
 * The map after a DROP reordered the areas.
 *
 * An area's whole section travels with it (its project rows are its children),
 * so the row counts are unchanged and only their ORDER is — and the new order
 * is what the post-drop database assert has just read. The first area row's
 * ordinal is unchanged, because everything above the area list (the built-in
 * rows) is untouched by a reorder.
 *
 * Returns null when the new order is not a permutation of the old one (an area
 * added or removed underneath us, which the invariant asserts already refuse).
 */
export function mapAfterReorder(
  map: SidebarAreaMap,
  newTitleOrder: readonly string[],
): SidebarAreaMap | null {
  if (newTitleOrder.length !== map.areas.length) return null;
  const pool = map.areas.map((a) => ({ ...a, taken: false }));
  const picked: MappedArea[] = [];
  for (const title of newTitleOrder) {
    const found = pool.find((a) => !a.taken && a.title === title);
    if (found === undefined) return null;
    found.taken = true;
    picked.push({ ordinal: 0, title: found.title, rows: found.rows });
  }
  let cursor = (map.areas[0] as MappedArea).ordinal;
  const areas: MappedArea[] = [];
  for (const area of picked) {
    areas.push({ ordinal: cursor, title: area.title, rows: area.rows });
    cursor += area.rows;
  }
  if (areas.some((a) => a.ordinal < 0 || a.ordinal >= map.totalRows)) return null;
  return { ...map, areas, source: "carried" };
}

/**
 * The DATABASE's own arithmetic prediction of the area row ordinals — the
 * shape VOPAT1 §8 R1 specified, kept as the predictor of last resort before the
 * full sweep and as the thing the lab measures against a sweep.
 *
 * The model, stated so a mismatch is attributable rather than mysterious: the
 * sidebar renders `headerRows` fixed rows above the area list (the built-in
 * lists, identified locale-independently by their `Source Inbox … Source Trash`
 * image descriptions, SBCHV1 §7); then, per area in database order, an optional
 * spacer row, the area's own row, and — unless the area is folded — one row per
 * project the app renders under it.
 *
 * Every term is a PARAMETER rather than a constant, because two of them are
 * facts about a Things build rather than about the user's data, and a build
 * that changes one must produce a mismatch here (and a fall-through to the
 * sweep), never a silently wrong ordinal.
 */
export interface DbRowModel {
  /** Fixed rows above the first area row (built-in lists + their spacers). */
  headerRows: number;
  /** Does each section carry a spacer row above its area row? */
  spacerPerSection: boolean;
  /** Areas in database order: `(index, uuid)` ASC. */
  areas: readonly { uuid: string; title: string }[];
  /** Project rows the app renders under each area, by uuid. */
  projectRows: Readonly<Record<string, number>>;
  /** Area uuids the app has folded (`collapsedAreaUUIDs`), or null when unread. */
  collapsed: readonly string[] | null;
}

export function predictAreaOrdinalsFromDb(model: DbRowModel): number[] {
  const folded = new Set(model.collapsed ?? []);
  const out: number[] = [];
  let cursor = model.headerRows;
  for (const area of model.areas) {
    if (model.spacerPerSection) cursor += 1;
    out.push(cursor);
    cursor += 1;
    if (!folded.has(area.uuid)) cursor += model.projectRows[area.uuid] ?? 0;
  }
  return out;
}

/**
 * The ordinals a sparse census should realize, given the best prediction
 * available — the area rows, and nothing else. Out-of-range ordinals are
 * dropped rather than sent to the script, because an ordinal the sidebar does
 * not have is a prediction failure to be discovered by the alignment (which
 * reports it in the words above) and not an AX error to be interpreted.
 */
export function ordinalsToRealize(
  predicted: readonly number[],
  totalRowsHint: number | null,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const ordinal of predicted) {
    if (!Number.isInteger(ordinal) || ordinal < 0) continue;
    if (totalRowsHint !== null && ordinal >= totalRowsHint) continue;
    if (seen.has(ordinal)) continue;
    seen.add(ordinal);
    out.push(ordinal);
  }
  return out.toSorted((a, b) => a - b);
}
