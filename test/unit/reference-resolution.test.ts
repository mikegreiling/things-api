import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeNameKey,
  ReferenceResolutionError,
  resolveAreaUuid,
  resolveNamedRef,
  resolveProjectUuid,
  resolveProjectWriteTarget,
  stripThingsUri,
} from "../../src/read/queries.ts";
import { classifyShowTarget } from "../../src/read/show-target.ts";
import { applyChecklistEdit } from "../../src/client.ts";
import type { ChecklistItemSpec } from "../../src/write/operations.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedProject, seedTag } from "../fixtures/seed.ts";

let fx: FixtureDb;
beforeEach(() => (fx = buildFixtureDb()));
afterEach(() => fx?.close());

const resolveArea = (ref: string) => resolveNamedRef(fx.db, "TMArea", "1=1", [], ref);

const list = (): ChecklistItemSpec[] => [
  { title: "get milk", completed: true },
  { title: "get eggs", completed: false },
  { title: "get milk", completed: false },
];

describe("normalizeNameKey", () => {
  it("folds case, whitespace, and dashes but keeps emoji/symbols", () => {
    expect(normalizeNameKey("On Hold")).toBe("onhold");
    expect(normalizeNameKey("on-hold")).toBe("onhold");
    expect(normalizeNameKey("Family - Jennifer")).toBe("familyjennifer");
    expect(normalizeNameKey("🗄️errand")).toBe("🗄️errand");
    expect(normalizeNameKey("HEALTH")).toBe("health");
  });
});

describe("stripThingsUri", () => {
  it("extracts the id from a Share > Copy Link uri; passes plain refs through", () => {
    expect(stripThingsUri("things:///show?id=ArVfyjWdyQHKVRLxNKaQYA")).toBe(
      "ArVfyjWdyQHKVRLxNKaQYA",
    );
    expect(stripThingsUri("  things:///show?id=ABC123&reveal=1 ")).toBe("ABC123");
    expect(stripThingsUri("things:///show?query=Errands")).toBe("Errands");
    expect(stripThingsUri("ArVfyjWdyQHKVRLxNKaQYA")).toBe("ArVfyjWdyQHKVRLxNKaQYA");
    expect(stripThingsUri("Family")).toBe("Family");
  });
});

describe("tiered name resolution (areas/tags)", () => {
  it("a Share link resolves like the bare uuid it wraps", () => {
    const uuid = "Zx9qWaBc2dEf4gHi6jKl8m";
    fx.db
      .prepare('INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, ?, 1, 0)')
      .run(uuid, "Linked");
    expect(resolveArea(`things:///show?id=${uuid}`).resolved?.uuid).toBe(uuid);
  });

  it("Mike's case: `family` matches `Family` and NOT `Family - Jennifer`", () => {
    seedArea(fx.db, "Family");
    seedArea(fx.db, "Family - Jennifer");
    const r = resolveArea("family");
    expect(r.resolved?.title).toBe("Family");
    expect(r.matches).toBe(1);
  });

  it("case-variant collision is ambiguous — unless the exact casing is given", () => {
    seedArea(fx.db, "Family");
    seedArea(fx.db, "FaMiLy");
    // lowercase matches both at the case-insensitive tier → ambiguous
    expect(resolveArea("family").matches).toBe(2);
    expect(resolveArea("family").resolved).toBeNull();
    // exact casing wins definitively at tier 1, ignoring the other
    expect(resolveArea("Family").resolved?.title).toBe("Family");
    expect(resolveArea("FaMiLy").resolved?.title).toBe("FaMiLy");
  });

  it("normalized tier: space/dash-insensitive when higher tiers miss", () => {
    seedArea(fx.db, "On Hold");
    expect(resolveArea("on-hold").resolved?.title).toBe("On Hold");
    expect(resolveArea("ONHOLD").resolved?.title).toBe("On Hold");
  });

  it("leading emoji is significant: `errand` never matches `🗄️errand`", () => {
    seedTag(fx.db, "🗄️errand");
    const r = resolveNamedRef(fx.db, "TMTag", "1=1", [], "errand");
    expect(r.resolved).toBeNull();
    expect(r.matches).toBe(0);
    // but the full emoji name resolves
    expect(resolveNamedRef(fx.db, "TMTag", "1=1", [], "🗄️errand").resolved?.title).toBe("🗄️errand");
  });

  it("an active tag wins over an archived emoji-prefixed one at the same key", () => {
    seedTag(fx.db, "errand");
    seedTag(fx.db, "🗄️errand");
    expect(resolveNamedRef(fx.db, "TMTag", "1=1", [], "errand").resolved?.title).toBe("errand");
  });

  it("exact uuid resolves; a unique uuid prefix resolves as a last resort", () => {
    // Real Things uuids are base-62 (the fixture generator uses hyphens, which
    // are not valid uuid-prefix input), so insert a realistic one directly.
    const uuid = "Ab3xK9mNpQ2rSt4uVw6yZ0";
    fx.db
      .prepare('INSERT INTO TMArea (uuid, title, visible, "index") VALUES (?, ?, 1, 0)')
      .run(uuid, "Work");
    expect(resolveArea(uuid).resolved?.uuid).toBe(uuid);
    expect(resolveArea(uuid.slice(0, 8)).resolved?.uuid).toBe(uuid);
  });

  it("the throwing wrapper reports not-found vs ambiguous", () => {
    seedArea(fx.db, "Dup");
    seedArea(fx.db, "Dup");
    // Not-found names the accepted forms (Part 2 error copy); ambiguous states
    // the match count and how to disambiguate.
    expect(() => resolveAreaUuid(fx.db, "Nope")).toThrow(
      /no area matching "Nope" — tried uuid, partial-uuid, and name/,
    );
    expect(() => resolveAreaUuid(fx.db, "Dup")).toThrow(/"Dup" matches 2 areas/);
  });
});

/** Run a resolver expected to throw and return the ReferenceResolutionError. */
function grab(fn: () => unknown): ReferenceResolutionError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReferenceResolutionError) return err;
    throw err;
  }
  throw new Error("expected a ReferenceResolutionError");
}

describe("read-side liveness law (project name resolution)", () => {
  // Both read surfaces for a project: the shorthand router (classifyShowTarget)
  // and the canonical `project show` resolver (resolveProjectUuid, trashed:true).
  const shorthand = (ref: string) => classifyShowTarget(fx.db, ref);
  const projectShow = (ref: string) => resolveProjectUuid(fx.db, ref, { trashed: true });

  it("(a) repro: 1 live + 4 trashed same-title twins — BOTH surfaces resolve the LIVE row", () => {
    const live = seedProject(fx.db, { title: "New Stuff", uuid: "livenewstuff000000001a" });
    for (const t of ["NEW STUFF", "new stuff", "New STUFF", "NEW stuff"])
      seedProject(fx.db, { title: t, trashed: true });
    expect(shorthand("New StUfF")).toEqual({ kind: "project", uuid: live });
    expect(projectShow("New StUfF")).toBe(live);
  });

  it("(b) coherence: 2 live twins + 2 trashed — count 2, 2 candidates, trash disclosure", () => {
    seedProject(fx.db, { title: "Dup", index: 1 });
    seedProject(fx.db, { title: "Dup", index: 2 });
    seedProject(fx.db, { title: "Dup", trashed: true });
    seedProject(fx.db, { title: "Dup", trashed: true });
    for (const throwing of [() => shorthand("Dup"), () => projectShow("Dup")]) {
      const err = grab(throwing);
      expect(err.code).toBe("ambiguous");
      // The count matches the candidate list it renders (live rows only).
      expect(err.message).toContain('"Dup" matches 2 projects');
      expect(err.candidates).toHaveLength(2);
      expect(err.candidates.every((c) => c.type === "project")).toBe(true);
      // The dead twins are disclosed, NOT folded into the count.
      expect(err.message).toContain("also matched: 2 in the trash");
    }
  });

  it("(c) unique-dead read fallback: a lone trashed project resolves by name (render discloses it)", () => {
    const ghost = seedProject(fx.db, {
      title: "Ghosted",
      trashed: true,
      uuid: "ghost00000000000000001",
    });
    expect(shorthand("Ghosted")).toEqual({ kind: "project", uuid: ghost });
    expect(projectShow("Ghosted")).toBe(ghost);
    // The WRITE target stays strict — a trashed-only name never resolves there.
    const w = grab(() => resolveProjectWriteTarget(fx.db, "Ghosted"));
    expect(w.code).toBe("not-found");
    expect(w.message).toContain("1 trashed item matches this name — see `things trash`");
  });

  it("(d) multiple trashed-only twins → not-found with the dead-hint tail, no dead candidate", () => {
    seedProject(fx.db, { title: "Phantom", trashed: true });
    seedProject(fx.db, { title: "Phantom", trashed: true });
    for (const throwing of [() => shorthand("Phantom"), () => projectShow("Phantom")]) {
      const err = grab(throwing);
      expect(err.code).toBe("not-found");
      expect(err.candidates).toEqual([]);
      expect(err.message).toContain("2 trashed items match this name — see `things trash`");
    }
  });

  it("(e) cross-kind: 2 live areas + 3 live projects → merged candidate list naming the split", () => {
    seedArea(fx.db, "Split");
    seedArea(fx.db, "Split");
    seedProject(fx.db, { title: "Split", index: 1 });
    seedProject(fx.db, { title: "Split", index: 2 });
    seedProject(fx.db, { title: "Split", index: 3 });
    const err = grab(() => shorthand("Split"));
    expect(err.code).toBe("ambiguous");
    expect(err.message).toContain('"Split" matches 2 areas and 3 projects');
    expect(err.message).toContain("`things area show`");
    expect(err.message).toContain("`things project show`");
    expect(err.candidates).toHaveLength(5);
    expect(err.candidates.filter((c) => c.type === "area")).toHaveLength(2);
    expect(err.candidates.filter((c) => c.type === "project")).toHaveLength(3);
  });

  it("an area that uniquely resolves still outranks a same-named live project (precedence)", () => {
    const area = seedArea(fx.db, "Hobbies");
    seedProject(fx.db, { title: "Hobbies" });
    expect(shorthand("Hobbies")).toEqual({ kind: "area", uuid: area });
  });

  it("an explicit uuid still reaches a trashed project by name-resolution's sibling tier", () => {
    const ghost = seedProject(fx.db, {
      title: "Zzz",
      trashed: true,
      uuid: "Zx9qWaBc2dEf4gHi6jKl8m",
    });
    // A full uuid (explicit intent) reaches the trashed row on `project show`.
    expect(projectShow("Zx9qWaBc2dEf4gHi6jKl8m")).toBe(ghost);
    expect(projectShow("Zx9qWaBc2dEf4g")).toBe(ghost); // a >=6-char partial-uuid too
  });
});

describe("checklist targeting (best-effort title + 1-based index)", () => {
  it("check by title targets the first UNCHECKED match (best-effort on duplicates)", () => {
    const out = applyChecklistEdit(list(), { action: "check", item: "get milk" });
    // the second 'get milk' (index 2) was unchecked → it gets checked; the first stays
    expect(out.map((c) => c.completed)).toEqual([true, false, true]);
  });

  it("uncheck by title targets the first CHECKED match", () => {
    const out = applyChecklistEdit(list(), { action: "uncheck", item: "get milk" });
    expect(out.map((c) => c.completed)).toEqual([false, false, false]);
  });

  it("1-based index targets exactly and overrides title", () => {
    const out = applyChecklistEdit(list(), { action: "rename", index: 2, title: "get bread" });
    expect(out.map((c) => c.title)).toEqual(["get milk", "get bread", "get milk"]);
  });

  it("out-of-range index and unknown title are loud", () => {
    expect(() => applyChecklistEdit(list(), { action: "remove", index: 9 })).toThrow(
      /out of range/,
    );
    expect(() => applyChecklistEdit(list(), { action: "check", item: "ghost" })).toThrow(
      /no checklist item/,
    );
  });
});
