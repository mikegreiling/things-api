/**
 * The ONE fixed error-candidate shape ({@link candidateRef}) — the single-source
 * projector every not-found/ambiguous resolution and the did-you-mean fallback
 * flow through. These pins guard the shape against a field leak (the raw
 * internal entity used to ride `error.detail.candidates`, bloating error
 * payloads with counts / notes / null-stuffed keys), enforce presence-keying,
 * and fix the per-kind key set.
 */
import { describe, expect, it } from "vitest";

import { candidateRef, CANDIDATE_CAP, type CandidateRef } from "../../src/index.ts";

/** The complete allowed key set — a candidate may carry NOTHING else. */
const ALLOWED = new Set<keyof CandidateRef>([
  "uuid",
  "title",
  "type",
  "area",
  "project",
  "stage",
  "when",
]);

describe("candidateRef — the fixed disambiguation shape", () => {
  it("CANDIDATE_CAP is 8 (the fixed list cap)", () => {
    expect(CANDIDATE_CAP).toBe(8);
  });

  it("a thin resolver row (uuid+title only) projects to uuid+title+type — nothing else", () => {
    expect(candidateRef("project", { uuid: "p-1", title: "Dup" })).toEqual({
      uuid: "p-1",
      title: "Dup",
      type: "project",
    });
    expect(candidateRef("tag", { uuid: "g-1", title: "home" })).toEqual({
      uuid: "g-1",
      title: "home",
      type: "tag",
    });
  });

  it("schema pin: a FULL internal entity emits ONLY allowed keys — the leak-prone raw fields are dropped", () => {
    // The exact shape that used to leak onto the wire: materialized-entity fields
    // like the leaf-action counts, notes body, checklist counts, dates, and the
    // non-presence-keyed lifecycle booleans.
    const leaky = {
      uuid: "t-1",
      title: "Leaky",
      type: "to-do",
      notes: "a private notes body",
      untrashedLeafActionsCount: 3,
      openUntrashedLeafActionsCount: 1,
      checklistItemsCount: 5,
      openChecklistItemsCount: 2,
      created: new Date(),
      modified: new Date(),
      startDate: null,
      derived: { start: "active", logged: false, trashed: false, reminder: null },
      area: { uuid: "a-1", title: "Home" },
      project: { uuid: "p-1", title: "Roof" },
      repeating: { isTemplate: false, isInstance: false, templateUuid: null },
      reminder: null,
    };
    const c = candidateRef("to-do", leaky) as unknown as Record<string, unknown>;
    for (const k of Object.keys(c)) expect(ALLOWED.has(k as keyof CandidateRef)).toBe(true);
    // the specific leak-prone raw fields are gone
    for (const gone of [
      "notes",
      "untrashedLeafActionsCount",
      "openUntrashedLeafActionsCount",
      "checklistItemsCount",
      "created",
      "modified",
      "logged",
      "trashed",
      "startDate",
      "repeating",
      "reminder",
    ]) {
      expect(c).not.toHaveProperty(gone);
    }
    // container hints are TITLE strings, not Ref objects
    expect(c["area"]).toBe("Home");
    expect(c["project"]).toBe("Roof");
    expect(c).not.toHaveProperty("type"); // absent `type` = to-do
    expect(c["stage"]).toBe("anytime"); // active + undated
  });

  it("presence-keyed: never a null- or undefined-stuffed key", () => {
    const area = candidateRef("area", { uuid: "a-1", title: "Home", visible: true, tags: [] });
    expect(area).toEqual({ uuid: "a-1", title: "Home", type: "area" });
    // an entity with explicit null container refs must NOT stuff area/project
    const c = candidateRef("to-do", {
      uuid: "t-2",
      title: "Loose",
      startDate: null,
      derived: { start: "active", logged: false, trashed: false },
      area: null,
      project: null,
    }) as unknown as Record<string, unknown>;
    for (const v of Object.values(c)) expect(v == null).toBe(false);
    expect(c).not.toHaveProperty("area");
    expect(c).not.toHaveProperty("project");
  });

  it("stage/when only where the source carries the lifecycle fields (same derivations as the wire)", () => {
    // a strictly-future scheduled active to-do → stage upcoming + when=<date>
    const future = candidateRef("to-do", {
      uuid: "t-3",
      title: "Later",
      startDate: "2099-01-01",
      derived: { start: "active", logged: false, trashed: false },
    });
    expect(future.stage).toBe("upcoming");
    expect(future.when).toBe("2099-01-01");
    // a thin project row has neither
    const thin = candidateRef("project", { uuid: "p-2", title: "Thin" });
    expect(thin).not.toHaveProperty("stage");
    expect(thin).not.toHaveProperty("when");
    // areas/tags never carry stage/when even with stray fields
    expect(candidateRef("area", { uuid: "a-2", title: "A", start: "active" })).not.toHaveProperty(
      "stage",
    );
  });

  it("a trashed/logged candidate reads it off `stage` — no separate boolean", () => {
    const trashed = candidateRef("to-do", {
      uuid: "t-4",
      title: "Gone",
      startDate: null,
      derived: { start: "active", logged: false, trashed: true },
    });
    expect(trashed.stage).toBe("trash");
    expect(trashed).not.toHaveProperty("trashed");
    const logged = candidateRef("project", {
      uuid: "p-3",
      title: "Done",
      startDate: null,
      derived: { start: "active", logged: true, trashed: false },
    });
    expect(logged.stage).toBe("logbook");
    expect(logged).not.toHaveProperty("logged");
  });

  it("a heading candidate carries type `heading`", () => {
    expect(candidateRef("heading", { uuid: "h-1", title: "Milestones" })).toEqual({
      uuid: "h-1",
      title: "Milestones",
      type: "heading",
    });
  });
});
