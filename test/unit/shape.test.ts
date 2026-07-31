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
    for (const k of ["uuid", "title", "type"]) expect(k in row).toBe(true);
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
    expect(row["project"]).toEqual({ uuid: "proj-1", title: "Q3" });
    expect("headingProject" in row).toBe(false);
  });

  it("compact drops the heading ref on a mixed list; full keeps it", () => {
    const compact = first(shapeReadPayload("search", [todo()], false));
    expect("heading" in compact).toBe(false);
    const full = first(shapeReadPayload("search", [todo()], true));
    expect(full["heading"]).toEqual({ uuid: "head-1", title: "Phase 1" });
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

  it("`when` drops inside the today view's own sections (the section key states it)", () => {
    const view = {
      today: [todo({ today: true })],
      evening: [todo({ uuid: "todo-e", today: true, evening: true })],
      badge: { dueOrOverdue: 0, other: 2 },
    };
    const out = shapeReadPayload("today", view, false) as Obj;
    const t = (out["today"] as Obj[])[0]!;
    const e = (out["evening"] as Obj[])[0]!;
    expect("when" in t).toBe(false); // section key states today
    expect("when" in e).toBe(false); // section key states evening
    // R13: every Today member derives stage `anytime`, so the today sections are
    // stage-PURE and the field is DROPPED (was kept as "mixed" pre-R13).
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

  it("area-view: children buckets drop area+stage; the projects list keeps stage; card node kept", () => {
    const view = {
      area: { uuid: "area-1", title: "Work", visible: true, tags: [{ title: "focus" }] },
      active: [todo()],
      projects: [project()],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      trashed: [],
    };
    const out = shapeReadPayload("area-view", view, true) as Obj;
    // active → anytime bucket (stage anytime); area + stage dropped.
    const child = (out["anytime"] as Obj[])[0]!;
    expect("area" in child).toBe(false);
    expect("stage" in child).toBe(false);
    expect(child["project"]).toBeDefined();
    // the projects list keeps stage (mixed listing), drops area.
    const projRow = (out["projects"] as Obj[])[0]!;
    expect("area" in projRow).toBe(false);
    expect(projRow["stage"]).toBe("anytime");
    // The area node keeps its identity; its tags fold to names.
    expect(out["area"]).toEqual({ uuid: "area-1", title: "Work", visible: true, tags: ["focus"] });
    // The renamed live buckets exist; the old names are gone. An area carries NO
    // `logbook` or `trash` bucket (the logbook is `things logbook --area`, trash
    // is `things trash`).
    for (const k of ["anytime", "upcoming", "someday"]) expect(k in out).toBe(true);
    for (const k of ["active", "scheduled", "repeating", "logged", "trashed", "logbook", "trash"])
      expect(k in out).toBe(false);
  });

  it("project-view: children re-bucket by stage; heading groups become {anytime,upcoming,someday}", () => {
    const view = {
      project: project(),
      active: [todo({ uuid: "loose-anytime" })], // stage anytime
      scheduled: [
        { date: "2026-08-01", items: [todo({ uuid: "loose-up", startDate: "2026-08-01" })] },
      ],
      someday: [todo({ uuid: "loose-some", start: "someday", startDate: null })],
      repeating: [
        todo({
          uuid: "loose-tmpl",
          repeating: {
            isTemplate: true,
            isInstance: false,
            templateUuid: null,
            nextOccurrence: null,
          },
        }),
      ],
      headings: [
        {
          heading: {
            uuid: "head-1",
            type: "heading",
            title: "Phase 1",
            status: "open",
            project: { uuid: "proj-1", title: "Q3" },
          },
          items: [todo({ uuid: "h-anytime" })],
          scheduled: [
            { date: "2026-08-05", items: [todo({ uuid: "h-up", startDate: "2026-08-05" })] },
          ],
          someday: [],
          repeating: [],
        },
      ],
      logged: [todo({ uuid: "gone-log", status: "completed", logged: true })],
      trashed: [todo({ uuid: "gone-trash", trashed: true })],
      openChildrenWhileResolved: 0,
    };
    const out = shapeReadPayload("project-view", view, true) as Obj;
    // Loose children re-bucketed by stage.
    expect((out["anytime"] as Obj[]).map((i) => i["uuid"])).toEqual(["loose-anytime"]);
    expect((out["someday"] as Obj[]).map((i) => i["uuid"])).toEqual(["loose-some"]);
    // Upcoming: the dated child under its date, then a trailing null group for the date-less template.
    const upcoming = out["upcoming"] as Array<{ date: string | null; items: Obj[] }>;
    expect(upcoming.map((g) => g.date)).toEqual(["2026-08-01", null]);
    expect(upcoming[0]!.items.map((i) => i["uuid"])).toEqual(["loose-up"]);
    expect(upcoming[1]!.items.map((i) => i["uuid"])).toEqual(["loose-tmpl"]);
    // R12: inside a date-group `when` drops (the group states the date); the
    // full tier still keeps the raw `startDate` substrate.
    expect("when" in upcoming[0]!.items[0]!).toBe(false);
    expect(upcoming[0]!.items[0]!["startDate"]).toBe("2026-08-01");
    expect("when" in upcoming[1]!.items[0]!).toBe(false); // resting template — no projection anyway
    // A re-bucketed child drops project/area/stage.
    const anyChild = (out["anytime"] as Obj[])[0]!;
    expect("project" in anyChild).toBe(false);
    expect("area" in anyChild).toBe(false);
    expect("stage" in anyChild).toBe(false);
    // logbook (renamed) carries the logged rows; the project view has NO `trash`
    // bucket — trashed children live only in `things trash` (the seeded
    // `gone-trash` row is dropped entirely).
    expect((out["logbook"] as Obj[]).map((i) => i["uuid"])).toEqual(["gone-log"]);
    expect("trash" in out).toBe(false);
    for (const k of ["active", "scheduled", "repeating", "logged", "trashed"])
      expect(k in out).toBe(false);
    // Heading group reshaped to {heading, anytime, upcoming, someday}.
    const grp = (out["headings"] as Obj[])[0]!;
    expect(Object.keys(grp).toSorted()).toEqual(["anytime", "heading", "someday", "upcoming"]);
    expect((grp["anytime"] as Obj[]).map((i) => i["uuid"])).toEqual(["h-anytime"]);
    const hup = grp["upcoming"] as Array<{ date: string | null; items: Obj[] }>;
    expect(hup[0]!.date).toBe("2026-08-05");
    // Heading-group members drop heading; the heading NODE drops its project ref.
    expect("heading" in (grp["anytime"] as Obj[])[0]!).toBe(false);
    expect("project" in (grp["heading"] as Obj)).toBe(false);
    // The project card node keeps its own area + stage.
    expect((out["project"] as Obj)["area"]).toBeDefined();
    expect((out["project"] as Obj)["stage"]).toBe("anytime");
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
