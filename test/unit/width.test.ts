/**
 * Width-aware TTY row fitting (docs/design/width-aware-tty.md): the vendored
 * wcwidth, the segment fitter's ratified sacrifice order, the derived
 * MIN_FIT_WIDTH floor, and the formatItem byte-stability contract. The fitter
 * takes width explicitly, so every case is deterministic without a TTY.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  charWidth,
  clipPlain,
  fitRow,
  getFitWidth,
  resolveWidth,
  setFitWidth,
  stripSgr,
  TITLE_MIN,
  visibleWidth,
  type RowSegments,
} from "../../src/cli/width.ts";
import { formatItem, MIN_FIT_WIDTH, UUID_DISPLAY_MIN } from "../../src/cli/render.ts";
import {
  countChip,
  dateChip,
  deadlineToken,
  CHECKLIST_MARK,
  NOTES_MARK,
  REMINDER_MARK,
} from "../../src/cli/glyphs.ts";
import type { Project } from "../../src/model/entities.ts";
import { anytimeView, searchView } from "../../src/read/views.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo, tagTask } from "../fixtures/seed.ts";

// Fitting is a module-level setting; keep every test that touches it isolated.
afterEach(() => setFitWidth(null));

describe("vendored wcwidth (visibleWidth / charWidth)", () => {
  it("strips SGR escapes before measuring", () => {
    expect(visibleWidth("[2mhi[22m")).toBe(2);
    expect(visibleWidth("[1m[34mab[39m[22m")).toBe(2);
  });

  it("counts the glyph vocabulary as ONE cell each (ambiguous/narrow class)", () => {
    for (const g of ["★", "⏾", "⚑", "↻", "⍾", "≡", "◷", "≔", "⬡", "‹", "›"]) {
      expect(visibleWidth(g), `${g} should be 1 cell`).toBe(1);
    }
  });

  it("counts emoji-presentation and East-Asian-wide as TWO cells", () => {
    expect(visibleWidth("⭐️")).toBe(2); // U+2B50 + VS16 (FE0F counts 0)
    expect(charWidth(0x2b50)).toBe(2);
    expect(visibleWidth("世界")).toBe(4); // CJK
    expect(visibleWidth("⭐️ Habit")).toBe(2 + 1 + 5);
  });

  it("counts combining marks and zero-width joiners as zero", () => {
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfe0f)).toBe(0); // VS16
    expect(charWidth(0x0301)).toBe(0); // combining acute
  });
});

describe("clipPlain (width-aware plain truncation)", () => {
  it("truncates by cell width, never splitting a wide codepoint", () => {
    expect(clipPlain("hello", 3)).toBe("hel");
    expect(clipPlain("hello", 99)).toBe("hello");
    expect(clipPlain("世界x", 3)).toBe("世"); // 世=2, 界 would overflow 3
    expect(clipPlain("世界x", 4)).toBe("世界");
    expect(clipPlain("abc", 0)).toBe("");
  });
});

describe("resolveWidth", () => {
  const base = { columns: 120, isTTY: true };
  it("honors THINGS_WIDTH: a positive integer forces it, 0 disables", () => {
    expect(resolveWidth({ ...base, env: { THINGS_WIDTH: "90" } })).toBe(90);
    expect(resolveWidth({ ...base, env: { THINGS_WIDTH: "0" } })).toBeNull();
  });
  it("ignores a malformed THINGS_WIDTH and falls through", () => {
    expect(resolveWidth({ ...base, env: { THINGS_WIDTH: "wide" } })).toBe(120);
    expect(resolveWidth({ ...base, env: { THINGS_WIDTH: "-5" } })).toBe(120);
  });
  it("uses stdout.columns only on a TTY, else null (pipes/grep byte-stable)", () => {
    expect(resolveWidth({ env: {}, columns: 100, isTTY: true })).toBe(100);
    expect(resolveWidth({ env: {}, columns: 100, isTTY: false })).toBeNull();
    expect(resolveWidth({ env: {}, columns: undefined, isTTY: true })).toBeNull();
  });
});

// A RowSegments builder for the fitter, colors OFF (styleTitle/styleTags are
// identity + the leading-space wrap). `full` is composed exactly as the fitter
// composes a full row, so a fitting no-op returns this string verbatim.
function seg(over: Partial<RowSegments> & { rawTitle: string; tagNames: string[] }): RowSegments {
  const left = over.left ?? "id123456  [ ]";
  const tail = over.tail ?? "";
  const context = over.context ?? "";
  const deadline = over.deadline ?? "";
  const styleTitle = over.styleTitle ?? ((t: string) => t);
  const styleTags = over.styleTags ?? ((form: string) => ` ${form}`);
  const tagForm = (names: string[]): string => names.map((n) => `#${n}`).join(" ");
  const tags = over.tagNames.length > 0 ? styleTags(tagForm(over.tagNames)) : "";
  const full = `${left} ${styleTitle(over.rawTitle)}${tail}${tags}${context}${deadline}`;
  return {
    left,
    rawTitle: over.rawTitle,
    styleTitle,
    tail,
    tagNames: over.tagNames,
    styleTags,
    context,
    deadline,
    full,
  };
}

describe("fitRow — the ratified sacrifice order", () => {
  it("returns the full row verbatim when it already fits", () => {
    const s = seg({ rawTitle: "short", tagNames: ["a"] });
    expect(fitRow(s, 200)).toBe(s.full);
  });

  it("both-shrink: title truncates AND tags fold from the end under the 4:1 split", () => {
    // left 14 cols, 4 tags, 40-col title, no context/tail/deadline.
    const s = seg({ rawTitle: "A".repeat(40), tagNames: ["a", "b", "c", "d"] });
    const out = fitRow(s, 60);
    expect(visibleWidth(out)).toBeLessThanOrEqual(60);
    // Tags folded to two real + the overflow marker (progressive, from the end).
    expect(out).toContain(" #a #b #…");
    expect(out).not.toContain("#c");
    // Title truncated with a trailing ellipsis (its 4/5 share dominates).
    expect(out).toContain("…");
    expect(stripSgr(out)).toMatch(/A{30,}…/);
  });

  it("container drops WHOLE one stage BEFORE the last tag folds to bare", () => {
    const s = seg({
      rawTitle: "A".repeat(30),
      tagNames: ["red", "blue"],
      context: " (Proj)",
    });
    // Width band where the container is gone but a REAL tag still shows.
    const drop = fitRow(s, 40);
    expect(drop).not.toContain("(Proj)"); // container sacrificed
    expect(drop).toContain(" #red #…"); // a real tag survives (oneMarker)
    // A strictly NARROWER width folds the last tag to the bare marker.
    const bare = fitRow(s, 36);
    expect(bare).not.toContain("(Proj)");
    expect(bare).not.toContain("#red");
    expect(bare).toContain(" #…"); // bare marker only
    // Ordering proof: container death (width 40) is ABOVE last-tag fold (36).
    expect(40).toBeGreaterThan(36);
  });

  it("tags never fully vanish — the last tag folds to a bare `#…` marker", () => {
    const s = seg({ rawTitle: "A".repeat(30), tagNames: ["x", "y", "z"] });
    const bare = fitRow(s, 34); // narrow enough to reach the tags-bare stage
    expect(bare).toContain("#…");
    expect(bare).not.toContain("#x");
  });
});

describe("MIN_FIT_WIDTH — the single derived floor", () => {
  it("recomputes from the enumerated glyph parts (drift guard)", () => {
    const today = "2000-01-01";
    const box = "[ ]";
    const metaChip = dateChip("2027-09-22", today);
    const countChipWorst = countChip({
      untrashedLeafActionsCount: 999,
      openUntrashedLeafActionsCount: 999,
    } as Project);
    const tail = [countChipWorst, REMINDER_MARK, NOTES_MARK, CHECKLIST_MARK].join(" ");
    const deadline = deadlineToken("2000-01-15", today);
    const expected =
      UUID_DISPLAY_MIN +
      2 +
      visibleWidth(box) +
      1 +
      visibleWidth(metaChip) +
      1 +
      TITLE_MIN +
      1 +
      visibleWidth(tail) +
      1 +
      visibleWidth("#…") +
      1 +
      visibleWidth(deadline);
    expect(MIN_FIT_WIDTH).toBe(expected);
  });

  it("at width == MIN_FIT_WIDTH a maximal-furniture row's title is exactly TITLE_MIN", () => {
    const today = "2000-01-01";
    const left = `${"x".repeat(UUID_DISPLAY_MIN)}  [ ] ${dateChip("2027-09-22", today)}`;
    const tail = ` ${[
      countChip({ untrashedLeafActionsCount: 999, openUntrashedLeafActionsCount: 999 } as Project),
      REMINDER_MARK,
      NOTES_MARK,
      CHECKLIST_MARK,
    ].join(" ")}`;
    const deadline = ` ${deadlineToken("2000-01-15", today)}`;
    const s = seg({ rawTitle: "A".repeat(40), tagNames: ["tag"], left, tail, deadline });
    const out = fitRow(s, MIN_FIT_WIDTH);
    // The fitted title (raw A's plus the ellipsis) sits at exactly TITLE_MIN.
    const titleMatch = /A+…/.exec(stripSgr(out));
    expect(titleMatch).not.toBeNull();
    expect(visibleWidth(titleMatch?.[0] ?? "")).toBe(TITLE_MIN);
  });

  it("a lighter-furniture row keeps a LONGER title at the same floor width", () => {
    const s = seg({ rawTitle: "A".repeat(30), tagNames: ["a"], left: "xxxxxxxx  [ ]" });
    const out = fitRow(s, MIN_FIT_WIDTH);
    // Little furniture ⇒ the whole 30-col title fits (well above TITLE_MIN).
    expect(stripSgr(out)).toContain("A".repeat(30));
  });
});

describe("formatItem width plumbing", () => {
  const todo = {
    type: "to-do",
    uuid: "todo0001beefbeefbeefbeef0001",
    title: "A short title",
    notes: "",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
    area: null,
    tags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    created: new Date(0),
    modified: new Date(0),
    stopped: null,
    project: null,
    heading: null,
    checklistItemsCount: 0,
    openChecklistItemsCount: 0,
  } as unknown as Parameters<typeof formatItem>[0];

  it("null (the default) does NOT fit — byte-identical to the composed row", () => {
    setFitWidth(null);
    const unfit = formatItem(todo, 8);
    setFitWidth(500); // comfortably wide: a fit that changes nothing
    expect(formatItem(todo, 8)).toBe(unfit);
    expect(getFitWidth()).toBe(500);
  });

  it("clamps to MIN_FIT_WIDTH — a sub-floor width renders identically to the floor", () => {
    const longTodo = { ...todo, title: "B".repeat(80) } as typeof todo;
    setFitWidth(5); // far below the floor
    const subFloor = formatItem(longTodo, 8);
    setFitWidth(MIN_FIT_WIDTH);
    expect(formatItem(longTodo, 8)).toBe(subFloor);
    // …and the floor row truncates (never wraps) rather than printing 80 B's.
    expect(subFloor).toContain("…");
    expect(visibleWidth(subFloor)).toBeLessThanOrEqual(MIN_FIT_WIDTH);
  });

  it("a narrow width truncates the title with a trailing ellipsis", () => {
    const longTodo = { ...todo, title: "C".repeat(120) } as typeof todo;
    setFitWidth(100);
    const out = formatItem(longTodo, 8);
    expect(out).toContain("…");
    expect(visibleWidth(out)).toBeLessThanOrEqual(100);
  });
});

describe("byte-stability regression (real rows, colors off)", () => {
  let fixture: FixtureDb | null = null;
  afterEach(() => {
    fixture?.close();
    fixture = null;
    setFitWidth(null);
  });

  it("a comfortably-wide fit is a no-op — every representative row is unchanged", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Home");
    const project = seedProject(fixture.db, { title: "Garage", area });
    const tag = seedTag(fixture.db, "urgent");
    const t = seedTodo(fixture.db, {
      title: "Buy a very long list of miscellaneous hardware fasteners",
      project,
      startDate: "2027-01-20",
      deadline: "2027-02-06",
    });
    tagTask(fixture.db, t, tag);
    seedTodo(fixture.db, { title: "Someday maybe", start: "someday" });
    seedTodo(fixture.db, { title: "Repeats", recurrenceRule: true });
    const items = [
      ...anytimeView(fixture.db).flatMap((s) => s.items),
      ...searchView(fixture.db, "Someday"),
      ...searchView(fixture.db, "Repeats"),
    ];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      setFitWidth(null);
      const unfit = formatItem(item, 8);
      setFitWidth(500);
      expect(formatItem(item, 8), `row changed under a wide fit: ${unfit}`).toBe(unfit);
    }
  });
});
