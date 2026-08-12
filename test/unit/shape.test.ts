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

import {
  bucketRecord,
  shapeReadPayload,
  withAreaBucketTotals,
  withSectionTotals,
  withUpcomingBlockTotals,
} from "../../src/read/shape.ts";

type Obj = Record<string, unknown>;

/**
 * Assemble the internal `derived` substrate bag from flat overrides — so the
 * fixtures keep accepting `todo({ start, today, evening, … })` at the top level
 * while the entity nests them (one-vocabulary Batch 2). `reminderRaw` seeds the
 * substrate's RAW reminder byte (distinct from the top-level live-gated
 * `reminder`); shaping drops the whole bag, so it must never leak.
 */
function derived(over: Obj): Obj {
  const bag: Obj = {
    start: over["start"] ?? "active",
    logged: over["logged"] ?? false,
    trashed: over["trashed"] ?? false,
    reminder: over["reminderRaw"] ?? null,
  };
  if (over["today"] !== undefined) bag["today"] = over["today"];
  if (over["evening"] !== undefined) bag["evening"] = over["evening"];
  return bag;
}

const SUBSTRATE_KEYS = new Set(["logged", "trashed", "start", "today", "evening", "reminderRaw"]);

/** Strip the flat substrate keys an override may carry (they route into `derived`). */
function withoutSubstrate(over: Obj): Obj {
  const rest: Obj = {};
  for (const [k, v] of Object.entries(over)) if (!SUBSTRATE_KEYS.has(k)) rest[k] = v;
  return rest;
}

/** A fully-populated UNDATED-active to-do (stage `anytime`) — every emit field. */
function todo(over: Obj = {}): Obj {
  return {
    uuid: "todo-1",
    type: "to-do",
    title: "write the report",
    notes: "first line of the notes\nand a second line",
    status: "open",
    startDate: null,
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
    ...withoutSubstrate(over),
    derived: derived(over),
  };
}

function project(over: Obj = {}): Obj {
  return {
    uuid: "proj-1",
    type: "project",
    title: "Q3 launch",
    notes: "",
    status: "open",
    startDate: null,
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
    ...withoutSubstrate(over),
    derived: derived(over),
  };
}

const first = (out: unknown): Obj => (out as Obj[])[0]!;

/** A v2 project-view heading container fixture (empty children) at a lifecycle class. */
const mkHeadingContainer = (uuid: string, status: string, stopped: Date | null): Obj => ({
  heading: {
    uuid,
    type: "heading",
    title: uuid,
    status,
    stopped,
    project: { uuid: "proj-1", title: "Q3" },
  },
  children: [],
});

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

describe("shapeReadPayload — §9n reminder (live-gated top-level; raw substrate never leaks)", () => {
  // The §9n gating now lives at the mapper: the top-level `reminder` a fixture
  // carries is ALREADY the live value (null once the byte is stale, its
  // startDate past). The RAW byte lives only in the `derived` substrate, which
  // shaping drops wholesale — so shaping just passes the top-level reminder
  // through, and a null one is pruned downstream by omit-empty (exactly like
  // `deadline: null`). The raw substrate byte never leaks onto the wire.
  it("keeps a LIVE reminder and never leaks the raw substrate byte, both tiers", () => {
    for (const full of [false, true]) {
      const row = first(
        shapeReadPayload(
          "search",
          [todo({ startDate: "2026-07-15", reminder: "18:00", reminderRaw: "18:00" })],
          full,
        ),
      );
      expect(row["reminder"]).toBe("18:00");
      expect("derived" in row).toBe(false); // the whole substrate (incl raw byte) is gone
    }
  });

  it("a STALE reminder is null at the top level (raw byte only in the dropped substrate), both tiers", () => {
    for (const full of [false, true]) {
      const row = first(
        shapeReadPayload(
          "search",
          // Mapper output for a stale reminder: top-level null, raw byte in substrate.
          [todo({ startDate: "2026-07-01", reminder: null, reminderRaw: "18:00" })],
          full,
        ),
      );
      expect(row["reminder"] ?? null).toBeNull(); // pruned by omit-empty on the wire
      expect("derived" in row).toBe(false);
    }
  });

  it("passes the live/stale reminder through faithfully on a detail read", () => {
    const stale = shapeReadPayload(
      "detail",
      todo({ startDate: "2026-07-01", reminder: null, reminderRaw: "18:00" }),
      false,
    ) as Obj;
    expect(stale["reminder"] ?? null).toBeNull();
    expect("derived" in stale).toBe(false);

    const live = shapeReadPayload(
      "detail",
      todo({ startDate: "2026-07-15", reminder: "18:00", reminderRaw: "18:00" }),
      false,
    ) as Obj;
    expect(live["reminder"]).toBe("18:00");
    expect("derived" in live).toBe(false);
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

  it("instance detail: FIXED template context emits `repeats` {rule, next} beside `instanceOf`", () => {
    const rule = { type: "fixed", unit: "weekly", interval: 1, offsets: [], version: 4 };
    const detail = todo({
      repeating: {
        isTemplate: false,
        isInstance: true,
        templateUuid: "tmpl-1",
        repeats: { rule, next: "2026-08-19" },
      },
    });
    const out = shapeReadPayload("detail", detail, false) as Obj;
    // The instance marker + write handle stays exactly as-is (R11).
    expect(out["instanceOf"]).toBe("tmpl-1");
    // The template's joined repeat context — `rule` byte-consistent with a
    // template card's `repeating.rule`, `next` the fixed-mode projection.
    expect(out["repeats"]).toEqual({ rule, next: "2026-08-19" });
    expect("repeating" in out).toBe(false); // an instance carries no `repeating` object
  });

  it("instance detail: AFTER-COMPLETION context emits `repeats` {rule} with NO `next`", () => {
    const rule = { type: "after-completion", unit: "daily", interval: 1, offsets: [], version: 4 };
    const detail = todo({
      repeating: {
        isTemplate: false,
        isInstance: true,
        templateUuid: "tmpl-2",
        // No successor date exists until the current instance completes — the
        // mirror join leaves `next` absent (mode readable from `rule.type`).
        repeats: { rule },
      },
    });
    const out = shapeReadPayload("detail", detail, false) as Obj;
    expect(out["repeats"]).toEqual({ rule });
    expect("next" in (out["repeats"] as Obj)).toBe(false);
  });

  it("instance detail: paused template surfaces `paused: true` inside `repeats`", () => {
    const rule = { type: "fixed", unit: "monthly", interval: 1, offsets: [], version: 4 };
    const detail = todo({
      repeating: {
        isTemplate: false,
        isInstance: true,
        templateUuid: "tmpl-3",
        repeats: { rule, next: "2026-09-01", paused: true },
      },
    });
    const out = shapeReadPayload("detail", detail, false) as Obj;
    expect(out["repeats"]).toEqual({ rule, next: "2026-09-01", paused: true });
  });

  it("instance detail: a dangling/absent template context omits `repeats` (no crash)", () => {
    const detail = todo({
      repeating: { isTemplate: false, isInstance: true, templateUuid: "tmpl-gone" },
    });
    const out = shapeReadPayload("detail", detail, false) as Obj;
    expect(out["instanceOf"]).toBe("tmpl-gone"); // the instance still renders
    expect("repeats" in out).toBe(false); // no context → no key
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
    // The derived surfaces KEEP stage. (`upcoming` is stage-MIXED too, but it
    // reshapes into day-block sections — asserted in the day-block suite below.)
    // `deadlines` is stage-MIXED (to-dos + projects, deadline-ordered) — kept.
    for (const kind of ["search", "changes", "deadlines", "projects"]) {
      const row = first(shapeReadPayload(kind, [todo()], false));
      expect(row["stage"]).toBe("anytime"); // kept
    }
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

  it("`when` drops inside the today view's two `children` bucket records (the bucket key states it)", () => {
    const view = {
      today: [todo({ today: true })],
      evening: [todo({ uuid: "todo-e", today: true, evening: true })],
      counts: { dueOrOverdue: 0, other: 2 },
    };
    // v2: shapeReadPayload("today") returns the two bucket records
    // `{ today: { items }, evening: { items } }` (counts ride meta, not data).
    const out = shapeReadPayload("today", view, false) as Obj;
    const t = ((out["today"] as Obj)["items"] as Obj[])[0]!;
    const e = ((out["evening"] as Obj)["items"] as Obj[])[0]!;
    expect("when" in t).toBe(false); // bucket key states today
    expect("when" in e).toBe(false); // bucket key states evening
    // R13: every Today member derives stage `anytime`, so both buckets are
    // stage-PURE and the field is DROPPED (was kept as "mixed" pre-R13).
    expect("stage" in t).toBe(false);
    expect("stage" in e).toBe(false);
    // The whole-view counts aggregate is NOT in the shaped data.
    expect("counts" in out).toBe(false);
    expect("badge" in out).toBe(false);
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

  it("area-view v2: children records (anytime/upcoming[]/someday, NO logbook) + projects record; card node kept", () => {
    const view = {
      area: { uuid: "area-1", title: "Work", visible: true, tags: [{ title: "focus" }] },
      active: [todo({ uuid: "direct-anytime" })],
      projects: [project()],
      // A future-dated direct to-do → children.upcoming day block (by its startDate).
      scheduled: [
        { date: "2026-08-01", items: [todo({ uuid: "direct-up", startDate: "2026-08-01" })] },
      ],
      someday: [todo({ uuid: "direct-some", start: "someday", startDate: null })],
      // A resting recurring template → the trailing {when:null} block (#V8).
      repeating: [
        todo({
          uuid: "direct-tmpl",
          repeating: {
            isTemplate: true,
            isInstance: false,
            templateUuid: null,
            nextOccurrence: null,
          },
        }),
      ],
      logged: [],
      trashed: [],
    };
    const out = shapeReadPayload("area-view", view, true) as Obj;
    // Top-level: EXACTLY {area, children, projects} — no logbook/trash, no render
    // fields (active/scheduled/repeating), no v1 flat buckets.
    expect(Object.keys(out).toSorted()).toEqual(["area", "children", "projects"]);
    const children = out["children"] as Obj;
    // children has the THREE stage keys — NO `logbook` (an area has no logged-
    // children region; its logbook is `things logbook --area <ref>`, #346).
    expect(Object.keys(children).toSorted()).toEqual(["anytime", "someday", "upcoming"]);
    expect("logbook" in children).toBe(false);
    const items = (b: unknown) => ((b as Obj)["items"] as Obj[]).map((i) => i["uuid"]);
    expect(items(children["anytime"])).toEqual(["direct-anytime"]);
    expect(items(children["someday"])).toEqual(["direct-some"]);
    // Upcoming: the dated block, then the trailing {when:null} resting block (R3/#V8).
    const upcoming = children["upcoming"] as Array<{ when: string | null; items: Obj[] }>;
    expect(upcoming.map((g) => g.when)).toEqual(["2026-08-01", null]);
    expect(upcoming[0]!.items.map((i) => i["uuid"])).toEqual(["direct-up"]);
    expect(upcoming[1]!.items.map((i) => i["uuid"])).toEqual(["direct-tmpl"]);
    // A direct-to-do row drops area (the node states it) + the bucket-implied stage.
    const anyChild = ((children["anytime"] as Obj)["items"] as Obj[])[0]!;
    expect("area" in anyChild).toBe(false);
    expect("stage" in anyChild).toBe(false);
    expect(anyChild["project"]).toBeDefined();
    // The projects record: {items} (uncapped → no `total`), rows keep stage, drop area.
    const projects = out["projects"] as Obj;
    expect("total" in projects).toBe(false);
    const projRow = (projects["items"] as Obj[])[0]!;
    expect("area" in projRow).toBe(false);
    expect(projRow["stage"]).toBe("anytime");
    // The area node keeps its identity; its tags fold to names.
    expect(out["area"]).toEqual({ uuid: "area-1", title: "Work", visible: true, tags: ["focus"] });
  });

  it("area-view v2: the loose pseudo-area keeps area: null", () => {
    const view = {
      area: null,
      active: [todo({ uuid: "loose-anytime", area: null, project: null })],
      projects: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      trashed: [],
    };
    const out = shapeReadPayload("area-view", view, true) as Obj;
    expect(out["area"]).toBeNull();
    const children = out["children"] as Obj;
    expect(((children["anytime"] as Obj)["items"] as Obj[]).map((i) => i["uuid"])).toEqual([
      "loose-anytime",
    ]);
  });

  it("area-view v2 R7: a someday direct to-do WITH a deadline seats in someday, in NO day block (single seat)", () => {
    const view = {
      area: { uuid: "area-1", title: "Work" },
      active: [],
      projects: [],
      scheduled: [],
      // A dual citizen: someday stage carrying a deadline. R7 seats it in its
      // canonical stage bucket (someday), never also in an upcoming day block.
      someday: [todo({ uuid: "dual", start: "someday", startDate: null, deadline: "2026-09-01" })],
      repeating: [],
      logged: [],
      trashed: [],
    };
    const out = shapeReadPayload("area-view", view, true) as Obj;
    const children = out["children"] as Obj;
    expect(((children["someday"] as Obj)["items"] as Obj[]).map((i) => i["uuid"])).toEqual([
      "dual",
    ]);
    // Not in any upcoming day block — no uuid appears twice in the view.
    const upcoming = children["upcoming"] as Array<{ items: Obj[] }>;
    expect(upcoming.flatMap((g) => g.items.map((i) => i["uuid"]))).not.toContain("dual");
  });

  it("area-view v2: withAreaBucketTotals stamps inline `total` iff a scope was capped (R1)", () => {
    const view = {
      area: null,
      children: {
        anytime: { items: [todo({ uuid: "a1" }), todo({ uuid: "a2" })] }, // 2 shown
        upcoming: [],
        someday: { items: [] },
      },
      projects: { items: [project()] }, // 1 shown
    };
    // anytime capped (2 < 35), projects capped (1 < 30) → both totals present.
    const capped = withAreaBucketTotals(view, { anytime: 35, projects: 30 }) as Obj;
    expect((capped["children"] as Obj)["anytime"]).toMatchObject({ total: 35 });
    expect(capped["projects"]).toMatchObject({ total: 30 });
    // The uncapped blocks never gain a total; key order preserved.
    expect(Object.keys(capped)).toEqual(["area", "children", "projects"]);
    // Uncapped (shown === total) → no `total` restated.
    const whole = withAreaBucketTotals(view, { anytime: 2, projects: 1 }) as Obj;
    expect("total" in ((whole["children"] as Obj)["anytime"] as Obj)).toBe(false);
    expect("total" in (whole["projects"] as Obj)).toBe(false);
  });

  it("project-view v2: body children bucket by stage under `children`; per-container logbook; advisories + root logbook + logbookHeadings DELETED", () => {
    const looseRef = { heading: null, headingProject: null };
    const view = {
      project: project(),
      // The v2 wire reads ONLY project + bodyChildren + headingContainers. The
      // render-only fields (active/scheduled/logged/loggedHeadings/advisories) are
      // seeded here to PROVE they never leak onto the wire.
      bodyChildren: [
        todo({ uuid: "loose-anytime", ...looseRef }), // stage anytime
        todo({ uuid: "loose-up", startDate: "2026-08-01", ...looseRef }), // stage upcoming (future)
        todo({ uuid: "loose-some", start: "someday", startDate: null, ...looseRef }), // someday
        todo({
          uuid: "loose-tmpl",
          ...looseRef,
          repeating: {
            isTemplate: true,
            isInstance: false,
            templateUuid: null,
            nextOccurrence: null,
          },
        }), // resting template → the {when:null} block
        todo({ uuid: "gone-log", status: "completed", logged: true, ...looseRef }), // stage logbook
      ],
      headingContainers: [
        {
          heading: {
            uuid: "head-1",
            type: "heading",
            title: "Phase 1",
            status: "open",
            stopped: null,
            project: { uuid: "proj-1", title: "Q3" },
          },
          children: [
            todo({ uuid: "h-anytime", heading: { uuid: "head-1", title: "Phase 1" } }),
            todo({
              uuid: "h-up",
              startDate: "2026-08-05",
              heading: { uuid: "head-1", title: "Phase 1" },
            }),
            todo({
              uuid: "h-log",
              status: "completed",
              logged: true,
              stopped: new Date("2026-07-19T00:00:00.000Z"),
              heading: { uuid: "head-1", title: "Phase 1" },
            }),
          ],
        },
      ],
      // Render-only fields (must NOT survive onto the wire):
      active: [todo({ uuid: "leak-active" })],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [todo({ uuid: "leak-logged" })],
      loggedHeadings: [{ heading: {}, items: [] }],
      openChildrenWhileResolved: 3,
      openChildrenUnderArchivedHeading: 2,
    };
    const out = shapeReadPayload("project-view", view, true) as Obj; // FULL tier
    // Top-level: EXACTLY {project, children, headings} — nothing else (#V12: no
    // advisory keys, no root logbook, no logbookHeadings, no render-only buckets).
    expect(Object.keys(out).toSorted()).toEqual(["children", "headings", "project"]);
    const children = out["children"] as Obj;
    const items = (b: unknown) => ((b as Obj)["items"] as Obj[]).map((i) => i["uuid"]);
    // Body children re-bucketed by stage into the four RECORDS.
    expect(items(children["anytime"])).toEqual(["loose-anytime"]);
    expect(items(children["someday"])).toEqual(["loose-some"]);
    expect(items(children["logbook"])).toEqual(["gone-log"]); // per-container logbook (R6)
    // Upcoming: dated block, then the trailing {when:null} resting block (R3/#V8).
    const upcoming = children["upcoming"] as Array<{ when: string | null; items: Obj[] }>;
    expect(upcoming.map((g) => g.when)).toEqual(["2026-08-01", null]);
    expect(upcoming[0]!.items.map((i) => i["uuid"])).toEqual(["loose-up"]);
    expect(upcoming[1]!.items.map((i) => i["uuid"])).toEqual(["loose-tmpl"]);
    // R12: inside a day block `when` drops (the block states it); the full tier
    // keeps the raw `startDate` substrate.
    expect("when" in upcoming[0]!.items[0]!).toBe(false);
    expect(upcoming[0]!.items[0]!["startDate"]).toBe("2026-08-01");
    // A re-bucketed body child drops project/area/stage (bucket + card state them).
    const anyChild = ((children["anytime"] as Obj)["items"] as Obj[])[0]!;
    expect("project" in anyChild).toBe(false);
    expect("area" in anyChild).toBe(false);
    expect("stage" in anyChild).toBe(false);
    // The BODY logbook row: no heading (un-headed), no project, stage-pure (dropped).
    const bodyLog = ((children["logbook"] as Obj)["items"] as Obj[])[0]!;
    expect("heading" in bodyLog).toBe(false);
    expect("project" in bodyLog).toBe(false);
    expect("stage" in bodyLog).toBe(false);
    // Heading node → {uuid, title, children}: an OPEN heading carries no `archived`.
    const grp = (out["headings"] as Obj[])[0]!;
    expect(Object.keys(grp).toSorted()).toEqual(["children", "title", "uuid"]);
    expect(grp["uuid"]).toBe("head-1");
    expect(grp["title"]).toBe("Phase 1");
    expect("archived" in grp).toBe(false);
    const hChildren = grp["children"] as Obj;
    expect(items(hChildren["anytime"])).toEqual(["h-anytime"]);
    expect((hChildren["upcoming"] as Array<{ when: string | null }>)[0]!.when).toBe("2026-08-05");
    // Swept child of a LIVE heading nests in ITS children.logbook (R6) — and in v2
    // DROPS its heading ref (its position UNDER headings[].children states it, task
    // item 6), unlike the v1 flat root logbook that kept it.
    expect(items(hChildren["logbook"])).toEqual(["h-log"]);
    const hLog = ((hChildren["logbook"] as Obj)["items"] as Obj[])[0]!;
    expect("heading" in hLog).toBe(false);
    expect("project" in hLog).toBe(false);
    expect("stage" in hLog).toBe(false);
    // A live-heading member drops heading (membership structural now).
    expect("heading" in ((hChildren["anytime"] as Obj)["items"] as Obj[])[0]!).toBe(false);
    // The project card node keeps its own area + stage.
    expect((out["project"] as Obj)["area"]).toBeDefined();
    expect((out["project"] as Obj)["stage"]).toBe("anytime");
  });

  it("project-view v2: headings[] recursive — swept-heading logged children nest in ITS children.logbook; the open anomaly rides children.anytime (self-evident under `archived`)", () => {
    const view = {
      project: project(),
      bodyChildren: [],
      // A SWEPT ARCHIVED heading is now an ordinary headings[] entry (R5) carrying
      // `archived`; its children ride ITS recursive `children` by stage.
      headingContainers: [
        {
          heading: {
            uuid: "arch-1",
            type: "heading",
            title: "Done Phase",
            status: "completed",
            stopped: new Date("2026-07-20T12:00:00.000Z"),
            project: { uuid: "proj-1", title: "Q3" },
          },
          children: [
            todo({
              uuid: "swept-newer",
              status: "completed",
              logged: true,
              stopped: new Date("2026-07-18T00:00:00.000Z"),
              heading: { uuid: "arch-1", title: "Done Phase" },
            }),
            todo({
              uuid: "swept-older",
              status: "completed",
              logged: true,
              stopped: new Date("2026-07-10T00:00:00.000Z"),
              heading: { uuid: "arch-1", title: "Done Phase" },
            }),
            // The odd OPEN child a Put-Back stranded (HEADARC2-C) — NOT logged.
            todo({
              uuid: "odd-open",
              status: "open",
              heading: { uuid: "arch-1", title: "Done Phase" },
            }),
          ],
        },
      ],
      active: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
      openChildrenUnderArchivedHeading: 1,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj; // compact
    const grp = (out["headings"] as Obj[])[0]!;
    // The archived heading NODE: type/status/project dropped; `archived` present
    // (a Date, full ISO datetime like `stopped`), no `stage`/`status`.
    expect("type" in grp).toBe(false);
    expect("status" in grp).toBe(false);
    expect("stage" in grp).toBe(false);
    expect("project" in grp).toBe(false);
    expect(grp["uuid"]).toBe("arch-1");
    expect((grp["archived"] as Date).toISOString()).toBe("2026-07-20T12:00:00.000Z");
    const c = grp["children"] as Obj;
    const items = (b: unknown) => ((b as Obj)["items"] as Obj[]).map((i) => i["uuid"]);
    // Logged children in ITS logbook, most-recently-completed first (stopped DESC).
    expect(items(c["logbook"])).toEqual(["swept-newer", "swept-older"]);
    // The open anomaly rides children.anytime (stage anytime) — one entity one
    // place (R5/#V12). Its OPEN status (no `status` key in compact) sitting in a
    // live bucket UNDER an `archived` heading makes the anomaly self-evident; the
    // bucket states the stage, so `stage` is dropped.
    expect(items(c["anytime"])).toEqual(["odd-open"]);
    const odd = ((c["anytime"] as Obj)["items"] as Obj[])[0]!;
    expect("stage" in odd).toBe(false);
    expect("status" in odd).toBe(false); // open → compact-dropped
    // No advisory keys anywhere on the wire (#V12).
    expect("openChildrenUnderArchivedHeading" in out).toBe(false);
    expect("openChildrenWhileResolved" in out).toBe(false);
  });

  it("project-view v2: headings[] holds every lifecycle class in index order (open, archived-unswept, archived-swept)", () => {
    const view = {
      project: project(),
      bodyChildren: [],
      headingContainers: [
        mkHeadingContainer("open-h", "open", null),
        mkHeadingContainer("unswept-h", "completed", new Date("2026-08-04T00:00:00.000Z")), // archived, not swept
        mkHeadingContainer("swept-h", "completed", new Date("2026-06-01T00:00:00.000Z")), // archived + swept
      ],
      active: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
      openChildrenUnderArchivedHeading: 0,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj;
    const heads = out["headings"] as Obj[];
    expect(heads.map((h) => h["uuid"])).toEqual(["open-h", "unswept-h", "swept-h"]); // index order
    expect("archived" in heads[0]!).toBe(false); // open
    expect("archived" in heads[1]!).toBe(true); // archived-unswept still carries archived
    expect("archived" in heads[2]!).toBe(true); // archived-swept
    // Each carries the recursive four-bucket children shape (empty here).
    for (const h of heads) {
      const c = h["children"] as Obj;
      expect(Object.keys(c).toSorted()).toEqual(["anytime", "logbook", "someday", "upcoming"]);
    }
  });

  it("project-view v2: dual citizen — a someday/anytime child with a deadline seats in its CANONICAL stage bucket ONLY, never a day block (R7)", () => {
    const looseRef = { heading: null, headingProject: null };
    const view = {
      project: project(),
      bodyChildren: [
        // A SOMEDAY child with a FUTURE (not-yet-due) deadline: stays someday, no pull.
        todo({
          uuid: "some-dl",
          start: "someday",
          startDate: null,
          deadline: "2026-12-01",
          ...looseRef,
        }),
        // An ANYTIME child with a future deadline: stays anytime.
        todo({ uuid: "any-dl", deadline: "2026-12-01", ...looseRef }),
      ],
      headingContainers: [],
      active: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
      openChildrenUnderArchivedHeading: 0,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj;
    const children = out["children"] as Obj;
    const items = (b: unknown) => ((b as Obj)["items"] as Obj[]).map((i) => i["uuid"]);
    expect(items(children["someday"])).toEqual(["some-dl"]);
    expect(items(children["anytime"])).toEqual(["any-dl"]);
    // NEVER duplicated into a day block — the container view buckets by STAGE, and a
    // deadline never makes the stage `upcoming` (only a future startDate / template).
    expect(children["upcoming"]).toEqual([]);
    // Single seat: no uuid appears twice across the whole view.
    const all = [
      ...items(children["anytime"]),
      ...items(children["someday"]),
      ...items(children["logbook"]),
      ...(children["upcoming"] as Array<{ items: Obj[] }>).flatMap((g) =>
        g.items.map((i) => i["uuid"]),
      ),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("project-view v2: bucket records are {items} with NO `total` when uncapped (R1); bucketRecord presence ⟺ capped", () => {
    const view = {
      project: project(),
      bodyChildren: [todo({ uuid: "a", heading: null, headingProject: null })],
      headingContainers: [],
      active: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
      openChildrenUnderArchivedHeading: 0,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj;
    const children = out["children"] as Obj;
    // The project view is uncapped today, so every record is {items} — no `total`
    // (R1: an untruncated bucket never restates its own length).
    for (const k of ["anytime", "someday", "logbook"]) {
      expect(Object.keys(children[k] as Obj)).toEqual(["items"]);
    }
    // The record constructor's total-presence law: present IFF capped.
    expect(bucketRecord([1, 2])).toEqual({ items: [1, 2] }); // uncapped → absent
    expect(bucketRecord([1, 2], 2)).toEqual({ items: [1, 2] }); // exact → absent
    expect(bucketRecord([1, 2], 5)).toEqual({ items: [1, 2], total: 5 }); // capped → present
  });
});

describe("shapeReadPayload — global upcoming day blocks (read-shape v2 PR 4)", () => {
  type Section = { when: string | null; items: Obj[]; total?: number };
  const sections = (out: unknown): Section[] => out as Section[];

  /** A future-scheduled to-do (stage upcoming) grouped under its startDate. */
  const scheduled = (uuid: string, date: string): Obj =>
    todo({ uuid, start: "someday", startDate: date });

  it("flat list → dated day blocks (keyed by `when`), then the trailing {when:null} resting block", () => {
    const items = [
      scheduled("up-a", "2026-08-10"),
      scheduled("up-b", "2026-08-10"), // same day → same block
      scheduled("up-c", "2026-08-14"),
      // A date-less resting recurring template → the {when:null} block (#V8).
      todo({
        uuid: "tmpl",
        startDate: null,
        repeating: {
          isTemplate: true,
          isInstance: false,
          templateUuid: null,
          nextOccurrence: null,
        },
      }),
    ];
    const out = sections(shapeReadPayload("upcoming", items, false));
    expect(out.map((s) => s.when)).toEqual(["2026-08-10", "2026-08-14", null]);
    expect(out[0]!.items.map((i) => i["uuid"])).toEqual(["up-a", "up-b"]);
    expect(out[1]!.items.map((i) => i["uuid"])).toEqual(["up-c"]);
    expect(out[2]!.items.map((i) => i["uuid"])).toEqual(["tmpl"]);
  });

  it("no resting templates → NO trailing {when:null} block (it appears only when such rows exist)", () => {
    const out = sections(shapeReadPayload("upcoming", [scheduled("up", "2026-08-10")], false));
    expect(out.map((s) => s.when)).toEqual(["2026-08-10"]);
    expect(out.some((s) => s.when === null)).toBe(false);
  });

  it("rows inside a dated block DROP `when` (the block states it) but KEEP `stage`", () => {
    const out = sections(shapeReadPayload("upcoming", [scheduled("up", "2026-08-10")], false));
    const row = out[0]!.items[0]!;
    expect("when" in row).toBe(false); // the block key states the date
    expect(row["stage"]).toBe("upcoming"); // stage-mixed view → kept
  });

  it("the projection-side mix (R7): future-dated `upcoming` beside deadline-forecast `anytime`/`someday`, each at its day", () => {
    const items = [
      scheduled("up-fut", "2026-08-10"), // stage upcoming, at its startDate
      // Deadline-forecast: an anytime row with NO startDate seats at its DEADLINE day.
      todo({ uuid: "fc-any", start: "active", startDate: null, deadline: "2026-08-12" }),
      // A someday row with a future deadline — a deadline-forecast dual citizen.
      todo({ uuid: "fc-some", start: "someday", startDate: null, deadline: "2026-08-12" }),
    ];
    const out = sections(shapeReadPayload("upcoming", items, false));
    expect(out.map((s) => s.when)).toEqual(["2026-08-10", "2026-08-12"]);
    // The future-dated row keeps stage `upcoming`; the two forecast rows keep their
    // canonical `anytime`/`someday` (R7 — dropping stage here would lose real info).
    const byUuid = new Map(out.flatMap((s) => s.items.map((i) => [i["uuid"], i] as const)));
    expect(byUuid.get("up-fut")!["stage"]).toBe("upcoming");
    expect(byUuid.get("fc-any")!["stage"]).toBe("anytime");
    expect(byUuid.get("fc-some")!["stage"]).toBe("someday");
    // A forecast row carries no when-date pill (its `when` is absent), so the block
    // day-groups it under its deadline with nothing to drop.
    expect("when" in byUuid.get("fc-any")!).toBe(false);
  });

  it("every row keeps its container refs (a global mixed view — no ancestry drop)", () => {
    const out = sections(shapeReadPayload("upcoming", [scheduled("up", "2026-08-10")], false));
    const row = out[0]!.items[0]!;
    // The seed row lives in area Work / project Q3 — both refs survive on the wire.
    expect(row["project"]).toBe("Q3");
    expect(row["area"]).toBe("Work");
  });

  it("withUpcomingBlockTotals stamps a straddled block's inline `total` iff capped (R1)", () => {
    // The flat cap cut day 08-10 to 1 of its 3 rows; day 08-14 (2 of 2) is whole.
    const out = sections(
      shapeReadPayload(
        "upcoming",
        [scheduled("a", "2026-08-10"), scheduled("c", "2026-08-14")],
        false,
      ),
    );
    const totals = new Map<string | null, number>([
      ["2026-08-10", 3], // pre-cap: 3 rows that day, only 1 survived the flat cut
      ["2026-08-14", 2], // pre-cap: 2 rows, but only 1 shown here → also stamped
    ]);
    const stamped = withUpcomingBlockTotals(out, totals) as Section[];
    expect(stamped[0]).toMatchObject({ when: "2026-08-10", total: 3 });
    expect("when" in stamped[0]!).toBe(true);
    // A block whose shown count equals its pre-cap total gets NO `total`.
    const wholeTotals = new Map<string | null, number>([
      ["2026-08-10", 1],
      ["2026-08-14", 1],
    ]);
    const whole = withUpcomingBlockTotals(out, wholeTotals) as Section[];
    expect("total" in whole[0]!).toBe(false);
    expect("total" in whole[1]!).toBe(false);
  });

  it("withUpcomingBlockTotals stamps the resting block via the `null` key; key order stays {when,items,total}", () => {
    const out = sections(
      shapeReadPayload(
        "upcoming",
        [
          todo({
            uuid: "t1",
            startDate: null,
            repeating: {
              isTemplate: true,
              isInstance: false,
              templateUuid: null,
              nextOccurrence: null,
            },
          }),
        ],
        false,
      ),
    );
    const stamped = withUpcomingBlockTotals(out, new Map([[null, 4]])) as Section[];
    expect(Object.keys(stamped[0]!)).toEqual(["when", "items", "total"]);
    expect(stamped[0]).toMatchObject({ when: null, total: 4 });
  });
});

describe("withSectionTotals — global anytime/someday inline section `total` (R1, PR 5)", () => {
  const shaped = (): Obj[] =>
    shapeReadPayload(
      "anytime",
      [
        { area: { uuid: "area-1", title: "Work" }, items: [todo({ uuid: "a" })] },
        { area: null, items: [todo({ uuid: "l" })] },
      ],
      false,
    ) as Obj[];

  it("stamps a capped section's inline `total` keyed by area uuid; loose section keyed by null", () => {
    // Work: 1 shown of a 5-row pre-cap scope → total 5. Loose: 1 of 1 → whole.
    const stamped = withSectionTotals(
      shaped(),
      new Map<string | null, number>([
        ["area-1", 5],
        [null, 1],
      ]),
    ) as Obj[];
    expect(stamped[0]).toMatchObject({ total: 5 });
    // Key order stays {area, items, total} — the section states area first.
    expect(Object.keys(stamped[0]!)).toEqual(["area", "items", "total"]);
    // An untruncated section never restates its own length (R1).
    expect("total" in stamped[1]!).toBe(false);
  });

  it("no inline `total` when a section shows its whole pre-cap scope", () => {
    const stamped = withSectionTotals(
      shaped(),
      new Map<string | null, number>([
        ["area-1", 1],
        [null, 1],
      ]),
    ) as Obj[];
    expect("total" in stamped[0]!).toBe(false);
    expect("total" in stamped[1]!).toBe(false);
  });

  it("returns the input unchanged when it is not a sections array", () => {
    expect(withSectionTotals(null, new Map())).toBeNull();
    expect(withSectionTotals({ items: [] }, new Map())).toEqual({ items: [] });
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
      bodyChildren: [
        todo({ uuid: "loose", project: tmplProject, heading: null, headingProject: null }),
      ],
      headingContainers: [
        {
          heading: {
            uuid: "head-1",
            type: "heading",
            title: "Section",
            status: "open",
            stopped: null,
            project: { uuid: "proj-1", title: "Weekly Review" },
          },
          children: [
            todo({
              uuid: "h-loose",
              project: null,
              heading: { uuid: "head-1", title: "Section" },
              headingProject: tmplProject,
            }),
          ],
        },
      ],
      active: [],
      scheduled: [],
      someday: [],
      repeating: [],
      logged: [],
      loggedHeadings: [],
      openChildrenWhileResolved: 0,
      openChildrenUnderArchivedHeading: 0,
    };
    const out = shapeReadPayload("project-view", view, false) as Obj;
    const loose = ((out["children"] as Obj)["anytime"] as Obj)["items"] as Obj[];
    expect("project" in loose[0]!).toBe(false); // R6 drops the container in a project view
    expect("projectIsTemplate" in loose[0]!).toBe(false); // marker drops WITH the project ref
    const grp = (out["headings"] as Obj[])[0]!;
    const hChild = ((grp["children"] as Obj)["anytime"] as Obj)["items"] as Obj[];
    expect("project" in hChild[0]!).toBe(false);
    expect("projectIsTemplate" in hChild[0]!).toBe(false);
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
