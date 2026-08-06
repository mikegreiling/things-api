/**
 * The wire-key-inventory LOCK (one-vocabulary audit §4). After the `derived`
 * substrate segregation (Batch 2), this is the structural guarantee that:
 *
 *  (a) FORWARD — no entity field leaks onto the item wire: every key a
 *      max-populated to-do / project entity emits through `shapeReadPayload`
 *      (both tiers, every item-bearing kind) is in the frozen allow-list
 *      `WIRE_KEYS ∪ EMISSION_DERIVED`. A new substrate field that forgets to
 *      live under `derived`, or a translation that mints an unexpected key,
 *      fails here with the offending key named.
 *
 *  (b) REVERSE — every frozen key is REACHABLE: across the fixture battery each
 *      allow-listed key is actually emitted somewhere. A latent rename (an
 *      entity field that stops reaching the wire under its own name) makes a
 *      frozen key un-reachable and fails here.
 *
 * Cross-check `WIRE_KEYS` against docs/contract.md (the glossary + "Read views")
 * whenever this list changes — the doc and the lock must not drift.
 */
import { describe, expect, it } from "vitest";

import { shapeReadPayload } from "../../src/read/shape.ts";

type Obj = Record<string, unknown>;

/**
 * The SAME-name consumer wire keys — entity fields that ride the wire under
 * their own name (normalized at the DB boundary, never translated at emit).
 */
const WIRE_KEYS = new Set<string>([
  "uuid",
  "title",
  "type",
  "status",
  "notes",
  "startDate",
  "deadline",
  "reminder",
  "area",
  "project",
  "heading",
  "tags",
  "inheritedTags",
  "created",
  "modified",
  "stopped",
]);

/** The registered emission-DERIVED keys — built at the shape boundary, never raw fields. */
const EMISSION_DERIVED = new Set<string>([
  "stage",
  "when",
  "provisional",
  "hasNotes",
  "checklist",
  "todos",
  "repeating",
  "instanceOf",
  "projectIsTemplate",
  "areaUuid",
  "projectUuid",
  "headingUuid",
]);

const ALLOWED_ITEM = new Set<string>([...WIRE_KEYS, ...EMISSION_DERIVED]);

/** Assemble the internal `derived` substrate bag from flat overrides. */
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

const SUBSTRATE_KEYS = new Set(["start", "logged", "trashed", "today", "evening", "reminderRaw"]);

/** A maximally-populated to-do entity (every optional field set), substrate under `derived`. */
function maxTodo(over: Obj = {}): Obj {
  const rest: Obj = {};
  for (const [k, v] of Object.entries(over)) if (!SUBSTRATE_KEYS.has(k)) rest[k] = v;
  return {
    uuid: "todo-max",
    type: "to-do",
    title: "everything at once",
    notes: "a notes body",
    status: "open",
    startDate: "2026-08-01",
    deadline: "2026-08-10",
    reminder: "09:00",
    area: { uuid: "area-1", title: "Work" },
    project: { uuid: "proj-1", title: "Q3" },
    heading: { uuid: "head-1", title: "Phase 1" },
    tags: [{ title: "urgent" }],
    inheritedTags: [{ title: "team" }],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    checklistItemsCount: 3,
    openChecklistItemsCount: 1,
    checklist: [{ title: "step", status: "open" }],
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-10T00:00:00.000Z"),
    stopped: null,
    ...rest,
    derived: derived(over),
  };
}

/** A maximally-populated project entity. */
function maxProject(over: Obj = {}): Obj {
  const rest: Obj = {};
  for (const [k, v] of Object.entries(over)) if (!SUBSTRATE_KEYS.has(k)) rest[k] = v;
  return {
    uuid: "proj-max",
    type: "project",
    title: "the project",
    notes: "project notes",
    status: "open",
    startDate: "2026-08-01",
    deadline: "2026-08-10",
    reminder: null,
    area: { uuid: "area-1", title: "Work" },
    tags: [{ title: "urgent" }],
    inheritedTags: [{ title: "team" }],
    repeating: { isTemplate: false, isInstance: false, templateUuid: null },
    untrashedLeafActionsCount: 4,
    openUntrashedLeafActionsCount: 2,
    created: new Date("2026-07-01T00:00:00.000Z"),
    modified: new Date("2026-07-10T00:00:00.000Z"),
    stopped: null,
    ...rest,
    derived: derived(over),
  };
}

/** Collect the keys of every item-DTO object (a `uuid`-bearing leaf) in a shaped tree. */
function collectItemKeys(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const el of node) collectItemKeys(el, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const o = node as Obj;
  // An item DTO carries a `uuid` and is not a bucket/section wrapper.
  const isItem = typeof o["uuid"] === "string" && !("items" in o) && !("children" in o);
  if (isItem) {
    for (const k of Object.keys(o)) into.add(k);
    // Do not recurse INTO the item (its `checklist`/`repeating` sub-objects are
    // registered emission-derived keys, not item DTOs of their own).
    return;
  }
  for (const v of Object.values(o)) collectItemKeys(v, into);
}

// Every item-bearing read kind, exercised at BOTH tiers.
const KINDS = ["detail", "search", "inbox", "someday", "anytime", "upcoming", "today"];

function keysFor(data: unknown, kind: string, full: boolean): Set<string> {
  const out = new Set<string>();
  collectItemKeys(shapeReadPayload(kind, data, full), out);
  return out;
}

function payloadFor(kind: string, item: Obj): unknown {
  // Wrap the item in the shape each kind expects at its top level.
  if (kind === "detail") return item;
  if (kind === "today") return { today: [item], evening: [] };
  if (kind === "anytime" || kind === "someday") return [{ area: null, items: [item] }];
  return [item]; // flat list kinds (search / inbox / upcoming)
}

describe("wire-key inventory lock (derived substrate segregation)", () => {
  it("FORWARD — a max entity emits ONLY allow-listed keys, every kind × both tiers", () => {
    for (const item of [maxTodo({ today: true }), maxProject({})]) {
      for (const kind of KINDS) {
        for (const full of [true, false]) {
          const emitted = keysFor(payloadFor(kind, item), kind, full);
          for (const k of emitted) {
            expect(
              ALLOWED_ITEM.has(k),
              `leaked key "${k}" (${kind}, ${full ? "full" : "compact"})`,
            ).toBe(true);
          }
          // The substrate bag itself never rides the wire.
          expect(emitted.has("derived")).toBe(false);
          for (const s of SUBSTRATE_KEYS) expect(emitted.has(s)).toBe(false);
        }
      }
    }
  });

  it("REVERSE — every frozen wire/derived key is REACHABLE across the fixture battery", () => {
    const seen = new Set<string>();
    const add = (data: unknown, kind: string, full: boolean) =>
      collectItemKeys(shapeReadPayload(kind, data, full), seen);

    // Bulk SAME-name + derived keys: a full detail read of a provisional,
    // instance-of-a-template, template-project-parented to-do.
    add(
      maxTodo({
        start: "someday",
        startDate: null, // someday + today marker ⇒ provisional, when="today"
        today: true,
        reminder: "09:00", // top-level live reminder ⇒ the `reminder` wire key
        project: { uuid: "proj-1", title: "Q3", isRepeatingTemplate: true }, // ⇒ projectIsTemplate
        repeating: { isTemplate: false, isInstance: true, templateUuid: "tmpl-1" }, // ⇒ instanceOf
      }),
      "detail",
      true,
    );
    // startDate (full tier substrate) + when=<date> on a strictly-future row.
    add(maxTodo({ startDate: "2099-01-01" }), "detail", true);
    // stage is KEPT on a mixed catalogue (search).
    add([maxTodo({ startDate: "2099-01-01" })], "search", true);
    // hasNotes on the compact tier (notes body → presence marker).
    add([maxTodo({})], "search", false);
    // type(project) + todos + repeating(template) + stopped on a completed template project.
    add(
      maxProject({
        status: "completed",
        stopped: new Date("2026-07-11T00:00:00.000Z"),
        logged: true,
        repeating: {
          isTemplate: true,
          isInstance: false,
          templateUuid: null,
          nextOccurrence: "2026-09-01",
        },
      }),
      "detail",
      true,
    );

    for (const k of ALLOWED_ITEM) {
      expect(seen.has(k), `frozen wire key "${k}" is unreachable — a latent rename?`).toBe(true);
    }
  });

  it("heading GROUP nodes emit only {uuid, title, archived} (+ children)", () => {
    const view = {
      project: maxProject({}),
      bodyChildren: [],
      headingContainers: [
        {
          heading: {
            uuid: "arch-1",
            type: "heading",
            title: "Done Phase",
            status: "completed",
            stopped: new Date("2026-07-20T00:00:00.000Z"),
            project: { uuid: "proj-max", title: "the project" },
          },
          children: [],
        },
      ],
    };
    const shaped = shapeReadPayload("project-view", view, true) as Obj;
    const node = (shaped["headings"] as Obj[])[0]!;
    expect(Object.keys(node).toSorted()).toEqual(["archived", "children", "title", "uuid"]);
  });
});
