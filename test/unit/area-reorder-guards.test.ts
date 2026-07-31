/**
 * area.reorder preRead guards (ORDFIN2 items 3 & 4). The sidebar drag driver
 * addresses rows by their visible name; these tests pin the target-resolution
 * policy at compile time:
 *  - item 4: the reserved `loose` pseudo-area ref refuses with a specific message
 *    (it is a derived view with no sidebar row), never a generic no-such-area;
 *  - item 3: a uuid-targeted area whose TITLE is shared is NO LONGER refused
 *    (positional disambiguation now handles it in the driver), a duplicate NAME
 *    ref stays unresolved (resolver ambiguity → H-UNKNOWN-DESTINATION), and a
 *    title shared beyond the sanity cap refuses rather than loop.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COMMANDS } from "../../src/write/commands.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea } from "../fixtures/seed.ts";

const NOW = new Date("2026-07-05T12:00:00Z");
let fixture: FixtureDb;

beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

const preRead = (params: {
  target: string;
  before?: string;
  after?: string;
  position?: "first" | "last";
}) => COMMANDS["area.reorder"].preRead(fixture.db, params, NOW);

describe("item 4: the reserved `loose` pseudo-area ref", () => {
  it("refuses `loose` as the target with a derived-view message (case-insensitive)", () => {
    seedArea(fixture.db, "Work");
    expect(() => preRead({ target: "loose", position: "first" })).toThrow(/derived view/i);
    expect(() => preRead({ target: "LOOSE", position: "last" })).toThrow(/derived view/i);
  });

  it("refuses `loose` as an anchor too", () => {
    const work = seedArea(fixture.db, "Work");
    expect(() => preRead({ target: work, before: "loose" })).toThrow(/derived view/i);
  });
});

describe("item 3: duplicate-title target resolution", () => {
  it("a uuid-targeted area whose title is shared is NOT refused (positional disambiguation)", () => {
    const a1 = seedArea(fixture.db, "Dupe");
    seedArea(fixture.db, "Dupe"); // a second area sharing the title
    const other = seedArea(fixture.db, "Other");
    const pre = preRead({ target: a1, before: other });
    // Resolved by uuid to the intended area despite the shared title — the driver
    // disambiguates the sidebar row positionally.
    expect(pre.entityTarget?.resolved?.uuid).toBe(a1);
  });

  it("a duplicate NAME ref stays unresolved (resolver ambiguity, not a compile-time throw)", () => {
    seedArea(fixture.db, "Dupe");
    seedArea(fixture.db, "Dupe");
    const other = seedArea(fixture.db, "Other");
    const pre = preRead({ target: "Dupe", before: other });
    expect(pre.entityTarget?.resolved).toBeNull(); // → H-UNKNOWN-DESTINATION downstream
  });

  it("refuses when a title is shared beyond the sanity cap", () => {
    let target = "";
    for (let i = 0; i < 9; i++) target = seedArea(fixture.db, "Many"); // 9 > cap (8)
    const other = seedArea(fixture.db, "Other");
    expect(() => preRead({ target, before: other })).toThrow(/cap/);
  });
});
