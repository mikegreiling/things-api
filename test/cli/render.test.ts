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
  todayView,
  trashView,
  upcomingView,
} from "../../src/read/views.ts";
import { projectView } from "../../src/read/project-view.ts";
import type { AreaView } from "../../src/read/area-view.ts";
import type { Truncation } from "../../src/contracts.ts";
import { byUuid } from "../../src/read/detail.ts";
import { renderAreaView } from "../../src/cli/commands/area.ts";
import { renderProjectView } from "../../src/cli/commands/project.ts";
import { renderDetail } from "../../src/cli/commands/todo.ts";
import {
  formatItem,
  renderLegend,
  renderLogbook,
  renderProjectsSidebar,
  renderSections,
  renderToday,
  renderUpcoming,
  todayMark,
  viewHeaderLines,
} from "../../src/cli/render.ts";
import { truncateToday } from "../../src/read/truncation.ts";
import { entityWhen } from "../../src/read/stage.ts";
import { parsePeriodEnd, parsePeriodStart } from "../../src/cli/period.ts";
import {
  areaMark,
  CHECKLIST_MARK,
  eveningMoon,
  LEGEND,
  LEGEND_GROUPS,
  NOTES_MARK,
  provisionalPip,
  REMINDER_MARK,
  todayStar,
} from "../../src/cli/glyphs.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import {
  seedArea,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagArea,
  tagTask,
} from "../fixtures/seed.ts";

let fixture: FixtureDb | null = null;
afterEach(() => {
  fixture?.close();
  fixture = null;
});

const NOW = new Date("2026-07-05T12:00:00Z");

const stopAt = (iso: string) => new Date(iso).getTime() / 1000;

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
      "Future mid",
      "Someday early",
    ]);
  });

  it("later blocks read like Upcoming: scheduled by date (todayIndex within a day) BEFORE someday", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Zone", 1);
    seedProject(fixture.db, { title: "Active", area, index: 1 });
    // Drag order (index) deliberately contradicts the wanted output.
    seedProject(fixture.db, { title: "Someday first-by-drag", area, start: "someday", index: 2 });
    seedProject(fixture.db, {
      title: "Oct 19",
      area,
      start: "someday",
      startDate: "2026-10-19",
      index: 3,
    });
    // Same day, todayIndex reversed vs index — upcoming's within-day order.
    seedProject(fixture.db, {
      title: "Aug 1 second",
      area,
      start: "someday",
      startDate: "2026-08-01",
      index: 4,
      todayIndex: 20,
    });
    seedProject(fixture.db, {
      title: "Aug 1 first",
      area,
      start: "someday",
      startDate: "2026-08-01",
      index: 5,
      todayIndex: 10,
    });

    expect(projectsView(fixture.db, { later: true, now: NOW }).map((i) => i.title)).toEqual([
      "Active",
      "Aug 1 first",
      "Aug 1 second",
      "Oct 19",
      "Someday first-by-drag",
    ]);
  });

  it("hidden later projects are never silent: per-group muted counts + a bottom flag hint", () => {
    fixture = buildFixtureDb();
    const zone = seedArea(fixture.db, "Zone", 1);
    const idle = seedArea(fixture.db, "Idle", 2);
    seedProject(fixture.db, { title: "Loose active", index: 1 });
    seedProject(fixture.db, { title: "Loose someday", start: "someday", index: 2 });
    seedProject(fixture.db, { title: "Zone active", area: zone, index: 3 });
    seedProject(fixture.db, { title: "Zone someday", area: zone, start: "someday", index: 4 });
    // An area whose EVERY project is later still surfaces (header + count).
    seedProject(fixture.db, { title: "Idle someday", area: idle, start: "someday", index: 5 });

    const visible = projectsView(fixture.db, { now: NOW });
    const full = projectsView(fixture.db, { later: true, now: NOW });
    const shown = new Set(visible.map((i) => i.uuid));
    const groups: Array<{ area: { uuid: string; title: string } | null; hidden: number }> = [];
    const at = new Map<string | null, number>();
    for (const item of full) {
      const key = item.area?.uuid ?? null;
      if (!at.has(key)) {
        at.set(key, groups.length);
        groups.push({ area: item.area ?? null, hidden: 0 });
      }
      if (!shown.has(item.uuid)) {
        const g = groups[at.get(key) ?? 0];
        if (g !== undefined) g.hidden += 1;
      }
    }
    const lines = renderProjectsSidebar(visible, { groups });
    // Loose block: active row then its muted per-group locator count (spaced
    // ellipsis, no command — the single reveal command rides the bottom line).
    const looseHint = lines.indexOf("… 1 later project");
    expect(looseHint).toBeGreaterThan(lines.findIndex((l) => l.includes("Loose active")));
    // Zone: the later-count follows its active row, within the Zone block
    // (order, not an exact offset — the block's row count isn't the contract).
    const zoneAt = lines.findIndex((l) => l.includes("⬡ Zone ──"));
    const zoneActiveAt = lines.findIndex((l) => l.includes("Zone active"));
    const zoneHintAt = lines.indexOf("… 1 later project", zoneAt);
    expect(zoneActiveAt).toBeGreaterThan(zoneAt);
    expect(zoneHintAt).toBeGreaterThan(zoneActiveAt);
    // Later-only area still gets a header + count, no rows.
    const idleAt = lines.findIndex((l) => l.includes("⬡ Idle ──"));
    expect(idleAt).toBeGreaterThan(zoneAt);
    expect(lines[idleAt + 1]).toBe("… 1 later project");
    // Bottom line: the whole-view disclosure hint in the one grammar.
    expect(lines.at(-1)).toContain("… 3 later projects — `things projects --show-later`");
    // No hints when none are hidden.
    expect(renderProjectsSidebar(visible).join("\n")).not.toContain("later project");
  });

  it("a project-less area still renders its sidebar header with (no projects)", () => {
    fixture = buildFixtureDb();
    seedArea(fixture.db, "Empty Zone", 1);
    seedProject(fixture.db, { title: "Loose active", index: 1 });

    const visible = projectsView(fixture.db, { now: NOW });
    const lines = renderProjectsSidebar(visible, {
      groups: [
        { area: null, hidden: 0 },
        { area: { uuid: "a1", title: "Empty Zone" }, hidden: 0 },
      ],
    });
    const headerAt = lines.findIndex((l) => l.includes("⬡ Empty Zone ──"));
    expect(headerAt).toBeGreaterThan(0);
    expect(lines[headerAt + 1]).toBe("(no projects)");
    // No later hints anywhere (nothing hidden), and no phantom loose header.
    expect(lines.join("\n")).not.toContain("later project");
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
    const titles = logbookView(fixture.db, undefined, { area }).map((i) => i.title);
    expect(titles).toEqual(["Direct area win", "Project child win", "Heading child win"]);
  });

  it("--project includes heading-nested children", () => {
    fixture = buildFixtureDb();
    const { project } = seedLoggedWorld(fixture);
    const titles = logbookView(fixture.db, undefined, { project }).map((i) => i.title);
    expect(titles).toEqual(["Project child win", "Heading child win"]);
  });

  it("--since/--until bound by logged instant", () => {
    fixture = buildFixtureDb();
    const { area } = seedLoggedWorld(fixture);
    const titles = logbookView(fixture.db, undefined, {
      area,
      since: new Date("2026-01-01T00:00:00Z"),
      until: parsePeriodEnd("2026-06"),
    }).map((i) => i.title);
    expect(titles).toEqual(["Project child win"]);
  });

  it("renders month headings (year appended beyond the current year) and no heading rows", () => {
    fixture = buildFixtureDb();
    const { area } = seedLoggedWorld(fixture);
    const lines = renderLogbook(logbookView(fixture.db, undefined, { area }), NOW);
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

describe("PLOG1 — stranded open children of a resolved project", () => {
  const HINT = /contains \d+ unfinished to-dos? — invisible in the app's live views/;

  it("counts untrashed OPEN children only when the project is itself resolved", () => {
    fixture = buildFixtureDb();
    const project = seedProject(fixture.db, {
      title: "Wrapped",
      status: "completed",
      stopDate: 1_780_000_050,
    });
    const heading = seedHeading(fixture.db, { title: "Phase 1", project });
    seedTodo(fixture.db, { title: "loose open", project }); // open, loose
    seedTodo(fixture.db, { title: "headed open", heading, project: null }); // open, headed
    seedTodo(fixture.db, { title: "someday open", project, start: "someday" }); // open, someday
    seedTodo(fixture.db, { title: "done child", project, status: "completed", stopDate: 40 });
    seedTodo(fixture.db, { title: "trashed open", project, trashed: true }); // excluded
    seedTodo(fixture.db, { title: "tpl", project, recurrenceRule: true }); // excluded

    const view = projectView(fixture.db, project, NOW);
    expect(view.openChildrenWhileResolved).toBe(3);
    const lines = renderProjectView(view, {}).join("\n");
    expect(lines).toMatch(HINT);
    expect(lines).toContain("contains 3 unfinished to-dos — invisible in the app's live views");
  });

  it("fires for a canceled parent and for a swept/logged parent, singularizing at 1", () => {
    // Canceled parent, exactly one open child → singular.
    fixture = buildFixtureDb();
    const canceled = seedProject(fixture.db, {
      title: "Dropped",
      status: "canceled",
      stopDate: 1_780_000_050,
    });
    seedTodo(fixture.db, { title: "lone open", project: canceled });
    const cv = projectView(fixture.db, canceled, NOW);
    expect(cv.openChildrenWhileResolved).toBe(1);
    expect(renderProjectView(cv, {}).join("\n")).toContain(
      "contains 1 unfinished to-do — invisible in the app's live views",
    );

    // Swept-to-Logbook parent (manualLogDate past its stopDate) still counts.
    fixture.close();
    fixture = buildFixtureDb();
    fixture.db
      .prepare("INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 4, 200)")
      .run();
    const logged = seedProject(fixture.db, { title: "Swept", status: "completed", stopDate: 100 });
    seedTodo(fixture.db, { title: "stranded open", project: logged });
    const lv = projectView(fixture.db, logged, NOW);
    expect(lv.project.logged).toBe(true);
    expect(lv.openChildrenWhileResolved).toBe(1);
    expect(renderProjectView(lv, {}).join("\n")).toMatch(HINT);
  });

  it("stays silent for an OPEN parent, and for a resolved parent with no open children", () => {
    // Open parent WITH open children — the app shows these fine; no advisory.
    fixture = buildFixtureDb();
    const open = seedProject(fixture.db, { title: "Live", status: "open" });
    seedTodo(fixture.db, { title: "open child", project: open });
    const ov = projectView(fixture.db, open, NOW);
    expect(ov.openChildrenWhileResolved).toBe(0);
    expect(renderProjectView(ov, {}).join("\n")).not.toMatch(HINT);

    // Completed parent whose only children are completed / trashed — nothing stranded.
    fixture.close();
    fixture = buildFixtureDb();
    const done = seedProject(fixture.db, {
      title: "Clean",
      status: "completed",
      stopDate: 1_780_000_050,
    });
    seedTodo(fixture.db, { title: "done child", project: done, status: "completed", stopDate: 40 });
    seedTodo(fixture.db, { title: "trashed child", project: done, trashed: true });
    const dv = projectView(fixture.db, done, NOW);
    expect(dv.openChildrenWhileResolved).toBe(0);
    expect(renderProjectView(dv, {}).join("\n")).not.toMatch(HINT);
  });
});

// logInterval 4 (manual) with manualLogDate as the boundary: a stopDate AFTER
// it is unswept (stays live), a stopDate BEFORE it is swept (logged region).
const seedManualBoundary = (fx: FixtureDb) =>
  fx.db
    .prepare(
      "INSERT INTO TMSettings (uuid, logInterval, manualLogDate) VALUES ('S', 4, 1783000000)",
    )
    .run();
const UNSWEPT = 1_784_000_000; // after the boundary
const SWEPT = 1_782_000_000; // before the boundary

describe("archived headings — trinary live/logged split (HEADARC/HEADARC2)", () => {
  it("keeps an archived-but-UNSWEPT heading in the live headings; moves a SWEPT one to loggedHeadings", () => {
    fixture = buildFixtureDb();
    seedManualBoundary(fixture);
    const project = seedProject(fixture.db, { title: "Sprint" });
    const unswept = seedHeading(fixture.db, {
      title: "Unswept",
      project,
      status: "completed",
      stopDate: UNSWEPT,
      index: 0,
    });
    seedTodo(fixture.db, {
      title: "unswept child",
      heading: unswept,
      project: null,
      status: "completed",
      stopDate: UNSWEPT,
    });
    const swept = seedHeading(fixture.db, {
      title: "Swept",
      project,
      status: "completed",
      stopDate: SWEPT,
      index: 1,
    });
    seedTodo(fixture.db, {
      title: "swept child",
      heading: swept,
      project: null,
      status: "completed",
      stopDate: SWEPT,
    });

    const view = projectView(fixture.db, project, NOW);
    // The archived-UNSWEPT heading stays LIVE, carrying its archive timestamp.
    expect(view.headings.map((g) => g.heading.title)).toEqual(["Unswept"]);
    expect(view.headings[0]!.heading.status).toBe("completed");
    expect(view.headings[0]!.heading.stopped).not.toBeNull();
    // Its completed-unswept child stays checked in place inside the live group.
    expect(view.headings[0]!.items.map((i) => i.title)).toEqual(["unswept child"]);
    // The SWEPT archived heading moves into the logged-region group.
    expect(view.loggedHeadings.map((g) => g.heading.title)).toEqual(["Swept"]);
    expect(view.loggedHeadings[0]!.items.map((i) => i.title)).toEqual(["swept child"]);
    // Group children are NOT flat logged rows.
    expect(view.logged).toEqual([]);
  });

  it("renders a swept archived-heading group under --show-logged, and flat logged rows hint their open heading", () => {
    fixture = buildFixtureDb();
    seedManualBoundary(fixture);
    const project = seedProject(fixture.db, { title: "Sprint" });
    // An OPEN heading whose swept child becomes a FLAT logged row (heading hint).
    const open = seedHeading(fixture.db, { title: "Live Phase", project, index: 0 });
    seedTodo(fixture.db, {
      title: "swept under open",
      heading: open,
      project: null,
      status: "completed",
      stopDate: SWEPT,
    });
    // A SWEPT archived heading → a logged-region GROUP with its child nested.
    const swept = seedHeading(fixture.db, {
      title: "Archived Phase",
      project,
      status: "completed",
      stopDate: SWEPT,
      index: 1,
    });
    seedTodo(fixture.db, {
      title: "grouped win",
      heading: swept,
      project: null,
      status: "completed",
      stopDate: SWEPT,
    });

    const view = projectView(fixture.db, project, NOW);
    // Hidden by default: one disclosure hint counting flat (1) + group heading (1)
    // + its child (1) = 3; the archived heading is NOT on screen.
    const hidden = renderProjectView(view, {}).join("\n");
    expect(hidden).toContain("3 logged items");
    expect(hidden).not.toContain("Archived Phase");
    // Shown: the flat row hints its OPEN heading; the archived heading renders as
    // a section header with its child nested (no per-child hint).
    const shown = renderProjectView(view, { showLogged: true }).join("\n");
    expect(shown).toContain("Logged");
    expect(shown).toContain("(Live Phase)"); // flat row's heading hint
    expect(shown).toContain("Archived Phase"); // group section header
    expect(shown).toContain("grouped win");
  });

  it("counts an open child buried under a swept archived heading (odd state) and warns on an OPEN project's card", () => {
    fixture = buildFixtureDb();
    seedManualBoundary(fixture);
    const project = seedProject(fixture.db, { title: "Sprint" }); // OPEN project
    const swept = seedHeading(fixture.db, {
      title: "Archived Phase",
      project,
      status: "completed",
      stopDate: SWEPT,
    });
    seedTodo(fixture.db, {
      title: "grouped win",
      heading: swept,
      project: null,
      status: "completed",
      stopDate: SWEPT,
    });
    // The odd child a GUI Put-Back stranded: OPEN, still under the archived heading.
    seedTodo(fixture.db, { title: "stranded open", heading: swept, project: null, status: "open" });

    const view = projectView(fixture.db, project, NOW);
    expect(view.openChildrenUnderArchivedHeading).toBe(1);
    expect(view.openChildrenWhileResolved).toBe(0); // the project itself is open
    // The stranded open child is rendered inside the group (not filtered out).
    expect(view.loggedHeadings[0]!.items.map((i) => i.title)).toContain("stranded open");
    const lines = renderProjectView(view, {}).join("\n");
    expect(lines).toContain("buried under an archived heading — invisible in the app's live views");
  });

  // HEADARC3 (Things 3.22.11, GUI-probed): both the flat project logged region
  // and an archived-heading group order their children by stopDate DESC —
  // most-recently-completed first, INCLUDING the within-day tiebreak (two
  // same-day completions sort by completion instant, NOT by index). The fixture
  // mirrors the probe: children created in index order A,B,C,D,E but completed
  // B,C,A then D,E (D before E same "day") — so a stopDate-DESC law renders
  // E,D,A,C,B while an index-ASC law would render A,B,C,D,E.
  const HA3 = {
    // index order A<B<C<D<E; stopDate order B<C<A<D<E (all swept, D/E adjacent).
    A: { index: 0, stopDate: SWEPT + 30 },
    B: { index: 1, stopDate: SWEPT + 10 },
    C: { index: 2, stopDate: SWEPT + 20 },
    D: { index: 3, stopDate: SWEPT + 40 },
    E: { index: 4, stopDate: SWEPT + 41 },
  } as const;

  it("HEADARC3: flat project logged region orders swept children stopDate DESC (same-day tiebreak by instant, not index)", () => {
    fixture = buildFixtureDb();
    seedManualBoundary(fixture);
    const project = seedProject(fixture.db, { title: "Sprint" });
    // An OPEN heading — its swept children fall to the FLAT project logged region.
    const open = seedHeading(fixture.db, { title: "Foo", project, index: 0 });
    for (const [title, { index, stopDate }] of Object.entries(HA3)) {
      seedTodo(fixture.db, {
        title,
        heading: open,
        project: null,
        status: "completed",
        stopDate,
        index,
      });
    }
    const view = projectView(fixture.db, project, NOW);
    expect(view.logged.map((i) => i.title)).toEqual(["E", "D", "A", "C", "B"]);
  });

  it("HEADARC3: archived-heading group orders its children stopDate DESC (same-day tiebreak by instant, not index)", () => {
    fixture = buildFixtureDb();
    seedManualBoundary(fixture);
    const project = seedProject(fixture.db, { title: "Sprint" });
    // A SWEPT archived heading — its children group under it in the logged region.
    const swept = seedHeading(fixture.db, {
      title: "Foo",
      project,
      status: "completed",
      stopDate: SWEPT + 99,
      index: 0,
    });
    for (const [title, { index, stopDate }] of Object.entries(HA3)) {
      seedTodo(fixture.db, {
        title,
        heading: swept,
        project: null,
        status: "completed",
        stopDate,
        index,
      });
    }
    const view = projectView(fixture.db, project, NOW);
    expect(view.loggedHeadings.map((g) => g.heading.title)).toEqual(["Foo"]);
    expect(view.loggedHeadings[0]!.items.map((i) => i.title)).toEqual(["E", "D", "A", "C", "B"]);
  });
});

describe("inherited-tags display (todo show / project show)", () => {
  it("todo show: renders an `inherited:` line with plain tag names (no provenance chip)", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Home");
    const project = seedProject(fixture.db, { title: "Renovation", area });
    // Distinct indexes so the canonical order is deterministic: #important
    // (project) before #home (area).
    const important = seedTag(fixture.db, "important", null, -10);
    const home = seedTag(fixture.db, "home", null, 0);
    tagTask(fixture.db, project, important);
    tagArea(fixture.db, area, home);
    const todo = seedTodo(fixture.db, { title: "Paint hallway", project });

    const item = byUuid(fixture.db, todo);
    const lines = renderDetail(item).join("\n");
    expect(lines).toContain("inherited: #important #home");
    // No container provenance chip.
    expect(lines).not.toContain("‹area");
    expect(lines).not.toContain("‹project");
    // The item's OWN (direct) tags line is separate; here it has none.
    expect(lines).not.toContain("tags:");
  });

  it("project show: renders the area-inherited line as a plain name (no `‹area …›` chip)", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Home");
    const home = seedTag(fixture.db, "home");
    tagArea(fixture.db, area, home);
    const project = seedProject(fixture.db, { title: "Renovation", area });

    const view = projectView(fixture.db, project, NOW);
    const lines = renderProjectView(view, {}).join("\n");
    expect(lines).toContain("inherited: #home");
    expect(lines).not.toContain("‹area");
  });

  it("omits the `inherited:` line entirely when there are none — no empty placeholder", () => {
    // A project/to-do whose ancestor carries NO tags must render with NO
    // `inherited:` line at all (Mike's ruling: no empty placeholder — match the
    // when/deadline convention of hiding absent fields), byte-identical to the
    // pre-feature output.
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Untagged Area");
    const project = seedProject(fixture.db, { title: "P", area });
    const todo = seedTodo(fixture.db, { title: "t", project });

    const todoLines = renderDetail(byUuid(fixture.db, todo)).join("\n");
    const projLines = renderProjectView(projectView(fixture.db, project, NOW), {}).join("\n");
    expect(todoLines).not.toContain("inherited:");
    expect(projLines).not.toContain("inherited:");
  });

  it("JSON/entity shape: inheritedTags is ALWAYS present (empty array) on a detail read", () => {
    fixture = buildFixtureDb();
    const project = seedProject(fixture.db, { title: "P" });
    const todo = seedTodo(fixture.db, { title: "t", project });
    const item = byUuid(fixture.db, todo) as { inheritedTags?: unknown[] };
    expect(item.inheritedTags).toEqual([]);
    // Round-trips JSON without losing the key.
    expect(JSON.parse(JSON.stringify(item))).toHaveProperty("inheritedTags", []);
  });
});

describe("derived trash — children of trashed containers (A24B shallow delete)", () => {
  it("upcoming/today/anytime/search hide an untrashed child of a TRASHED project", () => {
    fixture = buildFixtureDb();
    const p = seedProject(fixture.db, { title: "Binned", trashed: true });
    seedTodo(fixture.db, {
      title: "Derived-trash upcoming",
      project: p,
      start: "someday",
      startDate: "2026-07-20",
    });
    seedTodo(fixture.db, { title: "Derived-trash today", project: p, startDate: "2026-07-05" });

    expect(upcomingView(fixture.db, NOW).map((i) => i.title)).toEqual([]);
    const today = todayView(fixture.db, NOW);
    expect(today.items.map((i) => i.title)).toEqual([]);
    expect(anytimeView(fixture.db, NOW).flatMap((s) => s.items.map((i) => i.title))).toEqual([]);
    expect(searchView(fixture.db, "Derived-trash")).toEqual([]);
    // --trashed widens search back to the whole chain.
    expect(searchView(fixture.db, "Derived-trash", { trashed: true }).length).toBe(2);
  });

  it("a HEADED child of a trashed project is hidden too (cascade via the heading)", () => {
    fixture = buildFixtureDb();
    const p = seedProject(fixture.db, { title: "Binned", trashed: true });
    const h = seedHeading(fixture.db, { title: "H", project: p });
    seedTodo(fixture.db, {
      title: "Headed leak",
      heading: h,
      start: "someday",
      startDate: "2026-07-20",
    });
    expect(upcomingView(fixture.db, NOW).map((i) => i.title)).toEqual([]);
  });

  it("the trashed project's OWN view still shows its would-be-recovered children", () => {
    fixture = buildFixtureDb();
    const p = seedProject(fixture.db, { title: "Binned", trashed: true });
    seedTodo(fixture.db, { title: "Recoverable", project: p });
    const view = projectView(fixture.db, p, NOW);
    expect(view.project.trashed).toBe(true);
    expect(view.active.map((t) => t.title)).toEqual(["Recoverable"]);
  });

  it("a DOUBLE-trashed to-do stays visible in `things trash`; the project view carries NO trashed bucket", () => {
    fixture = buildFixtureDb();
    const p = seedProject(fixture.db, { title: "Binned", trashed: true });
    seedTodo(fixture.db, { title: "Double-trashed", project: p, trashed: true });
    expect(trashView(fixture.db).map((i) => i.title)).toEqual(
      expect.arrayContaining(["Double-trashed", "Binned"]),
    );
    // Trashed children are excluded from the project view entirely now — no
    // `trashed` bucket, and the trashed child surfaces in no live bucket.
    const view = projectView(fixture.db, p, NOW);
    expect("trashed" in view).toBe(false);
    expect(view.active.map((t) => t.title)).not.toContain("Double-trashed");
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

  it("since skips occurrences before the bound; dateless resting templates survive", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Early", start: "someday", startDate: "2026-07-20" });
    seedTodo(fixture.db, { title: "Late", start: "someday", startDate: "2026-09-01" });
    seedTodo(fixture.db, { title: "Resting", recurrenceRule: true });
    const titles = upcomingView(fixture.db, NOW, { since: "2026-08-01" }).map((i) => i.title);
    expect(titles).not.toContain("Early");
    expect(titles).toContain("Late");
    expect(titles).toContain("Resting"); // dateless — a since bound cannot apply
  });

  it("forecasts a future-deadline row under its DEADLINE header with a bare flag, no date pill (UPC1)", () => {
    fixture = buildFixtureDb();
    // NOW = Sun Jul 5: a deadline 08-28 lands in the "August" month bucket.
    seedTodo(fixture.db, { title: "Forecast", start: "someday", deadline: "2026-08-28" });
    const items = upcomingView(fixture.db, NOW);
    // JSON honesty: no faked when-date on the forecast row.
    const forecast = items.find((i) => i.title === "Forecast");
    expect(forecast?.startDate).toBeNull();
    expect(forecast?.deadline).toBe("2026-08-28");

    const lines = renderUpcoming(items, NOW);
    expect(lines).toContain("── August ──");
    const row = lines.find((l) => l.includes("Forecast"));
    // The header carries the date — no ‹when› pill on the forecast row — but
    // the ⚑ deadline flag still renders (the GUI's bare-flag anatomy).
    expect(row).not.toContain("‹");
    expect(row).toContain("⚑");
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
    // The repeat status word renders as a ‹chevron› chip (matching ‹date›).
    expect(restingLine).toContain("‹waiting›");
  });
});

describe("todayMark", () => {
  it("stars Today members, crescents effective This-Evening members", () => {
    fixture = buildFixtureDb();
    seedTodo(fixture.db, { title: "Day item", startDate: "2026-07-05" });
    seedTodo(fixture.db, { title: "Night item", startDate: "2026-07-05", evening: true });
    seedTodo(fixture.db, { title: "Future item", startDate: "2026-07-20" });
    // Materialize at NOW so the Today/Evening markers are computed against the
    // same clock the render reads — the CLI always shares one clock (production
    // never renders an entity materialized at a different instant).
    const find = (t: string) => searchView(fixture!.db, t, undefined, NOW)[0];
    const day = find("Day item");
    const night = find("Night item");
    const future = find("Future item");
    if (!day || !night || !future) throw new Error("seed missing");
    expect(todayMark(day)).toBe("★");
    expect(todayMark(night)).toBe("⏾");
    expect(todayMark(future)).toBeNull();
  });

  it("stars an unscheduled to-do pulled into Today by a due deadline (anytime ★)", () => {
    fixture = buildFixtureDb();
    // Unscheduled (start=1, no When-date) but DUE today: todayView's deadline
    // arm pulls it into Today, so Anytime stars it exactly like a scheduled one.
    seedTodo(fixture.db, { title: "due today", start: "active", deadline: "2026-07-05" });
    // Control — unscheduled with a FUTURE deadline: forecast into Upcoming, not
    // Today, so no star (proves the deadline must be DUE, not merely present).
    seedTodo(fixture.db, { title: "due later", start: "active", deadline: "2026-07-20" });
    const items = anytimeView(fixture.db, NOW).flatMap((s) => s.items);
    const mark = (t: string) => {
      const item = items.find((i) => i.title === t);
      if (!item) throw new Error(`missing anytime item: ${t}`);
      return todayMark(item);
    };
    expect(mark("due today")).toBe("★");
    expect(mark("due later")).toBeNull();
  });
});

describe("renderToday (things today split)", () => {
  const base = "things today";
  // Seed `todayN` Today members + `eveningN` This-Evening members, then build
  // the real view pinned at NOW (evening membership needs startDate == today).
  function build(fx: FixtureDb, todayN: number, eveningN: number) {
    for (let i = 0; i < todayN; i++) {
      seedTodo(fx.db, { title: `day ${i}`, startDate: "2026-07-05", todayIndex: i });
    }
    for (let i = 0; i < eveningN; i++) {
      seedTodo(fx.db, {
        title: `night ${i}`,
        startDate: "2026-07-05",
        evening: true,
        todayIndex: i,
      });
    }
    return todayView(fx.db, NOW);
  }

  it("puts ★/⏾ in the section headers and drops them from the rows", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 1, 1);
    const lines = renderToday(full, undefined, base);
    const todayHeader = lines.find((l) => /── .*Today ──/.test(l));
    const eveningHeader = lines.find((l) => l.includes("This Evening"));
    // Membership glyph lives in the header now (yellow ★ / blue ⏾; color is
    // OFF here so the helpers render the bare marks). The header is CLEAN — the
    // counts ride the card-style metadata lines at the top, not the header.
    expect(todayHeader).toContain(todayStar());
    expect(todayHeader).not.toContain("due/overdue");
    expect(eveningHeader).toContain(eveningMoon());
    // The counts render as card-style metadata lines at the very top.
    expect(lines[0]).toContain("due/overdue:");
    expect(lines[1]).toContain("other:");
    // …and the membership glyph is gone from the item rows (the header implies it).
    expect(lines.find((l) => l.includes("day 0"))).not.toContain("★");
    expect(lines.find((l) => l.includes("night 0"))).not.toContain("⏾");
  });

  it("(a) a cap cutting INSIDE evening keeps the shown rows + an honest `more` hint", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 3, 4); // total 7
    const { data, truncation } = truncateToday(full, 5); // 3 today + 2 evening → 2 evening hidden
    const lines = renderToday(data, truncation.sections, base);
    expect(lines.filter((l) => /night \d/.test(l))).toHaveLength(2);
    expect(lines.some((l) => l.includes("This Evening"))).toBe(true);
    // A pure section pointer — the global truncation footer (appended by the
    // driver) already carries the quantity levers, so this only points at the
    // isolated Evening view.
    expect(lines).toContain("… 2 more evening items — `things today --evening`");
  });

  it("(b) a cap consuming evening entirely shows the header + hidden-count hint, never `(empty)`", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 5, 4); // total 9
    const { data, truncation } = truncateToday(full, 3); // 3 today, 0 evening → all 4 evening hidden
    expect(data.items.filter((i) => entityWhen(i) === "evening")).toHaveLength(0);
    const lines = renderToday(data, truncation.sections, base);
    expect(lines.some((l) => l.includes("This Evening"))).toBe(true);
    expect(lines).not.toContain("(empty)");
    expect(lines.some((l) => /night \d/.test(l))).toBe(false);
    expect(lines).toContain("… 4 evening items — `things today --evening`");
  });

  it("(c) a truly-empty evening renders NO This Evening header at all (GUI parity)", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 2, 0);
    const lines = renderToday(full, undefined, base);
    expect(lines.some((l) => l.includes("This Evening"))).toBe(false);
    expect(lines).not.toContain("(empty)");
    // Today still renders its rows under the clean ★ header.
    expect(lines.some((l) => /── .*Today ──/.test(l))).toBe(true);
    expect(lines.filter((l) => /day \d/.test(l))).toHaveLength(2);
  });

  it("(d) --all (no cap) shows every evening row and no hint", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 3, 4);
    const { data, truncation } = truncateToday(full, null);
    const lines = renderToday(data, truncation.sections, base);
    expect(lines.filter((l) => /night \d/.test(l))).toHaveLength(4);
    expect(lines.some((l) => l.includes("evening items —"))).toBe(false);
  });

  it("an empty Today section keeps its honest `(empty)` under the clean header", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 0, 0);
    const lines = renderToday(full, undefined, base);
    expect(lines.some((l) => /── .*Today ──/.test(l))).toBe(true);
    expect(lines).toContain("(empty)");
    expect(lines.some((l) => l.includes("This Evening"))).toBe(false);
  });

  it("separates This Evening from Today with a blank line (matches other grouped views)", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 2, 2);
    const lines = renderToday(full, undefined, base);
    const headerIdx = lines.findIndex((l) => l.includes("This Evening"));
    expect(headerIdx).toBeGreaterThan(0);
    // The line immediately above the Evening header is blank.
    expect(lines[headerIdx - 1]).toBe("");
  });

  it("pins the truncated layout: today rows, blank, evening header, rows, pointer hint", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 3, 4); // 3 today + 4 evening
    const { data, truncation } = truncateToday(full, 5); // 3 today + 2 evening → 2 evening hidden
    const lines = renderToday(data, truncation.sections, base);
    const evIdx = lines.findIndex((l) => l.includes("This Evening"));
    // A blank line separates the Today block from the Evening header.
    expect(lines[evIdx - 1]).toBe("");
    // The two shown evening rows sit directly under the header…
    expect(lines[evIdx + 1]).toContain("night 0");
    expect(lines[evIdx + 2]).toContain("night 1");
    // …and the pointer hint is the LAST line, adjacent to the rows (no blank —
    // the driver appends the blank + global footer AFTER this).
    expect(lines.at(-1)).toBe("… 2 more evening items — `things today --evening`");
  });

  it("--evening truncation keeps the limit levers (--evening is already active)", () => {
    fixture = buildFixtureDb();
    // Build the view AS the CLI does under --evening: today is filtered out.
    for (let i = 0; i < 4; i++) {
      seedTodo(fixture.db, {
        title: `night ${i}`,
        startDate: "2026-07-05",
        evening: true,
        todayIndex: i,
      });
    }
    const full = todayView(fixture.db, NOW, { eveningOnly: true });
    const { data, truncation } = truncateToday(full, 2); // 2 evening shown, 2 hidden
    const eveningBase = "things today --evening";
    const lines = renderToday(data, truncation.sections, eveningBase, { eveningOnly: true });
    // The pointer would be redundant here, so the hint offers the levers that
    // actually reveal rows — with the --all escalation UNLABELED.
    expect(lines).toContain(
      "… 2 more evening items — `things today --evening --limit 4` · `things today --evening --all`",
    );
  });

  it("--evening puts the This Evening header directly after the counts — no leading blank line", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 3, 2);
    const lines = renderToday(full, undefined, base, { eveningOnly: true });
    // The counts metadata lines lead; the header follows them directly (no blank,
    // no Today block, since --evening filters Today out).
    const evIdx = lines.findIndex((l) => l.includes("This Evening"));
    expect(evIdx).toBeGreaterThan(0);
    expect(lines[evIdx - 1]).not.toBe(""); // the count line, not a blank separator
    expect(lines.slice(0, evIdx).some((l) => l.includes("due/overdue:"))).toBe(true);
  });

  it("--evening renders ONLY the This Evening block — no Today header, no `(empty)`", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 3, 2);
    const lines = renderToday(full, undefined, base, { eveningOnly: true });
    expect(lines.some((l) => /── .*Today ──/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes("This Evening"))).toBe(true);
    expect(lines.filter((l) => /night \d/.test(l))).toHaveLength(2);
    // The filtered-out Today section never leaves an `(empty)` placeholder.
    expect(lines).not.toContain("(empty)");
    expect(lines.some((l) => /day \d/.test(l))).toBe(false);
  });

  it("--evening with no evening members shows an honest `(empty)`, still no Today header", () => {
    fixture = buildFixtureDb();
    const full = build(fixture, 3, 0);
    const lines = renderToday(full, undefined, base, { eveningOnly: true });
    expect(lines.some((l) => /── .*Today ──/.test(l))).toBe(false);
    expect(lines.some((l) => l.includes("This Evening"))).toBe(false);
    expect(lines).toContain("(empty)");
  });
});

// A deadline-pulled undated active row is a Today member (todayView's deadline
// arm) AND unmaterialized (startDate IS NULL) — the canonical provisional case
// (BANNER1). It also files under Anytime (stage), so ONE fixture serves both the
// today-view (pip present) and anytime-view (pip absent) assertions. The control
// is a materialized Today member (start=active, arrived startDate) — a Today
// member that is NOT provisional, so it never gets the pip.
function seedProvisional(fx: FixtureDb) {
  seedTodo(fx.db, { title: "provisional row", start: "active", deadline: "2026-07-05" });
  seedTodo(fx.db, { title: "materialized row", start: "active", startDate: "2026-07-05" });
}

describe("provisional pip (yellow • in the Today view only)", () => {
  const base = "things today";

  it("renders • on the provisional Today row, not on the materialized one", () => {
    fixture = buildFixtureDb();
    seedProvisional(fixture);
    const lines = renderToday(todayView(fixture.db, NOW), undefined, base);
    const provLine = lines.find((l) => l.includes("provisional row"));
    const matLine = lines.find((l) => l.includes("materialized row"));
    if (provLine === undefined || matLine === undefined) throw new Error("today rows missing");
    // The pip rides the after-the-box mark slot (color OFF here → bare glyph).
    expect(provLine).toContain(provisionalPip());
    expect(matLine).not.toContain(provisionalPip());
  });

  it("pips an evening-section provisional row too (both Today sections)", () => {
    fixture = buildFixtureDb();
    // An arrived someday-scheduled EVENING row: Today member, evening section,
    // and unmaterialized (start != active) → provisional.
    seedTodo(fixture.db, {
      title: "evening prov",
      start: "someday",
      startDate: "2026-07-05",
      evening: true,
    });
    const lines = renderToday(todayView(fixture.db, NOW), undefined, base);
    const evLine = lines.find((l) => l.includes("evening prov"));
    if (evLine === undefined) throw new Error("evening row missing");
    expect(evLine).toContain(provisionalPip());
  });

  it("does NOT render • in the anytime view for the same provisional row", () => {
    fixture = buildFixtureDb();
    seedProvisional(fixture);
    // Anytime sidebar layout, with the Today ★ marks on (star=true) — the row is
    // a Today member (★ present) yet the new-item pip stays exclusive to Today.
    const lines = renderSections(anytimeView(fixture.db, NOW), true);
    const provLine = lines.find((l) => l.includes("provisional row"));
    if (provLine === undefined) throw new Error("anytime row missing");
    expect(provLine).toContain(todayStar()); // it IS a Today member here
    expect(provLine).not.toContain(provisionalPip()); // …but never the pip
  });
});

describe("renderLegend (things legend)", () => {
  it("groups entries under the five section headers, in order", () => {
    const lines = renderLegend();
    const headers = lines.filter((l) => /^── .+ ──$/.test(l));
    expect(headers).toEqual(LEGEND_GROUPS.map((g) => `── ${g} ──`));
    // Every entry's group has at least one non-header row beneath it.
    for (const group of LEGEND_GROUPS) {
      expect(LEGEND.some((e) => e.group === group)).toBe(true);
    }
  });

  it("every entry renders as `<glyph>  <meaning>` and stays within 80 columns", () => {
    // Colors are OFF here (non-TTY), so a line is the plain glyph + meaning.
    for (const line of renderLegend()) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("documents every state box, project circle, and marker glyph", () => {
    // The single-source coverage guard: the exported marks and the box/circle
    // families must each appear in the rendered legend, so a new glyph in
    // glyphs.ts that never reaches the legend fails here.
    const text = renderLegend().join("\n");
    const required = [
      "[ ]",
      "[✓]",
      "[×]",
      "[~]",
      "[↻]",
      "( )",
      "(✓)",
      "(×)",
      "(~)",
      "(↻)",
      NOTES_MARK,
      REMINDER_MARK,
      CHECKLIST_MARK,
      todayStar(),
      eveningMoon(),
      provisionalPip(),
      areaMark(),
      "⚑",
    ];
    for (const glyph of required) {
      expect(text, `legend missing ${glyph}`).toContain(glyph);
    }
  });
});

describe("viewHeaderLines (view title preamble)", () => {
  it("builds a bold title + dim deep link followed by a blank line", () => {
    // Non-TTY here, so bold/dim are identity — assert the plain shape.
    expect(viewHeaderLines("anytime")).toEqual(["Anytime (things:///show?id=anytime)", ""]);
    expect(viewHeaderLines("inbox")).toEqual(["Inbox (things:///show?id=inbox)", ""]);
  });
});

// A minimal empty area card — the footer is driven purely by `loggedCount`.
const emptyArea = (title: string): AreaView => ({
  area: { uuid: "area-1", title, visible: true, tags: [] },
  active: [],
  projects: [],
  scheduled: [],
  someday: [],
  repeating: [],
});
const EMPTY_TRUNC: Truncation = { shown: 0, total: 0, limit: null, truncated: false };

describe("renderAreaView logbook footer (live count)", () => {
  const trunc = EMPTY_TRUNC;

  it("groups thousands, pluralizes, and omits the line at zero / when absent", () => {
    // Non-TTY here, so dim() is identity — assert the plain footer line.
    expect(renderAreaView(emptyArea("Health"), trunc, { loggedCount: 4217 })).toContain(
      "4,217 logged items — `things logbook --area 'Health'`",
    );
    // Singular noun for exactly one.
    expect(renderAreaView(emptyArea("Health"), trunc, { loggedCount: 1 })).toContain(
      "1 logged item — `things logbook --area 'Health'`",
    );
    // Zero and absent both hide the footer entirely — no pointer to an empty log.
    expect(renderAreaView(emptyArea("Health"), trunc, { loggedCount: 0 }).join("\n")).not.toContain(
      "logbook --area",
    );
    expect(renderAreaView(emptyArea("Health"), trunc, {}).join("\n")).not.toContain(
      "logbook --area",
    );
  });
});
