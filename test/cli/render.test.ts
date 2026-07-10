/**
 * Human list rendering (GUI-parity layout): the glyph language ([ ]/[✓]/[×]/
 * [~] boxes, ( )-family project circles, ‹date› chips, logged dates, ≡ notes
 * marker), grouped project blocks with styled title rows, suppression of
 * container names implied by the grouping, tags after the title. Colors are
 * OFF here (non-TTY), so assertions see the plain-text skeleton — spacing,
 * ordering, suppression, and the color-stripped state glyphs.
 */
import { afterEach, describe, expect, it } from "vitest";

import { anytimeView, searchView, somedayView } from "../../src/read/views.ts";
import { formatItem, renderSections, todayMark } from "../../src/cli/commands/reads.ts";
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

    // Area header, blank line, then the first project block.
    expect(lines[0]).toBe("── Hobbies ──");
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
    // Tags render AFTER the title and the count chip.
    expect(lines[fastenersAt]).toMatch(/Astro City Fasteners ‹\d+› #interest$/);
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
    expect(lines.findIndex((l) => l.includes("── Hobbies ──"))).toBeGreaterThan(0);
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
    // uuid column, circle glyph, styled title, count chip — no (Hobbies).
    expect(line).toMatch(/^proj-\d+ {2}\( \) Firmware Updates ‹\d+›$/);
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
    // Future startDate renders as the schedule chip; the deadline keeps ISO.
    expect(line).toMatch(/\[ \] ‹Jul 20› !2026-07-06 Buy milk \(Groceries\) #urgent$/);
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
