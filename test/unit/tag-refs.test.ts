import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatTagCandidates,
  planTagCreation,
  resolveTagRefs,
  shortUuid,
} from "../../src/write/tag-refs.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTag } from "../fixtures/seed.ts";

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

describe("resolveTagRefs — value forms", () => {
  it("resolves a plain title", () => {
    seedTag(fixture.db, "Work");
    const r = resolveTagRefs(fixture.db, ["Work"]);
    expect(r).toEqual({ titles: ["Work"], missing: [], ambiguous: [] });
  });

  it("accepts a uuid and resolves it to the tag's title", () => {
    const uuid = seedTag(fixture.db, "Errands");
    const r = resolveTagRefs(fixture.db, [uuid]);
    expect(r.titles).toEqual(["Errands"]);
    expect(r.missing).toEqual([]);
  });

  it("de-duplicates when a uuid and its title name the same tag", () => {
    const uuid = seedTag(fixture.db, "Home");
    const r = resolveTagRefs(fixture.db, [uuid, "Home"]);
    expect(r.titles).toEqual(["Home"]); // one applied tag, not two
  });

  it("reports an unknown ref as missing (not silently dropped)", () => {
    seedTag(fixture.db, "Known");
    const r = resolveTagRefs(fixture.db, ["Known", "Ghost"]);
    expect(r.missing).toEqual(["Ghost"]);
    expect(r.titles).toEqual(["Known"]);
  });

  it("matches a title case-insensitively", () => {
    seedTag(fixture.db, "Priority");
    expect(resolveTagRefs(fixture.db, ["priority"]).titles).toEqual(["Priority"]);
  });
});

describe("resolveTagRefs — path qualification (literal-over-path, TAGW1-d)", () => {
  it("resolves parent/child to the child leaf title", () => {
    const work = seedTag(fixture.db, "Work");
    seedTag(fixture.db, "Errands", work);
    const r = resolveTagRefs(fixture.db, ["Work/Errands"]);
    expect(r.titles).toEqual(["Errands"]);
    expect(r.missing).toEqual([]);
  });

  it("resolves a multi-level chain a/b/c", () => {
    const a = seedTag(fixture.db, "A");
    const b = seedTag(fixture.db, "B", a);
    seedTag(fixture.db, "C", b);
    expect(resolveTagRefs(fixture.db, ["A/B/C"]).titles).toEqual(["C"]);
  });

  it("prefers a LITERAL title containing a slash over splitting on it", () => {
    // `sl/ash` is a legal literal tag title; it must win over path-splitting.
    seedTag(fixture.db, "sl/ash");
    const r = resolveTagRefs(fixture.db, ["sl/ash"]);
    expect(r.titles).toEqual(["sl/ash"]);
    expect(r.missing).toEqual([]);
  });

  it("only splits when there is no literal match", () => {
    const parent = seedTag(fixture.db, "sl");
    seedTag(fixture.db, "ash", parent);
    // No literal `sl/ash` tag exists here → the path chain resolves.
    expect(resolveTagRefs(fixture.db, ["sl/ash"]).titles).toEqual(["ash"]);
  });

  it("reports a broken path as missing", () => {
    seedTag(fixture.db, "Work");
    expect(resolveTagRefs(fixture.db, ["Work/Nope"]).missing).toEqual(["Work/Nope"]);
  });
});

describe("resolveTagRefs — duplicate-name refusal (TAGW1-c pathological state)", () => {
  it("reports a name matching two tags as ambiguous, with parent-qualified candidates", () => {
    // A duplicate-name pair is uncreatable via app surfaces (TAGW1-c); the
    // fixture may stage what the app cannot, to prove the refusal path.
    const root = seedTag(fixture.db, "Work");
    seedTag(fixture.db, "Work", root); // a second `Work`, nested under the first
    const r = resolveTagRefs(fixture.db, ["Work"]);
    expect(r.titles).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    const amb = r.ambiguous[0];
    expect(amb?.ref).toBe("Work");
    expect(amb?.candidates).toHaveLength(2);
    const nested = amb?.candidates.find((c) => c.parentPath !== null);
    expect(nested?.parentPath).toBe("Work/");
  });

  it("a uuid disambiguates a duplicate-name pair", () => {
    const root = seedTag(fixture.db, "Dup");
    const nested = seedTag(fixture.db, "Dup", root);
    const r = resolveTagRefs(fixture.db, [nested]);
    expect(r.ambiguous).toEqual([]);
    expect(r.titles).toEqual(["Dup"]);
  });

  it("a parent/child path disambiguates a duplicate-name pair", () => {
    const root = seedTag(fixture.db, "Dup");
    seedTag(fixture.db, "Dup", root); // Dup/Dup
    const r = resolveTagRefs(fixture.db, ["Dup/Dup"]);
    expect(r.ambiguous).toEqual([]);
    expect(r.titles).toEqual(["Dup"]);
  });
});

describe("formatTagCandidates", () => {
  it("renders short uuid + parent path per candidate", () => {
    const root = seedTag(fixture.db, "Work");
    const nested = seedTag(fixture.db, "Work", root);
    const r = resolveTagRefs(fixture.db, ["Work"]);
    const rendered = formatTagCandidates(r.ambiguous[0]?.candidates ?? []);
    expect(rendered).toContain(`[${shortUuid(root)}] Work`);
    expect(rendered).toContain(`[${shortUuid(nested)}] Work/Work`);
  });
});

describe("planTagCreation — mkdir-p, idempotence", () => {
  it("plans a single root tag for a plain missing name", () => {
    expect(planTagCreation(fixture.db, ["New"])).toEqual([{ title: "New" }]);
  });

  it("plans nothing for a tag that already exists (idempotent)", () => {
    seedTag(fixture.db, "Exists");
    expect(planTagCreation(fixture.db, ["Exists"])).toEqual([]);
  });

  it("mkdir-p's an entire missing path, parents first", () => {
    expect(planTagCreation(fixture.db, ["A/B/C"])).toEqual([
      { title: "A" },
      { title: "B", parent: "A" },
      { title: "C", parent: "B" },
    ]);
  });

  it("plans only the missing tail of a partially-existing path", () => {
    const a = seedTag(fixture.db, "A");
    seedTag(fixture.db, "B", a);
    expect(planTagCreation(fixture.db, ["A/B/C"])).toEqual([{ title: "C", parent: "B" }]);
  });

  it("does not split a literal-slash title (no creation when it exists)", () => {
    seedTag(fixture.db, "sl/ash");
    expect(planTagCreation(fixture.db, ["sl/ash"])).toEqual([]);
  });

  it("never plans creation for a non-resolving uuid-shaped ref", () => {
    expect(planTagCreation(fixture.db, ["abc123def456ghi789jkl0"])).toEqual([]);
  });

  it("plans a repeated path segment across refs exactly once", () => {
    const steps = planTagCreation(fixture.db, ["Work/A", "Work/B"]);
    expect(steps).toEqual([
      { title: "Work" },
      { title: "A", parent: "Work" },
      { title: "B", parent: "Work" },
    ]);
  });
});
