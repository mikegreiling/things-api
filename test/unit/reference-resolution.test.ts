import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeNameKey,
  resolveAreaUuid,
  resolveNamedRef,
  stripThingsUri,
} from "../../src/read/queries.ts";
import { applyChecklistEdit } from "../../src/client.ts";
import type { ChecklistItemSpec } from "../../src/write/operations.ts";
import { buildFixtureDb, type FixtureDb } from "../fixtures/build-db.ts";
import { seedArea, seedTag } from "../fixtures/seed.ts";

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
