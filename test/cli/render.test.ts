/**
 * Human list rendering (GUI-parity layout): grouped project blocks with
 * styled title rows, suppression of container names implied by the grouping,
 * tags after the title. Colors are OFF here (non-TTY), so assertions see the
 * plain-text skeleton — spacing, ordering, suppression.
 */
import { afterEach, describe, expect, it } from "vitest";

import { anytimeView } from "../../src/read/views.ts";
import { formatItem, renderSections } from "../../src/cli/commands/reads.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag, seedTodo, tagTask } from "../fixtures/seed.ts";

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
    // Project title rows carry no P marker and no redundant (Hobbies).
    expect(lines[2]).not.toContain(" P ");
    expect(text).not.toContain("(Hobbies)");
    // Members drop the redundant (project) suffix.
    expect(text).not.toContain("(Firmware Updates)");
    expect(text).toContain("- Upgrade RetroTink");
    // Blank line separates the two project groups.
    const fastenersAt = lines.findIndex((l) => l.includes("Astro City Fasteners"));
    expect(lines[fastenersAt - 1]).toBe("");
    // Tags render AFTER the title.
    expect(lines[fastenersAt]).toMatch(/Astro City Fasteners #interest$/);
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
    // uuid column, two spaces, bare styled title — no P marker, no (Hobbies).
    expect(line).toMatch(/^proj-\d+ {2}Firmware Updates$/);
  });
});

describe("formatItem", () => {
  it("orders tokens: uuid, marker, dates, title, (context), #tags", () => {
    fixture = buildFixtureDb();
    const area = seedArea(fixture.db, "Errands");
    const p = seedProject(fixture.db, { title: "Groceries", area });
    const tag = seedTag(fixture.db, "urgent");
    const t = seedTodo(fixture.db, {
      title: "Buy milk",
      project: p,
      startDate: "2026-07-05",
      deadline: "2026-07-06",
    });
    tagTask(fixture.db, t, tag);
    const [item] = anytimeView(fixture.db, NOW)
      .flatMap((s) => s.items)
      .filter((i) => i.title === "Buy milk");
    expect(item).toBeDefined();
    if (!item) return;
    const line = formatItem(item, 8);
    expect(line).toMatch(/- !2026-07-06 @2026-07-05 Buy milk \(Groceries\) #urgent$/);
  });
});
