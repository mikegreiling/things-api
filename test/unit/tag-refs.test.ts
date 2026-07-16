import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planTagCreation, resolveTagRefs } from "../../src/write/tag-refs.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedTag } from "../fixtures/seed.ts";

let fixture: FixtureDb;
beforeEach(() => {
  fixture = buildFixtureDb();
});
afterEach(() => {
  fixture.close();
});

describe("resolveTagRefs — names only (existence check)", () => {
  it("resolves a plain title", () => {
    seedTag(fixture.db, "Work");
    expect(resolveTagRefs(fixture.db, ["Work"])).toEqual({ titles: ["Work"], missing: [] });
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

  it("does NOT accept a tag uuid as a ref — a uuid is just an unknown name", () => {
    // Tag uuids are internal; a uuid string names no tag, so it is missing (and
    // would be created verbatim under --create-tags, being a plausible name).
    const uuid = seedTag(fixture.db, "Errands");
    const r = resolveTagRefs(fixture.db, [uuid]);
    expect(r.titles).toEqual([]);
    expect(r.missing).toEqual([uuid]);
  });

  it("de-duplicates repeated names in first-seen order", () => {
    seedTag(fixture.db, "Home");
    expect(resolveTagRefs(fixture.db, ["Home", "home"]).titles).toEqual(["Home"]);
  });
});

describe("resolveTagRefs — path qualification (literal-over-path, TAGW1-d)", () => {
  it("resolves parent/child to the child leaf title", () => {
    const work = seedTag(fixture.db, "Work");
    seedTag(fixture.db, "Errands", work);
    expect(resolveTagRefs(fixture.db, ["Work/Errands"])).toEqual({
      titles: ["Errands"],
      missing: [],
    });
  });

  it("resolves a multi-level chain a/b/c", () => {
    const a = seedTag(fixture.db, "A");
    const b = seedTag(fixture.db, "B", a);
    seedTag(fixture.db, "C", b);
    expect(resolveTagRefs(fixture.db, ["A/B/C"]).titles).toEqual(["C"]);
  });

  it("prefers a LITERAL title containing a slash over splitting on it", () => {
    seedTag(fixture.db, "sl/ash");
    expect(resolveTagRefs(fixture.db, ["sl/ash"])).toEqual({ titles: ["sl/ash"], missing: [] });
  });

  it("only splits when there is no literal match", () => {
    const parent = seedTag(fixture.db, "sl");
    seedTag(fixture.db, "ash", parent);
    expect(resolveTagRefs(fixture.db, ["sl/ash"]).titles).toEqual(["ash"]);
  });

  it("reports a broken path as missing", () => {
    seedTag(fixture.db, "Work");
    expect(resolveTagRefs(fixture.db, ["Work/Nope"]).missing).toEqual(["Work/Nope"]);
  });
});

describe("resolveTagRefs — duplicate names delegate to the app (no refusal)", () => {
  it("a name matching two tags is still KNOWN — the app resolves it (GUI parity)", () => {
    // A duplicate-name pair is a Cloud-sync-only pathological state; the resolver
    // does not pick a uuid — it passes the NAME through and the app resolves it,
    // exactly as its GUI does. No ambiguity/refusal path exists.
    const root = seedTag(fixture.db, "Work");
    seedTag(fixture.db, "Work", root); // a second `Work`, nested under the first
    expect(resolveTagRefs(fixture.db, ["Work"])).toEqual({ titles: ["Work"], missing: [] });
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

  it("creates a uuid-shaped name verbatim (no uuid heuristic — a tag CAN be named like a uuid)", () => {
    expect(planTagCreation(fixture.db, ["abc123def456ghi789jkl0"])).toEqual([
      { title: "abc123def456ghi789jkl0" },
    ]);
  });

  it("plans a repeated path segment across refs exactly once", () => {
    expect(planTagCreation(fixture.db, ["Work/A", "Work/B"])).toEqual([
      { title: "Work" },
      { title: "A", parent: "Work" },
      { title: "B", parent: "Work" },
    ]);
  });
});
