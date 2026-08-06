/**
 * The did-you-mean TTY candidate rendering (src/cli/did-you-mean.ts): the fused
 * ref form `Title [8charPrefix]` on the area candidate line (PR `mg/short-refs`
 * point 2), and the `· started YYYY-MM-DD` tail on DUPLICATE-titled project/to-do
 * candidates so a human can tell recurring twins apart (point 4 — TTY only; the
 * JSON candidate payload, `candidatesJson`, is unchanged).
 */
import { describe, expect, it } from "vitest";

import type { Area, DerivedSubstrate } from "../../src/model/entities.ts";
import { DidYouMeanError, renderDidYouMean, candidatesJson } from "../../src/cli/did-you-mean.ts";
import type { ListItem } from "../../src/index.ts";

function task(
  over: Partial<Omit<ListItem, "derived">> &
    Partial<DerivedSubstrate> & { uuid: string; title: string },
): ListItem {
  const { start, logged, trashed, today, evening, ...rest } = over;
  return {
    type: "to-do",
    notes: "",
    status: "open",
    startDate: null,
    deadline: null,
    reminder: null,
    area: null,
    tags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    created: new Date("2026-05-04T12:00:00.000Z"),
    modified: new Date("2026-05-04T12:00:00.000Z"),
    stopped: null,
    project: null,
    heading: null,
    checklistItemsCount: 0,
    openChecklistItemsCount: 0,
    ...rest,
    derived: {
      start: start ?? "active",
      logged: logged ?? false,
      trashed: trashed ?? false,
      reminder: null,
      ...(today !== undefined && { today }),
      ...(evening !== undefined && { evening }),
    },
  } as ListItem;
}

const area = (uuid: string, title: string): Area => ({ uuid, title, visible: true, tags: [] });

describe("renderDidYouMean — fused refs + duplicate-title dates", () => {
  it("renders the area candidate in the fused `Title [8char]` form (not the full uuid)", () => {
    const err = new DidYouMeanError("no match for 'fin'", "fin", {
      candidates: [{ kind: "area", area: area("Zx9qWaBc2dEf4gHi6jKl8m", "Finances") }],
      total: 1,
    });
    const out = renderDidYouMean(err).join("\n");
    expect(out).toContain("Finances [Zx9qWaBc]");
    expect(out).not.toContain("Zx9qWaBc2dEf4gHi6jKl8m"); // the full 22-char uuid is gone
  });

  it("appends `· started <date>` ONLY to duplicate-titled task candidates", () => {
    const err = new DidYouMeanError("no match for 'gro'", "gro", {
      candidates: [
        { kind: "task", task: task({ uuid: "g0000001", title: "Groceries" }) },
        { kind: "task", task: task({ uuid: "g0000002", title: "Groceries" }) },
        { kind: "task", task: task({ uuid: "e0000003", title: "Errands" }) },
      ],
      total: 3,
    });
    const lines = renderDidYouMean(err);
    const groceries = lines.filter((l) => l.includes("Groceries"));
    const errands = lines.filter((l) => l.includes("Errands"));
    expect(groceries).toHaveLength(2);
    for (const l of groceries) expect(l).toContain("· started ");
    // The unique-titled candidate carries no date tail.
    expect(errands).toHaveLength(1);
    expect(errands[0]).not.toContain("· started");
  });

  it("the JSON candidate payload is unchanged (no dates, minimal shape)", () => {
    const err = new DidYouMeanError("no match", "gro", {
      candidates: [
        { kind: "task", task: task({ uuid: "g0000001", title: "Groceries" }) },
        { kind: "task", task: task({ uuid: "g0000002", title: "Groceries" }) },
      ],
      total: 2,
    });
    const json = candidatesJson(err);
    for (const c of json) {
      expect(c).not.toHaveProperty("started");
      expect(c).not.toHaveProperty("created");
      // absent `type` = to-do (the PR 1 convention holds on candidates too)
      expect(c).not.toHaveProperty("type");
      expect(c.uuid).toMatch(/^g000000/);
    }
  });
});
