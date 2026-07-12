/**
 * Human list rendering (GUI-parity layout): the glyph language ([ ]/[✓]/[×]/
 * [~] boxes, ( )-family project circles, ‹date› chips, logged dates, ≡ notes
 * marker), grouped project blocks with styled title rows, suppression of
 * container names implied by the grouping, tags after the title. Colors are
 * OFF here (non-TTY), so assertions see the plain-text skeleton — spacing,
 * ordering, suppression, and the color-stripped state glyphs.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  anytimeView,
  logbookView,
  projectsView,
  searchView,
  somedayView,
  upcomingView,
} from "../../src/read/views.ts";
import { projectView } from "../../src/read/project-view.ts";
import {
  formatItem,
  parsePeriodEnd,
  parsePeriodStart,
  renderLogbook,
  renderProjectsSidebar,
  renderSections,
  renderUpcoming,
  todayMark,
} from "../../src/cli/commands/reads.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagTask,
} from "../fixtures/seed.ts";

let fixture: FixtureDb | null = null;
afterEach(() => {
  fixture?.close();
  fixture = null;
});

const NOW = new Date("2026-07-05T12:00:00Z");

function seedHobbies(fx: FixtureDb): { area: string; firmware: string; fasteners: string } {
  const area = seedArea(fx.db, "Hobbies");
  const firmware = seedProject(fx.db, { title: "Firmware Updates", area, index: 1 });
  const fasteners = seedProject(fx.db, { title: "Astro City Fasteners", area, index: 2 });
  seedTodo(fx.db, { title: "Upgrade RetroTink", project: firmware, index: 1 });
  seedTodo(fx.db, { title: "Update Krikzz", project: firmware, index: 2 });
  seedTodo(fx.db, { title: "Sort the bags", project: fasteners, index: 3 });
  return { area, firmware, fasteners };
}

describe("renderSections (anytime/someday layout)", () => {
  it("groups project blocks with blank lines, suppresses implied containers", () => {
    fixture = buildFixtureDb();
    const { fasteners } = seedHobbies(fixture);
    const tag = seedTag(fixture.db, "interest");
    tagTask(fixture.db, fasteners, tag);

    const lines = renderSections(anytimeView(fixture.db, NOW));
    const text = lines.join("\n");

    // Area header (with the ⬡ area mark), blank line, then the first project block.
    expect(lines[0]).toBe("── ⬡ Hobbies ──");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("Firmware Updates");
    // Project title rows carry the circle glyph, never the redundant (Hobbies).
    expect(lines[2]).toContain("( )");
    expect(text).not.toContain("(Hobbies)");
    // Members drop the redundant (project) suffix.
    expect(text).not.toContain("(Firmware Updates)");
    expect(text).toContain("[ ] Upgrade RetroTink");
    // Blank line separates the two project groups.
    const fastenersAt = lines.findIndex((l) => l.includes("Astro City Fasteners"));
    expect(lines[fastenersAt - 1]).toBe("");
    // Tags render AFTER the title and the ratio chip.
    expect(lines[fastenersAt]).toMatch(/Astro City Fasteners ‹\d+(?:\/\d+)?› #interest$/);
  });

  it("keeps the (project) suffix when the project's own row is absent", () => {
    fixture = buildFixtureDb();
    const { fasteners } = seedHobbies(fixture);
    const tag = seedTag(fixture.db, "focus");
    const t = seedTodo(fixture.db, { title: "Tagged child", project: fasteners, index: 9 });
    tagTask(fixture.db, t, tag);

    // Tag filter: only the child matches — no project title row above it.
    const lines = renderSections(anytimeView(fixture.db, NOW, { tag: "focus" }));
    const row = lines.find((l) => l.includes("Tagged child"));
    expect(row).toContain("(Astro City Fasteners)");
  });

  it("renders loose to-dos before project groups, headerless top block first", () => {
    fixture = buildFixtureDb();
    seedHobbies(fixture);
    seedTodo(fixture.db, { title: "Loose top-level", index: 0 });

    const lines = renderSections(anytimeView(fixture.db, NOW));
    expect(lines[0]).toContain("Loose top-level");
    expect(lines.findIndex((l) => l.includes("⬡ Hobbies ──"))).toBeGreaterThan(0);
  });
});

describe("things projects — sidebar mirror", () => {
  it("orders loose-first, then areas by sidebar rank (not title), suppressing (Area)", () => {
    fixture = buildFixtureDb();
    // Reverse-alphabetical area indexes prove rank order beats title order.
    const zebra = seedArea(fixture.db, "Zebra", 1);
    const alpha = seedArea(fixture.db, "Alpha", 2);
    // Global TMTask indexes deliberately interleave the groups: the raw-index
    // dump (the old behavior) would shuffle these across areas.
    seedProject(fixture.db, { title: "In Alpha", area: alpha, index: 1 });
    seedProject(fixture.db, { title: "Loose one", index: 2 });
    seedProject(fixture.db, { title: "Zebra second", area: zebra, index: 5 });
    seedProject(fixture.db, { title: "Zebra first", area: zebra, index: 3 });

    const items = projectsView(fixture.db);
    expect(items.map((i) => i.title)).toEqual([
      "Loose one",
      "Zebra first",
      "Zebra second",
      "In Alpha",
    ]);

    const lines = renderProjectsSidebar(items);
    // Loose block first, headerless; then ⬡ headers in rank order.
    expect(lines[0]).toContain("Loose one");
    const zebraAt = lines.findIndex((l) => l.includes("⬡ Zebra ──"));
    const alphaAt = lines.findIndex((l) => l.includes("⬡ Alpha ──"));
    expect(zebraAt).toBeGreaterThan(0);
    expect(alphaAt).toBeGreaterThan(zebraAt);
    // Rows under a header drop the redundant (Area) suffix.
    expect(lines.join("\n")).not.toContain("(Zebra)");
    expect(lines.join("\n")).not.toContain("(Alpha)");
  });

  it("hides LATER (someday + future-scheduled) projects by default; arrived-scheduled stays", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Zone", 1);
    seedProject(fixture.db, { title: "Active", area, index: 1 });
    seedProject(fixture.db, { title: "Someday", area, start: "someday", index: 2 });
    seedProject(fixture.db, {
      title: "Future",
      area,
      start: "someday",
      startDate: "2026-10-19",
      index: 3,
    });
    // A scheduled project whose date ARRIVED is active (the Anytime test).
    seedProject(fixture.db, {
      title: "Arrived",
      area,
      start: "someday",
      startDate: "2026-07-01",
      index: 4,
    });

    expect(projectsView(fixture.db, { now: NOW }).map((i) => i.title)).toEqual([
      "Active",
      "Arrived",
    ]);
  });

  it("--show-later appends later projects AFTER each group's active block, never intermingled", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Zone", 1);
    // Global indexes deliberately interleave: later(1), active(2), later(3), active(4).
    seedProject(fixture.db, { title: "Someday early", area, start: "someday", index: 1 });
    seedProject(fixture.db, { title: "Active A", area, index: 2 });
    seedProject(fixture.db, {
      title: "Future mid",
      area,
      start: "someday",
      startDate: "2026-10-19",
      index: 3,
    });
    seedProject(fixture.db, { title: "Active B", area, index: 4 });

    expect(projectsView(fixture.db, { later: true, now: NOW }).map((i) => i.title)).toEqual([
      "Active A",
      "Active B",
      "Someday early",
      "Future mid",
    ]);
  });
});

describe("project title rows", () => {
  it("area show styles project rows as titles and suppresses the area name", () => {
    fixture = buildFixtureDb();
    seedHobbies(fixture);
    // The renderers are exercised through renderSections above; here just
    // assert the formatItem contract directly for the title form.
    const [section] = anytimeView(fixture.db, NOW);
    const project = section?.items.find((i) => i.type === "project");
    expect(project).toBeDefined();
    if (!project || !project.area) return;
    const line = formatItem(project, 8, { projectTitle: true, suppressArea: project.area.uuid });
    // uuid column, circle glyph, styled title, ratio chip — no (Hobbies).
    expect(line).toMatch(/^proj-\d+ {2}\( \) Firmware Updates ‹\d+(?:\/\d+)?›$/);
  });
});

describe("formatItem", () => {
  it("orders tokens: uuid, box, chip, deadline, title, (context), #tags", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Errands");
    const p = seedProject(fixture.db, { title: "Groceries", area });
    const tag = seedTag(fixture.db, "urgent");
    const t = seedTodo(fixture.db, {
      title: "Buy milk",
      project: p,
      startDate: "2026-07-20",
      deadline: "2026-07-06",
    });
    tagTask(fixture.db, t, tag);
    const [item] = searchView(fixture.db, "Buy milk");
    expect(item).toBeDefined();
    if (!item) return;
    const line = formatItem(item, 8, { now: NOW });
    // Future startDate renders as the schedule chip before the title; tags
    // precede the container hint; the near deadline renders as the GUI's
    // relative flag at the END.
    expect(line).toMatch(/\[ \] ‹Jul 20› Buy milk #urgent \(Groceries\) ⚑ 1 day left$/);
  });

  it("suppresses the date chip when the startDate is today or past", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Due now", startDate: "2026-07-05" });
    const [item] = searchView(fixture.db, "Due now");
    if (!item) throw new Error("seed missing");
    expect(formatItem(item, 8, { now: NOW })).toMatch(/\[ \] Due now$/);
  });

  it("appends the year to chips outside the current year", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Far future", startDate: "2027-01-02" });
    const [item] = searchView(fixture.db, "Far future");
    if (!item) throw new Error("seed missing");
    expect(formatItem(item, 8, { now: NOW })).toContain("‹Jan 2 2027›");
  });

  it("renders completed rows as [✓] with the logged date", () => {
    fixture = buildFixtureDb();
    // 2025-06-15T12:00:00Z — a prior year, so the logged date carries it.
    seedTodo(fixture.db, {
      title: "Old win",
      status: "completed",
      stopDate: new Date("2025-06-15T12:00:00Z").getTime() / 1000,
    });
    const [item] = searchView(fixture.db, "Old win", { logged: true });
    if (!item) throw new Error("seed missing");
    expect(formatItem(item, 8, { now: NOW })).toMatch(/\[✓\] Jun 15 2025 Old win$/);
  });

  it("renders canceled rows as [×]", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, {
      title: "Abandoned",
      status: "canceled",
      stopDate: new Date("2026-07-01T12:00:00Z").getTime() / 1000,
    });
    const [item] = searchView(fixture.db, "Abandoned", { logged: true });
    if (!item) throw new Error("seed missing");
    // Same-year logged date drops the year.
    expect(formatItem(item, 8, { now: NOW })).toMatch(/\[×\] Jul 1 Abandoned$/);
  });

  it("renders undated someday rows as [~]", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Maybe later", start: "someday" });
    const sections = somedayView(fixture.db);
    const item = sections.flatMap((s) => s.items).find((i) => i.title === "Maybe later");
    if (!item) throw new Error("seed missing");
    expect(formatItem(item, 8, { now: NOW })).toMatch(/\[~\] Maybe later$/);
  });

  it("marks rows that carry notes with ≡", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Documented", notes: "the details" });
    const [item] = searchView(fixture.db, "Documented");
    if (!item) throw new Error("seed missing");
    expect(formatItem(item, 8, { now: NOW })).toMatch(/\[ \] Documented ≡$/);
  });

  it("labels heading-nested rows with the parent PROJECT, not the heading", () => {
    fixture = buildFixtureDb();
    const p = seedProject(fixture.db, { title: "Restore Cabinet" });
    const h = seedHeading(fixture.db, { title: "Power Supply", project: p });
    seedTodo(fixture.db, { title: "Replace caps", heading: h });
    const [item] = searchView(fixture.db, "Replace caps");
    if (!item) throw new Error("seed missing");
    const line = formatItem(item, 8, { now: NOW });
    expect(line).toContain("(Restore Cabinet)");
    expect(line).not.toContain("(Power Supply)");
    // The suffix suppresses like a direct project membership.
    expect(formatItem(item, 8, { now: NOW, suppressProject: p })).not.toContain(
      "(Restore Cabinet)",
    );
  });
});

describe("logbook", () => {
  const stopAt = (iso: string) => new Date(iso).getTime() / 1000;

  function seedLoggedWorld(fx: FixtureDb): { area: string; project: string } {
    const area = seedArea(fx.db, "Home");
    const project = seedProject(fx.db, { title: "Garage", area });
    const heading = seedHeading(fx.db, { title: "Shelving", project });
    seedTodo(fx.db, {
      title: "Direct area win",
      area,
      status: "completed",
      stopDate: stopAt("2026-07-01T12:00:00Z"),
    });
    seedTodo(fx.db, {
      title: "Project child win",
      project,
      status: "completed",
      stopDate: stopAt("2026-06-10T12:00:00Z"),
    });
    seedTodo(fx.db, {
      title: "Heading child win",
      heading,
      status: "completed",
      stopDate: stopAt("2025-03-05T12:00:00Z"),
    });
    seedTodo(fx.db, {
      title: "Unrelated win",
      status: "completed",
      stopDate: stopAt("2026-07-02T12:00:00Z"),
    });
    return { area, project };
  }

  it("--area includes direct, project-child, and HEADING-child entries", () => {
    fixture = buildFixtureDb();
    const { area } = seedLoggedWorld(fixture);
    const titles = logbookView(fixture.db, { area }).map((i) => i.title);
    expect(titles).toEqual(["Direct area win", "Project child win", "Heading child win"]);
  });

  it("--project includes heading-nested children", () => {
    fixture = buildFixtureDb();
    const { project } = seedLoggedWorld(fixture);
    const titles = logbookView(fixture.db, { project }).map((i) => i.title);
    expect(titles).toEqual(["Project child win", "Heading child win"]);
  });

  it("--since/--until bound by logged instant", () => {
    fixture = buildFixtureDb();
    const { area } = seedLoggedWorld(fixture);
    const titles = logbookView(fixture.db, {
      area,
      since: new Date("2026-01-01T00:00:00Z"),
      until: parsePeriodEnd("2026-06"),
    }).map((i) => i.title);
    expect(titles).toEqual(["Project child win"]);
  });

  it("renders month headings (year appended beyond the current year) and no heading rows", () => {
    fixture = buildFixtureDb();
    const { area } = seedLoggedWorld(fixture);
    const lines = renderLogbook(logbookView(fixture.db, { area }), 100, NOW);
    expect(lines[0]).toBe("── July ──");
    expect(lines).toContain("── June ──");
    expect(lines).toContain("── March 2025 ──");
    // Headings are invisible outside project views — the heading-nested row
    // labels its parent PROJECT.
    const nested = lines.find((l) => l.includes("Heading child win"));
    expect(nested).toContain("(Garage)");
    expect(lines.join("\n")).not.toContain("Shelving");
  });

  it("excludes closed items the log-move sweep has not passed (completion ≠ logged)", () => {
    fixture = buildFixtureDb();
    // logInterval 1 = daily: the boundary is local midnight today.
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 1, NULL)")
      .run();
    const now = Date.now() / 1000;
    seedTodo(fixture.db, { title: "Swept win", status: "completed", stopDate: now - 2 * 86400 });
    seedTodo(fixture.db, { title: "Fresh win", status: "completed", stopDate: now });
    const titles = logbookView(fixture.db).map((i) => i.title);
    expect(titles).toContain("Swept win");
    expect(titles).not.toContain("Fresh win");
    // The fresh completion sits checked in its ORIGINAL list instead: the
    // project view keeps it inline, marked logged=false.
    const [fresh] = searchView(fixture.db, "Fresh win", { logged: true });
    expect(fresh?.logged).toBe(false);
    const [swept] = searchView(fixture.db, "Swept win", { logged: true });
    expect(swept?.logged).toBe(true);
  });

  it("keeps closed-but-unswept rows inline in the project view", () => {
    fixture = buildFixtureDb();
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 1, NULL)")
      .run();
    const project = seedProject(fixture.db, { title: "Sprint" });
    const heading = seedHeading(fixture.db, { title: "Phase 1", project });
    seedTodo(fixture.db, {
      title: "Fresh headed win",
      heading,
      status: "completed",
      stopDate: Date.now() / 1000,
    });
    seedTodo(fixture.db, {
      title: "Old headed win",
      heading,
      status: "completed",
      stopDate: Date.now() / 1000 - 2 * 86400,
    });
    const view = projectView(fixture.db, project);
    const phase = view.headings.find((g) => g.heading.title === "Phase 1");
    expect(phase?.items.map((i) => i.title)).toEqual(["Fresh headed win"]);
    expect(view.logged.map((i) => i.title)).toEqual(["Old headed win"]);
  });

  it("flags a limit-truncated range loudly", () => {
    fixture = buildFixtureDb();
    const { area } = seedLoggedWorld(fixture);
    const lines = renderLogbook(logbookView(fixture.db, { area, limit: 3 }), 3, NOW);
    expect(lines.at(-1)).toContain("--limit reached");
  });

  it("parsePeriodEnd expands whole periods (local time)", () => {
    const yearEnd = parsePeriodEnd("2024");
    expect([yearEnd.getFullYear(), yearEnd.getMonth(), yearEnd.getDate()]).toEqual([2024, 11, 31]);
    expect(parsePeriodEnd("2024-02").getDate()).toBe(29); // leap year
    expect(parsePeriodEnd("2024-03-05").getHours()).toBe(23);
  });

  it("parsePeriodEnd counts relative periods FORWARD to the landing day's end", () => {
    const now = new Date(2026, 6, 5, 12, 0); // local 2026-07-05
    const twoWeeks = parsePeriodEnd("2w", now);
    expect([twoWeeks.getMonth(), twoWeeks.getDate(), twoWeeks.getHours()]).toEqual([6, 19, 23]);
    expect(parsePeriodEnd("1m", now).getMonth()).toBe(7); // Aug 5
    expect(parsePeriodEnd("3d", now).getDate()).toBe(8);
    expect(parsePeriodEnd("1y", now).getFullYear()).toBe(2027);
  });

  it("parsePeriodStart counts relative periods BACKWARD to the landing day's start", () => {
    const now = new Date(2026, 6, 5, 12, 0);
    const twoWeeks = parsePeriodStart("2w", now);
    expect([twoWeeks.getMonth(), twoWeeks.getDate(), twoWeeks.getHours()]).toEqual([5, 21, 0]);
    const q1 = parsePeriodStart("2024-03", now);
    expect([q1.getFullYear(), q1.getMonth(), q1.getDate()]).toEqual([2024, 2, 1]);
    const year = parsePeriodStart("2024", now);
    expect([year.getMonth(), year.getDate()]).toEqual([0, 1]);
  });
});

describe("upcoming", () => {
  it("until clamps dated rows and template occurrences; dateless resting templates survive", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Inside", start: "someday", startDate: "2026-07-20" });
    seedTodo(fixture.db, { title: "Outside", start: "someday", startDate: "2026-09-01" });
    seedTodo(fixture.db, {
      title: "Template far",
      recurrenceRule: true,
      nextInstanceStartDate: "2026-10-01",
    });
    seedTodo(fixture.db, { title: "Resting", recurrenceRule: true });
    const titles = upcomingView(fixture.db, NOW, { until: "2026-08-05" }).map((i) => i.title);
    expect(titles).toContain("Inside");
    expect(titles).not.toContain("Outside");
    expect(titles).not.toContain("Template far");
    expect(titles).toContain("Resting"); // dateless — a date bound cannot apply
  });

  it("orders within a day by todayIndex (the UI's drag order), not index", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, {
      title: "Second",
      start: "someday",
      startDate: "2026-07-15",
      index: 1,
      todayIndex: 20,
    });
    seedTodo(fixture.db, {
      title: "First",
      start: "someday",
      startDate: "2026-07-15",
      index: 2,
      todayIndex: 10,
    });
    const titles = upcomingView(fixture.db, NOW).map((i) => i.title);
    expect(titles).toEqual(["First", "Second"]);
  });

  it("appends no-date repeating templates and renders GUI-style buckets", () => {
    fixture = buildFixtureDb();
    // NOW = Sun Jul 5: +2d lands in the day window, +20d in the
    // rest-of-month bucket, next January in the month bucket.
    seedTodo(fixture.db, { title: "Near", start: "someday", startDate: "2026-07-07" });
    seedTodo(fixture.db, { title: "Later this month", start: "someday", startDate: "2026-07-25" });
    seedTodo(fixture.db, { title: "Next year", start: "someday", startDate: "2027-01-09" });
    seedTodo(fixture.db, { title: "Far out", start: "someday", startDate: "2028-03-01" });
    seedTodo(fixture.db, { title: "Between instances", recurrenceRule: true });
    const items = upcomingView(fixture.db, NOW);
    const resting = items.find((i) => i.title === "Between instances");
    expect(resting?.startDate).toBeNull();

    const lines = renderUpcoming(items, NOW);
    expect(lines).toContain("── Tue Jul 7 ──");
    expect(lines).toContain("── Jul 13–31 ──");
    expect(lines).toContain("── January 2027 ──");
    expect(lines).toContain("── 2028 ──");
    expect(lines).toContain("── Repeating To-Dos ──");
    // Day-bucket rows drop the redundant date chip; coarser buckets keep it.
    expect(lines.find((l) => l.includes("Near"))).not.toContain("‹");
    expect(lines.find((l) => l.includes("Later this month"))).toContain("‹Jul 25›");
    // No-date templates seat ↻ inside the box (not a separate mark) and keep
    // their status word.
    const restingLine = lines.find((l) => l.includes("Between instances"));
    expect(restingLine).toContain("[↻]");
    expect(restingLine).toContain("waiting");
  });
});

describe("todayMark", () => {
  it("stars Today members, crescents effective This-Evening members", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Day item", startDate: "2026-07-05" });
    seedTodo(fixture.db, { title: "Night item", startDate: "2026-07-05", evening: true });
    seedTodo(fixture.db, { title: "Future item", startDate: "2026-07-20" });
    const find = (t: string) => searchView(fixture!.db, t)[0];
    const day = find("Day item");
    const night = find("Night item");
    const future = find("Future item");
    if (!day || !night || !future) throw new Error("seed missing");
    expect(todayMark(day, NOW)).toBe("★");
    expect(todayMark(night, NOW)).toBe("⏾");
    expect(todayMark(future, NOW)).toBeNull();
  });
});
