/**
 * The read-payload shaping transform (src/read/shape.ts): the token-economy
 * rules R6 (no-redundant-ancestry) and R7 (named detail tiers) plus the two
 * universal item-DTO reshapes (checklist nesting, repeating omission). Pure
 * function, exercised here on hand-built synthetic payloads (no DB). Guards:
 * per-view R6 ancestry stripping; the compact default-pruning; the notes
 * preview + notesTruncated marker; --full restoring density while R6 still
 * applies; bucket-implied logged/trashed dropping both directions; the checklist
 * object; and repeating omission across tiers and detail.
 */
import { describe, expect, it } from "vitest";

import { shapeReadPayload } from "../../src/read/shape.ts";

type Obj = Record<string, unknown>;

/** A fully-populated to-do row (every field the mappers can emit). */
function fullTodo(over: Obj = {}): Obj {
  return {
    uuid: "todo-1",
    type: "to-do",
    title: "write the report",
    notes: "first line of the notes\nand a second line",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: "2026-07-16",
    todaySection: "today",
    deadline: "2026-07-20",
    reminder: "09:00",
    area: { uuid: "area-1", title: "Work" },
    project: { uuid: "proj-1", title: "Q3" },
    heading: { uuid: "head-1", title: "Phase 1" },
    headingProject: { uuid: "proj-1", title: "Q3" },
    tags: [{ title: "urgent" }],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    checklistItemsCount: 3,
    openChecklistItemsCount: 1,
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-10T00:00:00.000Z"),
    stopped: null,
    ...over,
  };
}

function project(over: Obj = {}): Obj {
  return {
    uuid: "proj-1",
    type: "project",
    title: "Q3 launch",
    notes: "",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    area: { uuid: "area-1", title: "Work" },
    tags: [],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    untrashedLeafActionsCount: 4,
    openUntrashedLeafActionsCount: 2,
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-10T00:00:00.000Z"),
    stopped: null,
    ...over,
  };
}

describe("shapeReadPayload — R7 compact tier (flat list)", () => {
  it("compact keeps identity + structural facts, default-prunes the rest", () => {
    const row = (shapeReadPayload("inbox", [fullTodo()], false) as Obj[])[0]!;
    // Always present.
    for (const k of ["uuid", "title", "type", "start"]) expect(k in row).toBe(true);
    // Structural facts survive.
    for (const k of ["startDate", "deadline", "reminder", "todaySection", "tags"]) {
      expect(k in row).toBe(true);
    }
    // Default-pruned (absence = default).
    expect("status" in row).toBe(false); // open
    expect("logged" in row).toBe(false); // false
    expect("trashed" in row).toBe(false); // false
    // Always dropped in compact.
    expect("created" in row).toBe(false);
    expect("modified" in row).toBe(false);
  });

  it("compact surfaces a non-default status/logged/trashed", () => {
    const row = (
      shapeReadPayload(
        "inbox",
        [fullTodo({ status: "completed", logged: true, trashed: true, notes: "" })],
        false,
      ) as Obj[]
    )[0]!;
    expect(row["status"]).toBe("completed");
    expect(row["logged"]).toBe(true);
    expect(row["trashed"]).toBe(true);
  });

  it("--full (full tier) restores created/modified/full notes and default-valued fields", () => {
    const row = (shapeReadPayload("inbox", [fullTodo()], true) as Obj[])[0]!;
    expect(row["status"]).toBe("open");
    expect(row["logged"]).toBe(false);
    expect(row["trashed"]).toBe(false);
    expect("created" in row).toBe(true);
    expect("modified" in row).toBe(true);
    // Full notes verbatim (no preview, no marker).
    expect(row["notes"]).toBe("first line of the notes\nand a second line");
    expect("notesTruncated" in row).toBe(false);
  });
});

describe("shapeReadPayload — notes preview + notesTruncated", () => {
  it("compact previews the first line and flags the truncation", () => {
    const row = (shapeReadPayload("inbox", [fullTodo()], false) as Obj[])[0]!;
    expect(row["notes"]).toBe("first line of the notes");
    expect(row["notesTruncated"]).toBe(true);
  });

  it("a single short line is complete — no marker", () => {
    const row = (
      shapeReadPayload("inbox", [fullTodo({ notes: "just one line" })], false) as Obj[]
    )[0]!;
    expect(row["notes"]).toBe("just one line");
    expect("notesTruncated" in row).toBe(false);
  });

  it("truncates a long single line at 120 chars and flags it", () => {
    const long = "x".repeat(200);
    const row = (shapeReadPayload("inbox", [fullTodo({ notes: long })], false) as Obj[])[0]!;
    expect((row["notes"] as string).length).toBe(120);
    expect(row["notesTruncated"]).toBe(true);
  });

  it("empty notes stay omitted, no marker", () => {
    const row = (shapeReadPayload("inbox", [fullTodo({ notes: "" })], false) as Obj[])[0]!;
    // omit-empty (a later pass) drops "" — the shaper leaves it "" and no marker.
    expect(row["notes"]).toBe("");
    expect("notesTruncated" in row).toBe(false);
  });
});

describe("shapeReadPayload — universal reshapes (both tiers, detail)", () => {
  it("checklist nesting: counts become a presence-keyed object; none → no key", () => {
    for (const full of [false, true]) {
      const withCl = (shapeReadPayload("inbox", [fullTodo()], full) as Obj[])[0]!;
      expect("checklistItemsCount" in withCl).toBe(false);
      expect("openChecklistItemsCount" in withCl).toBe(false);
      expect(withCl["checklist"]).toEqual({ open: 1, total: 3 });

      const noCl = (
        shapeReadPayload(
          "inbox",
          [fullTodo({ checklistItemsCount: 0, openChecklistItemsCount: 0 })],
          full,
        ) as Obj[]
      )[0]!;
      expect("checklist" in noCl).toBe(false);
    }
  });

  it("detail nests the checklist items under checklist.items and reshapes repeating", () => {
    const detail = fullTodo({
      checklist: [
        { title: "a", status: "completed" },
        { title: "b", status: "open" },
      ],
      repeating: { isTemplate: true, isInstance: false, templateUuid: null, paused: true },
    });
    const out = shapeReadPayload("detail", detail, false) as Obj;
    expect(out["checklist"]).toEqual({
      open: 1,
      total: 3,
      items: [
        { title: "a", status: "completed" },
        { title: "b", status: "open" },
      ],
    });
    // detail is full: created/modified/status/logged retained.
    expect("created" in out).toBe(true);
    expect(out["status"]).toBe("open");
    // repeating minimized to truthful keys only.
    expect(out["repeating"]).toEqual({ isTemplate: true, paused: true });
  });

  it("repeating omission: an all-false block is dropped in BOTH tiers", () => {
    for (const full of [false, true]) {
      const row = (shapeReadPayload("inbox", [fullTodo()], full) as Obj[])[0]!;
      expect("repeating" in row).toBe(false);
    }
  });

  it("an instance keeps only its true/non-null keys", () => {
    const row = (
      shapeReadPayload(
        "inbox",
        [fullTodo({ repeating: { isTemplate: false, isInstance: true, templateUuid: "tmpl-9" } })],
        true,
      ) as Obj[]
    )[0]!;
    expect(row["repeating"]).toEqual({ isInstance: true, templateUuid: "tmpl-9" });
  });
});

describe("shapeReadPayload — R6 no-redundant-ancestry by view kind", () => {
  it("mixed lists keep every ref (inbox)", () => {
    const row = (shapeReadPayload("inbox", [fullTodo()], true) as Obj[])[0]!;
    expect(row["project"]).toBeDefined();
    expect(row["area"]).toBeDefined();
    expect(row["heading"]).toBeDefined();
  });

  it("anytime/someday sections drop area, keep project/heading", () => {
    const sections = [{ area: { uuid: "area-1", title: "Work" }, items: [fullTodo()] }];
    const out = shapeReadPayload("anytime", sections, true) as Array<Obj>;
    const item = (out[0]!["items"] as Obj[])[0]!;
    expect("area" in item).toBe(false);
    expect(item["project"]).toBeDefined();
    expect(item["heading"]).toBeDefined();
    // The section itself keeps its own area.
    expect(out[0]!["area"]).toEqual({ uuid: "area-1", title: "Work" });
  });

  it("area-view children drop area but keep project; the card keeps everything", () => {
    const view = {
      area: { uuid: "area-1", title: "Work", visible: true, tags: [] },
      active: [fullTodo()],
      projects: [project()],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      trashed: [],
    };
    const out = shapeReadPayload("area-view", view, true) as Obj;
    const child = (out["active"] as Obj[])[0]!;
    expect("area" in child).toBe(false);
    expect(child["project"]).toBeDefined();
    const projRow = (out["projects"] as Obj[])[0]!;
    expect("area" in projRow).toBe(false);
    // The area card is untouched (still names its own identity).
    expect(out["area"]).toEqual({ uuid: "area-1", title: "Work", visible: true, tags: [] });
  });

  it("project-view children drop project+area+headingProject; heading members also drop heading", () => {
    const view = {
      project: project(),
      active: [fullTodo()],
      headings: [
        {
          heading: { uuid: "head-1", type: "heading", title: "Phase 1", status: "open" },
          items: [fullTodo({ uuid: "todo-h" })],
          scheduled: [],
          someday: [],
          repeating: [],
        },
      ],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      trashed: [],
      openChildrenWhileResolved: 0,
    };
    const out = shapeReadPayload("project-view", view, true) as Obj;
    const unheaded = (out["active"] as Obj[])[0]!;
    expect("project" in unheaded).toBe(false);
    expect("area" in unheaded).toBe(false);
    expect("headingProject" in unheaded).toBe(false);
    // An unheaded child keeps its heading ref only if it had one; here it does,
    // but the project-view child drop does NOT remove heading for unheaded rows.
    const member = ((out["headings"] as Obj[])[0]!["items"] as Obj[])[0]!;
    expect("project" in member).toBe(false);
    expect("area" in member).toBe(false);
    expect("headingProject" in member).toBe(false);
    expect("heading" in member).toBe(false); // heading-group member drops heading
    // The project card keeps its own area (the node children derive from).
    expect((out["project"] as Obj)["area"]).toBeDefined();
  });
});

describe("shapeReadPayload — R6 invariant: the dropped area equals the enclosing area", () => {
  // The mapper emits the EFFECTIVE area, and a project/heading child carries
  // area = NULL in the DB, so a child's effective area resolves THROUGH its
  // container to the card's area. The transform therefore only ever drops a
  // fact the enclosing node already states — never non-redundant information.
  it("a project-view child's area always matches the card's area (redundant, safe to drop)", () => {
    const cardArea = { uuid: "area-1", title: "Work" };
    const view = {
      project: project({ area: cardArea }),
      active: [fullTodo({ area: cardArea, project: { uuid: "proj-1", title: "Q3 launch" } })],
      headings: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      trashed: [],
      openChildrenWhileResolved: 0,
    };
    // Before shaping, child area === card area (the invariant the mapper guarantees).
    expect(view.active[0]!["area"]).toEqual((view.project as Obj)["area"]);
    const out = shapeReadPayload("project-view", view, true) as Obj;
    // After shaping, the (redundant) child area is gone; the card still states it.
    expect("area" in (out["active"] as Obj[])[0]!).toBe(false);
    expect((out["project"] as Obj)["area"]).toEqual(cardArea);
  });
});

describe("shapeReadPayload — bucket-implied lifecycle flags", () => {
  it("the trash view drops trashed even when true; logbook drops logged", () => {
    const trashed = (
      shapeReadPayload("trash", [fullTodo({ trashed: true, logged: false })], true) as Obj[]
    )[0]!;
    expect("trashed" in trashed).toBe(false); // implied by the view
    const logged = (
      shapeReadPayload("logbook", [fullTodo({ logged: true, trashed: false })], true) as Obj[]
    )[0]!;
    expect("logged" in logged).toBe(false); // implied by the view
  });

  it("the logged/trashed section arrays of a card drop the implied flag", () => {
    const view = {
      project: project(),
      active: [],
      headings: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [fullTodo({ status: "completed", logged: true })],
      trashed: [fullTodo({ trashed: true })],
      openChildrenWhileResolved: 0,
    };
    const out = shapeReadPayload("project-view", view, true) as Obj;
    expect("logged" in (out["logged"] as Obj[])[0]!).toBe(false);
    expect("trashed" in (out["trashed"] as Obj[])[0]!).toBe(false);
  });

  it("a TRUE logged/trashed flag SURVIVES on a mixed surface (search) to disambiguate", () => {
    const row = (
      shapeReadPayload(
        "search",
        [fullTodo({ logged: true, trashed: true, matchedVia: undefined })],
        true,
      ) as Obj[]
    )[0]!;
    expect(row["logged"]).toBe(true);
    expect(row["trashed"]).toBe(true);
  });

  it("preserves unknown sibling keys (changeKind, matchedVia)", () => {
    const chg = (
      shapeReadPayload("changes", [fullTodo({ changeKind: "modified" })], false) as Obj[]
    )[0]!;
    expect(chg["changeKind"]).toBe("modified");
    const hit = (
      shapeReadPayload(
        "search",
        [fullTodo({ matchedVia: { kind: "heading", title: "Phase 1" } })],
        false,
      ) as Obj[]
    )[0]!;
    expect(hit["matchedVia"]).toEqual({ kind: "heading", title: "Phase 1" });
  });
});
