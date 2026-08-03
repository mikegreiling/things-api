/**
 * The read-payload shaping transform (src/read/shape.ts): R6 (no-redundant-
 * ancestry), R7 (named detail tiers), the R9 universal reshapes (checklist /
 * todos / string tags / one project key / repeating), and the R10 lifecycle
 * taxonomy (`stage` replaces start/logged/trashed; today/evening markers; card
 * bucket rename/reshape; bucket-implied stage/marker dropping). Pure function,
 * exercised on hand-built synthetic payloads (no DB). The exhaustive `stage`
 * derivation matrix + the property-style view↔stage consistency test live in
 * test/unit/stage.test.ts.
 */
import { describe, expect, it } from "vitest";

import { shapeReadPayload } from "../../src/read/shape.ts";

type Obj = Record<string, unknown>;

/** A fully-populated UNDATED-active to-do (stage `anytime`) — every emit field. */
function todo(over: Obj = {}): Obj {
  return {
    uuid: "todo-1",
    type: "to-do",
    title: "write the report",
    notes: "first line of the notes\nand a second line",
    status: "open",
    logged: false,
    trashed: false,
    start: "active",
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
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
    startDate: null,
    todaySection: null,
    deadline: null,
    reminder: null,
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

const first = (out: unknown): Obj => (out as Obj[])[0]!;

describe("shapeReadPayload — R7 compact tier (flat list)", () => {
  it("compact keeps identity + structural facts; start/logged/trashed gone, stage kept on mixed", () => {
    const row = first(shapeReadPayload("search", [todo()], false)); // search = mixed → keep stage
    for (const k of ["uuid", "title"]) expect(k in row).toBe(true);
    expect("type" in row).toBe(false); // absent `type` = to-do
    for (const k of ["tags"]) expect(k in row).toBe(true);
    // R10: the three lifecycle fields are gone; the one derived word replaces them.
    expect("start" in row).toBe(false);
    expect("logged" in row).toBe(false);
    expect("trashed" in row).toBe(false);
    expect(row["stage"]).toBe("anytime"); // undated active
    // Default-pruned (absence = default).
    expect("status" in row).toBe(false); // open
    expect("created" in row).toBe(false);
    expect("modified" in row).toBe(false);
  });

  it("--full (full tier) restores created/modified/full notes/heading; still no start/logged/trashed", () => {
    const row = first(shapeReadPayload("search", [todo()], true));
    expect(row["status"]).toBe("open");
    expect("logged" in row).toBe(false);
    expect("trashed" in row).toBe(false);
    expect("start" in row).toBe(false);
    expect(row["stage"]).toBe("anytime");
    expect("created" in row).toBe(true);
    expect("modified" in row).toBe(true);
    expect(row["notes"]).toBe("first line of the notes\nand a second line");
    expect("hasNotes" in row).toBe(false);
    expect(row["heading"]).toBeDefined(); // full tier keeps heading
  });
});

describe("shapeReadPayload — hasNotes marker (compact)", () => {
  it("compact drops the notes string and flags presence with hasNotes", () => {
    const row = first(shapeReadPayload("search", [todo()], false));
    expect("notes" in row).toBe(false);
    expect(row["hasNotes"]).toBe(true);
  });

  it("a notes-less row carries no hasNotes marker (presence-keyed)", () => {
    const row = first(shapeReadPayload("search", [todo({ notes: "" })], false));
    expect("notes" in row).toBe(false);
    expect("hasNotes" in row).toBe(false);
  });
});

describe("shapeReadPayload — §9n reminder gating (keys on the reminderLive marker)", () => {
  // A stale reminder: the byte is on the entity (reminder set) but the
  // materialize-time reminderLive marker is ABSENT (past startDate) — the GUI
  // shows no bell, so the wire must omit the key. A live reminder carries the
  // marker (today/future) and is kept. The marker itself never rides the wire.
  it("drops a STALE reminder (marker absent) in list rows, both tiers", () => {
    for (const full of [false, true]) {
      const row = first(
        shapeReadPayload("search", [todo({ startDate: "2026-07-01", reminder: "18:00" })], full),
      );
      expect("reminder" in row).toBe(false);
      expect("reminderLive" in row).toBe(false); // internal marker never emitted
    }
  });

  it("keeps a LIVE reminder (marker present) and strips only the marker, both tiers", () => {
    for (const full of [false, true]) {
      const row = first(
        shapeReadPayload(
          "search",
          [todo({ startDate: "2026-07-15", reminder: "18:00", reminderLive: true })],
          full,
        ),
      );
      expect(row["reminder"]).toBe("18:00");
      expect("reminderLive" in row).toBe(false); // internal marker never emitted
    }
  });

  it("drops a STALE reminder on a detail read; keeps a live one", () => {
    const stale = shapeReadPayload(
      "detail",
      todo({ startDate: "2026-07-01", reminder: "18:00" }),
      false,
    ) as Obj;
    expect("reminder" in stale).toBe(false);
    expect("reminderLive" in stale).toBe(false);

    const live = shapeReadPayload(
      "detail",
      todo({ startDate: "2026-07-15", reminder: "18:00", reminderLive: true }),
      false,
    ) as Obj;
    expect(live["reminder"]).toBe("18:00");
    expect("reminderLive" in live).toBe(false);
  });
});

describe("shapeReadPayload — R9 universal reshapes (both tiers, detail)", () => {
  it("string tags fold from {title} objects to a plain array of names", () => {
    for (const full of [false, true]) {
      const row = first(
        shapeReadPayload(
          "search",
          [todo({ tags: [{ title: "errand" }, { title: "home" }] })],
          full,
        ),
      );
      expect(row["tags"]).toEqual(["errand", "home"]);
    }
  });

  it("inheritedTags fold to names on a detail read", () => {
    const out = shapeReadPayload(
      "detail",
      todo({ tags: [{ title: "urgent" }], inheritedTags: [{ title: "work" }] }),
      false,
    ) as Obj;
    expect(out["tags"]).toEqual(["urgent"]);
    expect(out["inheritedTags"]).toEqual(["work"]);
  });

  it("an area listing folds each area's tags to names", () => {
    const areas = [
      { uuid: "a1", title: "Work", visible: true, tags: [{ title: "focus" }] },
      { uuid: "a2", title: "Home", visible: true, tags: [] },
    ];
    const out = shapeReadPayload("areas", areas, false) as Obj[];
    expect(out[0]!["tags"]).toEqual(["focus"]);
    expect(out[1]!["tags"]).toEqual([]);
  });

  it("checklist nesting: counts become a presence-keyed object; none → no key", () => {
    for (const full of [false, true]) {
      const withCl = first(shapeReadPayload("search", [todo()], full));
      expect("checklistItemsCount" in withCl).toBe(false);
      expect(withCl["checklist"]).toEqual({ open: 1, total: 3 });
      const noCl = first(
        shapeReadPayload(
          "search",
          [todo({ checklistItemsCount: 0, openChecklistItemsCount: 0 })],
          full,
        ),
      );
      expect("checklist" in noCl).toBe(false);
    }
  });

  it("project todos counts fold into a presence-keyed {open,total}; omit when 0", () => {
    for (const full of [false, true]) {
      const row = first(shapeReadPayload("projects", [project()], full));
      expect(row["todos"]).toEqual({ open: 2, total: 4 });
      expect("untrashedLeafActionsCount" in row).toBe(false);
      const empty = first(
        shapeReadPayload(
          "projects",
          [project({ untrashedLeafActionsCount: 0, openUntrashedLeafActionsCount: 0 })],
          full,
        ),
      );
      expect("todos" in empty).toBe(false);
    }
  });

  it("detail nests checklist items and reshapes repeating (R11 template wire)", () => {
    const detail = todo({
      checklist: [
        { title: "a", status: "completed" },
        { title: "b", status: "open" },
      ],
      repeating: {
        isTemplate: true,
        isInstance: false,
        templateUuid: null,
        nextOccurrence: "2026-08-01",
        paused: true,
      },
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
    // R11: the wire loses isTemplate/isInstance — presence of `repeating` MEANS
    // template; it carries only the rule facts (false booleans default-pruned).
    // R12: `nextOccurrence` moved OUT to the top-level `when` (the template's
    // projected date IS its time position).
    expect(out["repeating"]).toEqual({ paused: true });
    expect("nextOccurrence" in (out["repeating"] as Obj)).toBe(false);
    expect("isTemplate" in (out["repeating"] as Obj)).toBe(false);
    expect("isInstance" in (out["repeating"] as Obj)).toBe(false);
    expect("instanceOf" in out).toBe(false);
    expect(out["stage"]).toBe("upcoming"); // a repeating template → upcoming
    expect(out["when"]).toBe("2026-08-01"); // projected next occurrence = the time position
  });

  it("one project key: a headed item's owning project emits under `project`", () => {
    const row = first(
      shapeReadPayload(
        "search",
        [
          todo({
            project: null,
            heading: { uuid: "head-1", title: "Phase 1" },
            headingProject: { uuid: "proj-1", title: "Q3" },
          }),
        ],
        true,
      ),
    );
    // Flattened to a bare title; full tier forces the projectUuid sibling.
    expect(row["project"]).toBe("Q3");
    expect(row["projectUuid"]).toBe("proj-1");
    expect("headingProject" in row).toBe(false);
  });

  it("compact drops the heading ref on a mixed list; full keeps it (flat title + headingUuid)", () => {
    const compact = first(shapeReadPayload("search", [todo()], false));
    expect("heading" in compact).toBe(false);
    expect("headingUuid" in compact).toBe(false);
    const full = first(shapeReadPayload("search", [todo()], true));
    expect(full["heading"]).toBe("Phase 1");
    expect(full["headingUuid"]).toBe("head-1"); // FULL tier emits the uuid sibling unconditionally
  });
});

describe("shapeReadPayload — R10 stage on flat views (bucket-implied dropping)", () => {
  it("stage-PURE catalogues drop the field; stage-MIXED + derived surfaces keep it (R10.1)", () => {
    for (const kind of ["inbox", "logbook", "trash"]) {
      const row = first(shapeReadPayload(kind, [todo()], false));
      expect("stage" in row).toBe(false); // provably stated by the pure view
    }
    // R10.1: `upcoming` is stage-MIXED (deadline-forecast anytime/someday rows),
    // so it KEEPS stage — alongside the derived surfaces.
    for (const kind of ["upcoming", "search", "changes", "projects"]) {
      const row = first(shapeReadPayload(kind, [todo()], false));
      expect(row["stage"]).toBe("anytime"); // kept
    }
  });

  it("todaySection is retired from the wire on every surface (R10.1)", () => {
    const mixed = first(shapeReadPayload("search", [todo({ todaySection: "today" })], true));
    expect("todaySection" in mixed).toBe(false);
    const pure = first(shapeReadPayload("inbox", [todo({ todaySection: "evening" })], false));
    expect("todaySection" in pure).toBe(false);
    const detail = shapeReadPayload("detail", todo({ todaySection: "evening" }), false) as Obj;
    expect("todaySection" in detail).toBe(false);
  });

  it("trash wins over logbook: a trashed+completed+logged row derives `trash`", () => {
    const row = first(
      shapeReadPayload(
        "search",
        [todo({ status: "completed", logged: true, trashed: true })],
        true,
      ),
    );
    expect(row["stage"]).toBe("trash");
  });
});

describe("shapeReadPayload — R12 `when` (derived time-axis position)", () => {
  it("the today/evening marker KEYS never appear on the wire — `when` replaces them", () => {
    for (const full of [false, true]) {
      const row = first(shapeReadPayload("search", [todo({ today: true, evening: true })], full));
      expect("today" in row).toBe(false);
      expect("evening" in row).toBe(false);
      expect(row["when"]).toBe("evening"); // evening ⊃ today; evening wins
    }
    const todayRow = first(shapeReadPayload("search", [todo({ today: true })], false));
    expect(todayRow["when"]).toBe("today");
  });

  it("a future-scheduled row reads `when: <iso>`; compact drops startDate, full keeps it", () => {
    const compact = first(shapeReadPayload("search", [todo({ startDate: "2026-08-01" })], false));
    expect(compact["when"]).toBe("2026-08-01");
    expect("startDate" in compact).toBe(false); // R12: compact drops the substrate
    const full = first(shapeReadPayload("search", [todo({ startDate: "2026-08-01" })], true));
    expect(full["when"]).toBe("2026-08-01");
    expect(full["startDate"]).toBe("2026-08-01"); // full/detail keep startDate beside when
  });

  it("`when` is KEPT on the today view's flat items; stage dropped (stage-pure)", () => {
    // The today view is one flat `items[]` interleaving Today-proper and
    // This-Evening members, so each row must carry `when` (the render section is
    // derived from it, not a wire bucket). Stage is still dropped — R13 makes
    // every Today member stage `anytime`, so the flat list is stage-PURE.
    const view = {
      items: [todo({ today: true }), todo({ uuid: "todo-e", today: true, evening: true })],
      counts: { dueOrOverdue: 0, other: 2 },
    };
    const out = shapeReadPayload("today", view, false) as Obj[];
    const t = out[0]!;
    const e = out[1]!;
    expect(t["when"]).toBe("today"); // kept — this row is Today-proper
    expect(e["when"]).toBe("evening"); // kept — this row is This-Evening
    expect("stage" in t).toBe(false);
    expect("stage" in e).toBe(false);
  });

  it("`when` is KEPT on anytime/inbox/someday sections — the informative deadline-pull cases", () => {
    // A deadline-pulled inbox item: stage-dropped in the inbox view, yet reads
    // when: "today" (it IS a Today member). Composes.
    const inboxRow = first(
      shapeReadPayload("inbox", [todo({ start: "inbox", today: true })], false),
    );
    expect("stage" in inboxRow).toBe(false); // inbox is stage-pure
    expect(inboxRow["when"]).toBe("today"); // kept — pulled into Today by a deadline
    // A someday-staged deadline-pulled item: stage dropped by the section, when kept.
    const sections = [
      { area: null, items: [todo({ start: "someday", startDate: null, today: true })] },
    ];
    const someday = shapeReadPayload("someday", sections, false) as Obj[];
    const sItem = (someday[0]!["items"] as Obj[])[0]!;
    expect("stage" in sItem).toBe(false); // someday section is stage-pure
    expect(sItem["when"]).toBe("today"); // kept — surfaced in Today, still someday-staged
  });

  it("a logbook/trash row has NO `when` (never a Today member) even if a marker was set", () => {
    const log = first(shapeReadPayload("search", [todo({ logged: true, today: true })], true));
    expect(log["stage"]).toBe("logbook");
    expect("when" in log).toBe(false);
    const trash = first(
      shapeReadPayload("search", [todo({ trashed: true, startDate: "2026-08-01" })], true),
    );
    expect(trash["stage"]).toBe("trash");
    expect("when" in trash).toBe(false);
  });
});

describe("shapeReadPayload — R6 no-redundant-ancestry by view kind", () => {
  it("mixed lists keep every ref (search, full tier)", () => {
    const row = first(shapeReadPayload("search", [todo()], true));
    expect(row["project"]).toBeDefined();
    expect(row["area"]).toBeDefined();
    expect(row["heading"]).toBeDefined();
  });

  it("anytime & someday sections both drop area + stage (both stage-pure, R10.2)", () => {
    const sections = [{ area: { uuid: "area-1", title: "Work" }, items: [todo()] }];
    const anytime = shapeReadPayload("anytime", sections, true) as Obj[];
    const aItem = (anytime[0]!["items"] as Obj[])[0]!;
    expect("area" in aItem).toBe(false);
    expect("stage" in aItem).toBe(false); // R10.2: anytime is stage-pure → dropped
    expect(aItem["project"]).toBeDefined();
    expect(aItem["heading"]).toBeDefined();
    expect(anytime[0]!["area"]).toEqual({ uuid: "area-1", title: "Work" });

    const someday = shapeReadPayload("someday", sections, true) as Obj[];
    const sItem = (someday[0]!["items"] as Obj[])[0]!;
    expect("area" in sItem).toBe(false);
    expect("stage" in sItem).toBe(false); // stage-pure catalogue → dropped
  });

  it("area-view: direct to-dos dissolve into one flat items[] (drop area, keep stage/when); projects[] keeps stage (doctrine §3.13)", () => {
    const view = {
      area: { uuid: "area-1", title: "Work", visible: true, tags: [{ title: "focus" }] },
      // A direct to-do (area FK, no project/heading) + a future-scheduled one.
      items: [
        todo({ uuid: "d-now", heading: null, headingProject: null, project: null }),
        todo({
          uuid: "d-sched",
          startDate: "2026-08-01",
          heading: null,
          headingProject: null,
          project: null,
        }),
      ],
      projects: [project()],
      active: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      trashed: [],
    };
    const out = shapeReadPayload("area-view", view, true) as Obj;
    // ONE flat items[] — stage KEPT (mixed), when kept, area dropped.
    const items = out["items"] as Obj[];
    expect(items.map((i) => i["uuid"])).toEqual(["d-now", "d-sched"]);
    const now = items[0]!;
    expect("area" in now).toBe(false);
    expect(now["stage"]).toBe("anytime");
    const sched = items[1]!;
    expect(sched["stage"]).toBe("upcoming");
    expect(sched["when"]).toBe("2026-08-01");
    // the projects list keeps stage (mixed listing), drops area.
    const projRow = (out["projects"] as Obj[])[0]!;
    expect("area" in projRow).toBe(false);
    expect(projRow["stage"]).toBe("anytime");
    // The area node keeps its identity; its tags fold to names.
    expect(out["area"]).toEqual({ uuid: "area-1", title: "Work", visible: true, tags: ["focus"] });
    // The dissolved stage buckets are gone; an area carries NO logbook/trash bucket.
    for (const k of [
      "anytime",
      "upcoming",
      "someday",
      "active",
      "scheduled",
      "repeating",
      "logged",
      "trashed",
      "logbook",
      "trash",
    ])
      expect(k in out).toBe(false);
  });

  it("project-view: live children dissolve into one flat items[]; headings[] is the memberless catalog (doctrine §3.12)", () => {
    // The library return: one flat `items[]` (index order, heading ref stamped on
    // headed rows) + heading catalog nodes + the logged region. The stage/date
    // sub-buckets are GONE from both the library and the wire.
    const view = {
      project: project(),
      items: [
        todo({ uuid: "loose-anytime", heading: null, headingProject: null }), // stage anytime, unheaded
        todo({ uuid: "loose-up", startDate: "2026-08-01", heading: null, headingProject: null }), // upcoming
        todo({
          uuid: "loose-some",
          start: "someday",
          startDate: null,
          heading: null,
          headingProject: null,
        }), // someday
        todo({
          uuid: "loose-tmpl",
          heading: null,
          headingProject: null,
          repeating: {
            isTemplate: true,
            isInstance: false,
            templateUuid: null,
            nextOccurrence: null,
          },
        }),
        todo({
          uuid: "h-anytime",
          heading: { uuid: "head-1", title: "Phase 1" },
          headingProject: { uuid: "proj-1", title: "Q3" },
        }),
        todo({
          uuid: "h-up",
          startDate: "2026-08-05",
          heading: { uuid: "head-1", title: "Phase 1" },
          headingProject: { uuid: "proj-1", title: "Q3" },
        }),
      ],
      headingCatalog: [
        {
          uuid: "head-1",
          type: "heading",
          title: "Phase 1",
          status: "open",
          project: { uuid: "proj-1", title: "Q3" },
        },
      ],
      logged: [
        todo({
          uuid: "gone-log",
          status: "completed",
          logged: true,
          heading: { uuid: "head-1", title: "Phase 1" },
          headingProject: { uuid: "proj-1", title: "Q3" },
        }),
      ],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
    };
    const out = shapeReadPayload("project-view", view, true) as Obj;
    // ONE flat items[] in the given (index) order — headed + unheaded interleaved.
    const items = out["items"] as Obj[];
    expect(items.map((i) => i["uuid"])).toEqual([
      "loose-anytime",
      "loose-up",
      "loose-some",
      "loose-tmpl",
      "h-anytime",
      "h-up",
    ]);
    // The old stage/date buckets are gone from the wire.
    for (const k of ["anytime", "upcoming", "someday", "active", "scheduled", "repeating"])
      expect(k in out).toBe(false);
    // Each row keeps stage + when, drops project/area.
    const looseUp = items.find((i) => i["uuid"] === "loose-up")!;
    expect(looseUp["stage"]).toBe("upcoming");
    expect(looseUp["when"]).toBe("2026-08-01");
    expect("project" in looseUp).toBe(false);
    expect("area" in looseUp).toBe(false);
    const looseSome = items.find((i) => i["uuid"] === "loose-some")!;
    expect(looseSome["stage"]).toBe("someday");
    // A headed row CARRIES its heading ref (flat title + project-scoped uuid) — the
    // membership that the dissolved buckets used to express structurally.
    const headed = items.find((i) => i["uuid"] === "h-anytime")!;
    expect(headed["heading"]).toBe("Phase 1");
    expect(headed["headingUuid"]).toBe("head-1");
    expect(headed["stage"]).toBe("anytime");
    // An unheaded row carries no heading ref.
    expect(items.find((i) => i["uuid"] === "loose-anytime")!["heading"]).toBeNull();
    // headings[] is the FLAT catalog: each entry is {uuid,title,archived?}.
    const headNode = (out["headings"] as Obj[])[0]!;
    expect("project" in headNode).toBe(false);
    expect("type" in headNode).toBe(false); // positional: always a heading
    expect("status" in headNode).toBe(false);
    expect("archived" in headNode).toBe(false); // open heading
    expect(headNode["uuid"]).toBe("head-1");
    expect(headNode["title"]).toBe("Phase 1");
    // logbook (flat swept rows) — KEEPS its heading ref + stage (mixed bucket),
    // drops project/area.
    const logRow = (out["logbook"] as Obj[])[0]!;
    expect(logRow["heading"]).toBe("Phase 1");
    expect(logRow["headingUuid"]).toBe("head-1");
    expect("project" in logRow).toBe(false);
    expect(logRow["stage"]).toBe("logbook");
    // logbookHeadings is gone from the wire; the catalog + flat logbook subsume it.
    for (const k of [
      "logged",
      "loggedHeadings",
      "logbookHeadings",
      "headingCatalog",
      "trashed",
      "trash",
    ])
      expect(k in out).toBe(false);
    // The project card node keeps its own area + stage.
    expect((out["project"] as Obj)["area"]).toBeDefined();
    expect((out["project"] as Obj)["stage"]).toBe("anytime");
  });

  it("project-view: a swept ARCHIVED heading is a catalog entry with `archived`; its children fold into the flat logbook (doctrine #C3a/#C4)", () => {
    const view = {
      project: project(),
      items: [],
      // The catalog carries the archived heading (index order, all headings).
      headingCatalog: [
        {
          uuid: "arch-1",
          type: "heading",
          title: "Done Phase",
          status: "completed",
          stopped: new Date("2026-07-20T12:00:00.000Z"),
          project: { uuid: "proj-1", title: "Q3" },
        },
      ],
      headings: [],
      logged: [],
      // The library still groups the archived-heading children (for the byte-stable
      // TTY); the shaper folds them into the flat logbook.
      loggedHeadings: [
        {
          heading: {
            uuid: "arch-1",
            type: "heading",
            title: "Done Phase",
            status: "completed",
            stopped: new Date("2026-07-20T12:00:00.000Z"),
            project: { uuid: "proj-1", title: "Q3" },
          },
          items: [
            todo({
              uuid: "swept-child",
              status: "completed",
              logged: true,
              stopped: new Date("2026-07-20T10:00:00.000Z"),
              heading: { uuid: "arch-1", title: "Done Phase" },
              headingProject: { uuid: "proj-1", title: "Q3" },
            }),
            // The odd OPEN child a Put-Back stranded (HEADARC2-C) — kept visible.
            todo({
              uuid: "odd-open",
              status: "open",
              heading: { uuid: "arch-1", title: "Done Phase" },
              headingProject: { uuid: "proj-1", title: "Q3" },
            }),
          ],
        },
      ],
      openChildrenWhileResolved: 0,
      openChildrenUnderArchivedHeading: 1,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj;
    // logbookHeadings is GONE from the wire.
    expect("logbookHeadings" in out).toBe(false);
    // The archived heading is a FLAT catalog entry carrying `archived` (a Date,
    // full ISO datetime like `stopped`); type/status/project dropped.
    const head = (out["headings"] as Obj[])[0]!;
    expect("type" in head).toBe(false);
    expect("status" in head).toBe(false);
    expect("project" in head).toBe(false);
    expect(head["uuid"]).toBe("arch-1");
    expect(head["title"]).toBe("Done Phase");
    expect((head["archived"] as Date).toISOString()).toBe("2026-07-20T12:00:00.000Z");
    // Its children folded into the flat logbook — stopDate DESC (open odd child
    // last), each CARRYING its heading ref now (the flat list, no group header),
    // project dropped, stage KEPT (mixed: logbook + the anytime odd child).
    const logbook = out["logbook"] as Obj[];
    expect(logbook.map((i) => i["uuid"])).toEqual(["swept-child", "odd-open"]);
    for (const i of logbook) {
      // Compact + the round-trip promoter default → bare title, no headingUuid sibling.
      expect(i["heading"]).toBe("Done Phase");
      expect("project" in i).toBe(false);
    }
    expect(logbook[0]!["stage"]).toBe("logbook");
    expect(logbook[1]!["stage"]).toBe("anytime"); // the odd open child, kept visible
    // The odd-state advisory count rides the wire.
    expect(out["openChildrenUnderArchivedHeading"]).toBe(1);
  });
});

describe("shapeReadPayload — projectIsTemplate container marker (the JSON twin of the ↻ glyph)", () => {
  const tmplProject = { uuid: "proj-1", title: "Weekly Review", isRepeatingTemplate: true };

  it("a DIRECT template-project child carries projectIsTemplate: true on BOTH tiers", () => {
    const compact = first(
      shapeReadPayload(
        "search",
        [todo({ project: tmplProject, heading: null, headingProject: null })],
        false,
      ),
    );
    expect(compact["project"]).toBe("Weekly Review");
    expect(compact["projectIsTemplate"]).toBe(true);
    const full = first(
      shapeReadPayload(
        "search",
        [todo({ project: tmplProject, heading: null, headingProject: null })],
        true,
      ),
    );
    expect(full["projectIsTemplate"]).toBe(true); // correctness signal, not detail
  });

  it("a HEADING-NESTED template-project child marks (the fact rides the merged project ref)", () => {
    const row = first(
      shapeReadPayload(
        "search",
        [
          todo({
            project: null,
            heading: { uuid: "head-1", title: "Section" },
            headingProject: tmplProject, // owning project is the template
          }),
        ],
        false,
      ),
    );
    expect(row["project"]).toBe("Weekly Review"); // headingProject merged into project
    expect(row["projectIsTemplate"]).toBe(true);
  });

  it("a same-titled OCCURRENCE child (plain container) carries NO marker", () => {
    const row = first(
      shapeReadPayload(
        "search",
        [
          todo({
            project: { uuid: "occ-1", title: "Weekly Review" }, // no isRepeatingTemplate
            heading: null,
            headingProject: null,
          }),
        ],
        false,
      ),
    );
    expect(row["project"]).toBe("Weekly Review");
    expect(row).not.toHaveProperty("projectIsTemplate");
  });

  it("project-view children drop the project ref → NO orphaned marker (loose + heading-nested)", () => {
    const view = {
      // The project card node's OWN template nature rides its `repeating` key (R11),
      // not this child-container marker — asserted below.
      project: project({
        title: "Weekly Review",
        repeating: {
          isTemplate: true,
          isInstance: false,
          templateUuid: null,
          nextOccurrence: null,
        },
      }),
      items: [
        todo({ uuid: "loose", project: tmplProject, heading: null, headingProject: null }),
        todo({
          uuid: "h-loose",
          project: null,
          heading: { uuid: "head-1", title: "Section" },
          headingProject: tmplProject,
        }),
      ],
      headings: [
        {
          heading: {
            uuid: "head-1",
            type: "heading",
            title: "Section",
            status: "open",
            project: { uuid: "proj-1", title: "Weekly Review" },
          },
        },
      ],
      logged: [],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj;
    const loose = (out["items"] as Obj[]).find((i) => i["uuid"] === "loose")!;
    expect("project" in loose).toBe(false); // R6 drops the container in a project view
    expect("projectIsTemplate" in loose).toBe(false); // marker drops WITH the project ref
    const hChild = (out["items"] as Obj[]).find((i) => i["uuid"] === "h-loose")!;
    expect("project" in hChild).toBe(false);
    expect("projectIsTemplate" in hChild).toBe(false);
    // The project card node exposes its OWN template nature via `repeating` (R11) —
    // the child-container marker never attaches to the card itself.
    expect((out["project"] as Obj)["repeating"]).toBeDefined();
    expect("projectIsTemplate" in (out["project"] as Obj)).toBe(false);
  });
});

describe("shapeReadPayload — R11 repeating template/instance split", () => {
  it("template LIST row: repeating present with rule facts; no discriminators, no latestInstance", () => {
    const row = first(
      shapeReadPayload(
        "search", // mixed list → compact row
        [
          todo({
            uuid: "tmpl-1",
            repeating: {
              isTemplate: true,
              isInstance: false,
              templateUuid: null,
              nextOccurrence: "2026-08-01",
              deadlined: true,
            },
          }),
        ],
        false,
      ),
    );
    // R12: `nextOccurrence` moved OUT to `when`; `repeating` keeps only rule facts.
    expect(row["repeating"]).toEqual({ deadlined: true });
    expect(row["when"]).toBe("2026-08-01"); // projected next occurrence
    // Presence of `repeating` MEANS template — the discriminators are gone.
    expect("isTemplate" in (row["repeating"] as Obj)).toBe(false);
    expect("isInstance" in (row["repeating"] as Obj)).toBe(false);
    // latestInstance is DETAIL-only — never on a list/card row.
    expect("latestInstance" in row).toBe(false);
    // A template is not an instance.
    expect("instanceOf" in row).toBe(false);
  });

  it("paused/after-completion template (no projection): no `when`, bare repeating survives", () => {
    const out = shapeReadPayload(
      "detail",
      todo({
        repeating: {
          isTemplate: true,
          isInstance: false,
          templateUuid: null,
          nextOccurrence: null, // paused / after-completion → no projected date
          paused: true,
        },
      }),
      false,
    ) as Obj;
    // R12: no projected date → no `when`; `repeating` carries the state flags only
    // (and presence of `repeating` still MEANS template — a bare {} would survive).
    expect(out["repeating"]).toEqual({ paused: true });
    expect("nextOccurrence" in (out["repeating"] as Obj)).toBe(false);
    expect("when" in out).toBe(false);
  });

  it("instance row: flat instanceOf only, no repeating object", () => {
    const row = first(
      shapeReadPayload(
        "search",
        [
          todo({
            uuid: "inst-1",
            repeating: { isTemplate: false, isInstance: true, templateUuid: "tmpl-1" },
          }),
        ],
        false,
      ),
    );
    expect(row["instanceOf"]).toBe("tmpl-1");
    // Presence of `instanceOf` MEANS instance — no `repeating` object at all.
    expect("repeating" in row).toBe(false);
    expect("latestInstance" in row).toBe(false);
  });

  it("plain row: neither repeating nor instanceOf", () => {
    const row = first(shapeReadPayload("search", [todo()], false));
    expect("repeating" in row).toBe(false);
    expect("instanceOf" in row).toBe(false);
    expect("latestInstance" in row).toBe(false);
  });

  it("template detail nests latestInstance INSIDE repeating (the complete series object)", () => {
    const out = shapeReadPayload(
      "detail",
      todo({
        repeating: {
          isTemplate: true,
          isInstance: false,
          templateUuid: null,
          nextOccurrence: "2026-08-01",
          latestInstance: "inst-99",
        },
      }),
      false,
    ) as Obj;
    // latestInstance nests INSIDE `repeating` — the backward pointer, symmetric to
    // the top-level `when` forward pointer (R12: nextOccurrence moved to `when`).
    expect("latestInstance" in out).toBe(false);
    expect(out["repeating"]).toEqual({ latestInstance: "inst-99" });
    expect(out["when"]).toBe("2026-08-01");
  });
});

describe("shapeReadPayload — preserves unknown sibling keys", () => {
  it("changeKind on a changes row and match on a search hit ride through", () => {
    const chg = first(shapeReadPayload("changes", [todo({ changeKind: "modified" })], false));
    expect(chg["changeKind"]).toBe("modified");
    const hit = first(
      shapeReadPayload("search", [todo({ match: { field: "heading", text: "Phase 1" } })], true),
    );
    expect(hit["match"]).toEqual({ field: "heading", text: "Phase 1" });
  });
});
