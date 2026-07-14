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

describe("fitRow — lazy tag folding (widest fitting level, not an eager cap)", () => {
  // Mike's live repro shape: fixed furniture (left 14 + ` (Proj)` container),
  // tags `#home #recurring #housekeeping`, a 20-col title. Everything fits at
  // W=72; the collapse must step through the tag levels ONE at a time — never
  // jump straight to `#home #…` the moment folding begins.
  const accept = seg({
    rawTitle: "Water all the plants", // 20 cols
    tagNames: ["home", "recurring", "housekeeping"],
    context: " (Proj)",
  });

  it("at W everything fits; at W−1 only the LAST tag folds (not straight to `#first #…`)", () => {
    expect(stripSgr(fitRow(accept, 72))).toBe(
      "id123456  [ ] Water all the plants #home #recurring #housekeeping (Proj)",
    );
    // The bug fix: W−1 keeps TWO tags + the marker, and the title stays whole.
    expect(stripSgr(fitRow(accept, 71))).toBe(
      "id123456  [ ] Water all the plants #home #recurring #… (Proj)",
    );
  });

  it("steps through `#home #…` (container kept), then container-drop, then bare `#…`", () => {
    expect(stripSgr(fitRow(accept, 55))).toBe("id123456  [ ] Water all the plants #home #… (Proj)");
    // container-drop: the ` (Proj)` yields WHOLE while a real tag still shows.
    expect(stripSgr(fitRow(accept, 43))).toBe("id123456  [ ] Water all the plants #home #…");
    // tags-bare: the last tag folds once the container is already gone.
    expect(stripSgr(fitRow(accept, 37))).toBe("id123456  [ ] Water all the plants #…");
  });

  it("slack a discrete tag level leaves flows BACK to the title (not clamped to 4/5)", () => {
    // budgetFull = 45; tagShare = 9, titleShare = 36. The title (60) is over its
    // share and the tags (#ab #cd #ef, nat 12) over theirs — contention — but the
    // widest tag level that fits the 9-col cap is `#ab #…` at 7 cols, leaving 2
    // cols of slack. Those 2 cols go to the title: 38, not the bare 36 share.
    const s = seg({ rawTitle: "A".repeat(60), tagNames: ["ab", "cd", "ef"] });
    const out = stripSgr(fitRow(s, 59));
    expect(out).toContain("#ab #…");
    const titleChunk = /A+…/.exec(out)?.[0] ?? "";
    expect(visibleWidth(titleChunk)).toBe(38); // 36 share + 2 reclaimed
  });

  it("contention (both over their shares) arbitrates by the 4:1 ratio", () => {
    // Large title (40) + 4 tags, width 60: both exceed their shares, so the ratio
    // decides — tags capped at their 1/5, title truncated toward its 4/5.
    const s = seg({ rawTitle: "A".repeat(40), tagNames: ["a", "b", "c", "d"] });
    const out = stripSgr(fitRow(s, 60));
    expect(out).toBe("id123456  [ ] AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA… #a #b #…");
    expect(visibleWidth(out)).toBe(60);
  });

  it("when the TITLE is within its share, tags take everything left (Mike's bug direction)", () => {
    // Small title (10), three fat tags: the OLD eager 1/5 cap folded tags to
    // `#home #…` the instant fitting began; lazily they keep their widest level.
    const s = seg({ rawTitle: "A".repeat(10), tagNames: ["home", "recurring", "housekeeping"] });
    // budgetFull just one short of the full 41 → only the last tag folds.
    const out = stripSgr(fitRow(s, 54));
    expect(out).toContain("#home #recurring #…");
    expect(out).toContain("AAAAAAAAAA"); // the 10-col title survives whole
  });
});

describe("deadline gutter (experimental — right-pinned flag column)", () => {
  it("right-aligns the deadline token at the effective width across rows", () => {
    const short = seg({ rawTitle: "Short", tagNames: [], deadline: " ⚑ Aug 28" });
    const long = seg({ rawTitle: "A much longer title here", tagNames: [], deadline: " ⚑ Sep 1" });
    const a = fitRow(short, 60);
    const b = fitRow(long, 60);
    // Both rows fill exactly the effective width — the deadline lands in the
    // gutter (its token flush at the right edge), regardless of content length.
    expect(visibleWidth(a)).toBe(60);
    expect(visibleWidth(b)).toBe(60);
    expect(a.endsWith("⚑ Aug 28")).toBe(true);
    expect(b.endsWith("⚑ Sep 1")).toBe(true);
    // A shorter row gets MORE padding before the flag than a longer one.
    const padA = a.length - a.replace(/ +⚑/, "⚑").length;
    const padB = b.length - b.replace(/ +⚑/, "⚑").length;
    expect(padA).toBeGreaterThan(padB);
  });

  it("a row with no deadline is left ragged (no gutter padding)", () => {
    const s = seg({ rawTitle: "No deadline here", tagNames: [] });
    expect(fitRow(s, 60)).toBe("id123456  [ ] No deadline here");
  });

  it("a row that already fills the width keeps its inline deadline (≥ 1 space, byte-identical)", () => {
    // Title long enough that content + deadline already spans the width: the
    // gutter collapses to the single inline space (no change vs the unfitted form).
    const s = seg({ rawTitle: "A".repeat(60), tagNames: [], deadline: " ⚑ Sep 1" });
    const out = fitRow(s, 40);
    expect(out).not.toMatch(/ {2,}⚑/); // no gutter run — the row is full
    expect(out.endsWith(" ⚑ Sep 1")).toBe(true);
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
    setFitWidth(500); // comfortably wide: a fit that changes nothing (no deadline)
    expect(formatItem(todo, 8)).toBe(unfit);
    expect(getFitWidth()).toBe(500);
  });

  it("the deadline gutter is TTY-only — the null path never right-pins the flag", () => {
    const dueTodo = { ...todo, deadline: "2027-02-06" } as typeof todo;
    const opts = { now: new Date("2027-01-01T12:00:00Z") };
    setFitWidth(null);
    const unfit = formatItem(dueTodo, 8, opts);
    // Null path: the deadline stays inline — a single space before the flag.
    expect(unfit).toContain("⚑");
    expect(unfit).not.toMatch(/ {2,}⚑/);
    // Fitted at a wide width: the flag is pushed to the gutter (right edge).
    setFitWidth(120);
    const fit = formatItem(dueTodo, 8, opts);
    expect(fit).toMatch(/ {2,}⚑/);
    expect(visibleWidth(fit)).toBe(120);
    // …and collapsing that gutter run to one space reproduces the null-path row.
    expect(fit.replace(/ +⚑/, " ⚑")).toBe(unfit);
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

describe("canonical tag order survives the width fold (CPAP row, end-to-end)", () => {
  let fixture: FixtureDb | null = null;
  afterEach(() => {
    fixture?.close();
    fixture = null;
    setFitWidth(null);
  });

  it("folds from the END, so the canonically-FIRST tag (#recurring) is what survives", () => {
    fixture = buildFixtureDb();
    // Live CPAP indexes: recurring sorts first canonically, home/housekeeping after.
    const recurring = seedTag(fixture.db, "recurring", null, -16139);
    const home = seedTag(fixture.db, "home", null, -13475);
    const housekeeping = seedTag(fixture.db, "housekeeping", null, -13442);
    const t = seedTodo(fixture.db, { title: "Replace CPAP mask", startDate: "2026-07-02" });
    // Non-canonical assignment order — the render must still lead with #recurring.
    tagTask(fixture.db, t, home);
    tagTask(fixture.db, t, housekeeping);
    tagTask(fixture.db, t, recurring);

    const item = anytimeView(fixture.db)
      .flatMap((s) => s.items)
      .find((i) => i.title === "Replace CPAP mask");
    // The rendered tag ARRAY is canonical — exactly the order the fitter folds.
    expect(item?.tags.map((tg) => tg.title)).toEqual(["recurring", "home", "housekeeping"]);

    // render.ts builds RowSegments.tagNames straight from item.tags (array
    // order); the fitter folds that list from the END. So at a folding width
    // the canonically-FIRST tag survives — the alphabetical guess (#home first)
    // would instead have folded #recurring away.
    const tagNames = (item as NonNullable<typeof item>).tags.map((tg) => tg.title);
    const s = seg({ rawTitle: "A".repeat(10), tagNames });
    const out = stripSgr(fitRow(s, 42)); // narrow: only the first tag + marker fit
    expect(out).toContain("#recurring #…");
    expect(out).not.toContain("#housekeeping");
  });
});

describe("byte-stability regression (real rows, colors off)", () => {
  let fixture: FixtureDb | null = null;
  afterEach(() => {
    fixture?.close();
    fixture = null;
    setFitWidth(null);
  });

  // A wide fit changes nothing about a row's CONTENT; the one transform it adds
  // is the experimental deadline gutter (right-pinning the ⚑). Collapse that
  // gutter run back to the single inline space to compare against the null path.
  const collapseGutter = (s: string): string => s.replace(/ +⚑/, " ⚑");

  it("a comfortably-wide fit changes only the deadline gutter — content is unchanged", () => {
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
      ...searchView(fixture.db, "fasteners"), // the deadline-carrying row
      ...searchView(fixture.db, "Someday"),
      ...searchView(fixture.db, "Repeats"),
    ];
    expect(items.length).toBeGreaterThan(0);
    let sawGutter = false;
    for (const item of items) {
      setFitWidth(null);
      const unfit = formatItem(item, 8);
      setFitWidth(500);
      const fit = formatItem(item, 8);
      if (fit !== unfit) sawGutter = true;
      expect(collapseGutter(fit), `row content changed under a wide fit: ${unfit}`).toBe(unfit);
    }
    // The deadline-carrying row proves the gutter actually fired (else this
    // regression would silently pass even if the gutter never ran).
    expect(sawGutter).toBe(true);
  });
});
