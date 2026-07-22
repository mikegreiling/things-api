// SIMFID cases — one per simulator-covered op (several variants for the ops
// whose fidelity risk concentrates: the make-repeating subtree family). Each
// case seeds a KNOWN synthetic pre-state and returns the op + params, exactly
// the setups test/engine/write-simulator.test.ts already proves the pipeline +
// simulator drive. The SAME logical pre-states are what lab/scripts/simfid.sh
// re-seeds through the guest CLI in a clone for a fresh app-side capture.
//
// Fixtures are FULLY SYNTHETIC (never derived from any real Things data).

import type { DatabaseSync } from "node:sqlite";

import type { OperationKind } from "../../src/write/operations.ts";
import type { WriteOptions } from "../../src/write/pipeline.ts";
import {
  seedArea,
  seedChecklistItem,
  seedHeading,
  seedProject,
  seedTag,
  seedTodo,
  tagTask,
} from "../../test/fixtures/seed.ts";

/** GUI-drive acknowledgement — the recurrence ops are ui-vector (tier 3). */
const GUI: WriteOptions = { dangerouslyDriveGui: true };

export type CaseFamily = "crud" | "recurrence" | "subtree";

export interface SimfidCase {
  id: string;
  op: OperationKind;
  family: CaseFamily;
  title: string;
  /** Seed the pre-state; return the op params (+ optional write options). */
  seed(db: DatabaseSync): { params: Record<string, unknown>; opts?: WriteOptions };
  /** Evidence reference for the app-side ground truth (results-table provenance). */
  evidence: string;
}

export const SIMFID_CASES: SimfidCase[] = [
  // ------------------------------------------------------------------ CRUD
  {
    id: "todo-add-scheduled",
    op: "todo.add",
    family: "crud",
    title: "todo.add — scheduled, tagged, checklisted, deadlined",
    evidence: "a-suite / write-simulator.test.ts",
    seed(db) {
      seedTag(db, "focus");
      return {
        params: {
          title: "SF Add Report",
          notes: "draft first",
          when: "today",
          reminder: "09:30",
          deadline: "2026-07-10",
          tags: ["focus"],
          checklistItems: ["outline", "prose"],
        },
      };
    },
  },
  {
    id: "todo-add-area",
    op: "todo.add",
    family: "crud",
    title: "todo.add — into an area (Anytime promotion)",
    evidence: "a-suite / E-suite filing",
    seed(db) {
      const area = seedArea(db, "SF Errands");
      return { params: { title: "SF Buy Milk", area: { uuid: area } } };
    },
  },
  {
    id: "todo-update",
    op: "todo.update",
    family: "crud",
    title: "todo.update — title / append-notes / when / deadline",
    evidence: "u-suite / e-suite",
    seed(db) {
      const uuid = seedTodo(db, { title: "SF Old", notes: "line1" });
      return {
        params: {
          uuid,
          title: "SF New",
          appendNotes: "line2",
          when: "today",
          deadline: "2026-08-01",
        },
      };
    },
  },
  {
    id: "todo-complete",
    op: "todo.complete",
    family: "crud",
    title: "todo.complete",
    evidence: "u-suite",
    seed(db) {
      return { params: { uuid: seedTodo(db, { title: "SF Done" }) } };
    },
  },
  {
    id: "todo-cancel",
    op: "todo.cancel",
    family: "crud",
    title: "todo.cancel",
    evidence: "u-suite",
    seed(db) {
      return { params: { uuid: seedTodo(db, { title: "SF Cancel" }) } };
    },
  },
  {
    id: "todo-reopen",
    op: "todo.reopen",
    family: "crud",
    title: "todo.reopen (clears stopDate)",
    evidence: "u-suite",
    seed(db) {
      // A REAL completed row always carries a stopDate (the app stamps it on
      // completion); the reopen applier clears it (stopDate → null). Seed one on
      // the pinned RSIM day (2026-07-05) so the sim delta actually exercises the
      // stopDate-clearing transition and matches the app's fresh clone capture —
      // omitting it (insertTask defaults stopDate null) left nothing to clear and
      // masked the transition behind wallclock-bucket (see simfid-results §finding).
      const uuid = seedTodo(db, {
        title: "SF Reopen",
        status: "completed",
        stopDate: Math.floor(Date.UTC(2026, 6, 5, 9, 0, 0) / 1000),
      });
      return { params: { uuid } };
    },
  },
  {
    id: "todo-delete",
    op: "todo.delete",
    family: "crud",
    title: "todo.delete → trash",
    evidence: "x-suite",
    seed(db) {
      return { params: { uuid: seedTodo(db, { title: "SF Trash", start: "active" }) } };
    },
  },
  {
    id: "todo-restore",
    op: "todo.restore",
    family: "crud",
    title: "todo.restore — un-trash into Inbox, de-scheduled (E15)",
    evidence: "e-suite E15",
    seed(db) {
      return {
        params: {
          uuid: seedTodo(db, {
            title: "SF Restore",
            start: "active",
            startDate: "2026-07-01",
            trashed: true,
          }),
        },
      };
    },
  },
  {
    id: "todo-move-project",
    op: "todo.move",
    family: "crud",
    title: "todo.move — into a project",
    evidence: "o-suite / e-suite",
    seed(db) {
      const proj = seedProject(db, { title: "SF Proj" });
      const t = seedTodo(db, { title: "SF Movable" });
      return { params: { uuid: t, project: { uuid: proj } } };
    },
  },
  {
    id: "todo-move-inbox-promote",
    op: "todo.move",
    family: "crud",
    title: "todo.move — inbox item into an area promotes start 0→1",
    evidence: "2026-07-17 filing-semantics fix (probe-backlog §C)",
    seed(db) {
      const area = seedArea(db, "SF FileArea");
      const t = seedTodo(db, { title: "SF FromInbox", start: "inbox" });
      return { params: { uuid: t, area: { uuid: area } } };
    },
  },
  {
    id: "todo-move-inbox",
    op: "todo.move",
    family: "crud",
    title: "todo.move — back to Inbox (de-schedule, detach)",
    evidence: "e-suite",
    seed(db) {
      const proj = seedProject(db, { title: "SF SrcProj" });
      const t = seedTodo(db, {
        title: "SF ToInbox",
        project: proj,
        start: "active",
        startDate: "2026-07-09",
      });
      return { params: { uuid: t, inbox: true } };
    },
  },
  {
    id: "todo-move-heading",
    op: "todo.move",
    family: "crud",
    title: "todo.move — under a heading (project NULL)",
    evidence: "o-suite headings",
    seed(db) {
      const proj = seedProject(db, { title: "SF Book" });
      seedHeading(db, { title: "SF Chapter 1", project: proj });
      const t = seedTodo(db, { title: "SF Para" });
      return { params: { uuid: t, project: { uuid: proj }, heading: "SF Chapter 1" } };
    },
  },
  {
    id: "todo-set-tags",
    op: "todo.set-tags",
    family: "crud",
    title: "todo.set-tags — full replacement",
    evidence: "e-suite",
    seed(db) {
      const uuid = seedTodo(db, { title: "SF Tagged" });
      const old = seedTag(db, "sf-old");
      tagTask(db, uuid, old);
      seedTag(db, "sf-new1");
      seedTag(db, "sf-new2");
      return { params: { uuid, tags: ["sf-new1", "sf-new2"] } };
    },
  },
  {
    id: "todo-replace-checklist",
    op: "todo.replace-checklist",
    family: "crud",
    title: "todo.replace-checklist — wholesale (open + completed)",
    evidence: "p-suite P18",
    seed(db) {
      const uuid = seedTodo(db, { title: "SF Checklist" });
      seedChecklistItem(db, uuid, "stale", { index: 0 });
      return {
        params: { uuid, items: ["a", { title: "b", completed: true }] },
        opts: { acknowledgeChecklistReset: true },
      };
    },
  },
  {
    id: "project-add-area",
    op: "project.add",
    family: "crud",
    title: "project.add — into an area",
    evidence: "a-suite",
    seed(db) {
      const area = seedArea(db, "SF Work");
      return { params: { title: "SF Q3 Launch", area: { uuid: area } } };
    },
  },
  {
    id: "project-update",
    op: "project.update",
    family: "crud",
    title: "project.update — rename",
    evidence: "u-suite",
    seed(db) {
      const uuid = seedProject(db, { title: "SF Launch" });
      return { params: { uuid, title: "SF Launch v2" } };
    },
  },
  {
    id: "project-complete-cascade",
    op: "project.complete",
    family: "crud",
    title: "project.complete — auto-complete cascade (open + already-done child)",
    evidence: "p-suite T08",
    seed(db) {
      const proj = seedProject(db, { title: "SF Cascade" });
      seedTodo(db, { title: "SF Open Child", project: proj });
      seedTodo(db, { title: "SF Done Child", project: proj, status: "completed" });
      return { params: { uuid: proj, children: "auto-complete" } };
    },
  },
  {
    id: "area-add",
    op: "area.add",
    family: "crud",
    title: "area.add — with a tag",
    evidence: "a-suite",
    seed(db) {
      seedTag(db, "sf-deep");
      return { params: { title: "SF Deep Work Area", tags: ["sf-deep"] } };
    },
  },
  {
    id: "area-update-tags",
    op: "area.update",
    family: "crud",
    title: "area.update — replace the tag set",
    evidence: "e-suite",
    seed(db) {
      const area = seedArea(db, "SF Home");
      seedTag(db, "sf-add1");
      seedTag(db, "sf-add2");
      return { params: { target: area, tags: ["sf-add1", "sf-add2"] } };
    },
  },
  {
    id: "tag-add-root",
    op: "tag.add",
    family: "crud",
    title: "tag.add — root",
    evidence: "e-suite",
    seed() {
      return { params: { title: "SF Home Tag" } };
    },
  },
  {
    id: "tag-add-nested",
    op: "tag.add",
    family: "crud",
    title: "tag.add — nested under a parent",
    evidence: "e-suite",
    seed(db) {
      seedTag(db, "SF Parent Tag");
      return { params: { title: "SF Kitchen Tag", parent: "SF Parent Tag" } };
    },
  },
  {
    id: "heading-create",
    op: "heading.create",
    family: "crud",
    title: "heading.create — in a project",
    evidence: "s-suite S02 / HX",
    seed(db) {
      const proj = seedProject(db, { title: "SF Heading Host" });
      return { params: { project: { uuid: proj }, title: "SF New Heading" } };
    },
  },

  // ------------------------------------------------------------- recurrence
  {
    id: "todo-make-repeating-fixed",
    op: "todo.make-repeating",
    family: "recurrence",
    title: "todo.make-repeating FIXED weekly (RSIM1) — source deleted, template + 1 instance",
    evidence: "RSIM1 (docs/lab/rsim-results.md)",
    seed(db) {
      const area = seedArea(db, "SF Garden");
      const tag = seedTag(db, "sf-chores");
      const src = seedTodo(db, {
        title: "SF Water Plants",
        notes: "back porch first",
        area,
        start: "active",
        startDate: "2026-07-01",
      });
      tagTask(db, src, tag);
      return { params: { uuid: src, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "todo-make-repeating-deadline-preserve",
    op: "todo.make-repeating",
    family: "recurrence",
    title:
      "todo.make-repeating FIXED with a DEADLINE (RSIM-T) — source PRESERVED as instance, only the template minted",
    evidence: "RSIM-T (docs/lab/rsim-results.md §RSIM-T)",
    seed(db) {
      // A deadline is the SOLE to-do fixed-preserve trigger (RSIM-T: deadline 1/1
      // preserve vs bare/notes/tag/checklist 4/4 delete).
      const src = seedTodo(db, {
        title: "SF File Report",
        start: "active",
        startDate: "2026-07-01",
        deadline: "2026-08-01",
      });
      return { params: { uuid: src, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "todo-make-repeating-after-completion",
    op: "todo.make-repeating",
    family: "recurrence",
    title: "todo.make-repeating AFTER-COMPLETION weekly (RSIM2) — source preserved as instance",
    evidence: "RSIM2 (docs/lab/rsim-results.md)",
    seed(db) {
      const src = seedTodo(db, {
        title: "SF Refill Filter",
        start: "active",
        startDate: "2026-07-05",
      });
      return {
        params: { uuid: src, frequency: "weekly", interval: 1, afterCompletion: true },
        opts: GUI,
      };
    },
  },
  {
    id: "todo-complete-after-completion-instance",
    op: "todo.complete",
    family: "recurrence",
    title: "todo.complete an after-completion INSTANCE (RSIM4) — stamps template, no new instance",
    evidence: "RSIM4 (docs/lab/rsim-results.md)",
    seed(db) {
      // Seed the after-completion pair directly (template + preserved instance),
      // then complete the instance. Mirrors RSIM4's post-make-repeating state.
      const tmpl = seedTodo(db, {
        title: "SF Compost",
        start: "someday",
        recurrenceRuleXml: afterCompletionWeeklyRule(),
      });
      const inst = seedTodo(db, {
        title: "SF Compost",
        start: "active",
        startDate: "2026-07-05",
        repeatingTemplate: tmpl,
      });
      return { params: { uuid: inst } };
    },
  },
  {
    id: "todo-reschedule-repeat",
    op: "todo.reschedule-repeat",
    family: "recurrence",
    title: "todo.reschedule-repeat weekly→daily/2 (RSIM5) — identity preserved, rule replaced",
    evidence: "RSIM5 (docs/lab/rsim-results.md)",
    seed(db) {
      const tmpl = seedTodo(db, {
        title: "SF Sweep Deck",
        start: "someday",
        recurrenceRuleXml: fixedWeeklyRule(),
        nextInstanceStartDate: "2026-07-06",
      });
      return { params: { uuid: tmpl, frequency: "daily", interval: 2 }, opts: GUI };
    },
  },
  {
    id: "project-make-repeating-fixed",
    op: "project.make-repeating",
    family: "recurrence",
    title: "project.make-repeating FIXED weekly, childless (RSIM6) — area preserved",
    evidence: "RSIM6 (docs/lab/rsim-results.md)",
    seed(db) {
      const area = seedArea(db, "SF Home Ops");
      const proj = seedProject(db, { title: "SF Weekly Review", area, start: "active" });
      return { params: { uuid: proj, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "project-reschedule-repeat",
    op: "project.reschedule-repeat",
    family: "recurrence",
    title: "project.reschedule-repeat weekly→monthly (RSIM5 analog)",
    evidence: "RSIM5 / UIC6",
    seed(db) {
      const tmpl = seedProject(db, {
        title: "SF Repeating Proj",
        start: "someday",
        recurrenceRuleXml: fixedWeeklyRule(),
        nextInstanceStartDate: "2026-07-06",
      });
      return { params: { uuid: tmpl, frequency: "monthly", interval: 1 }, opts: GUI };
    },
  },

  // ---------------------------------------------------------------- subtree
  {
    id: "project-make-repeating-children",
    op: "project.make-repeating",
    family: "subtree",
    title:
      "project.make-repeating FIXED with children (RSIM-P P1) — deep-duplicate, source deleted",
    evidence: "RSIM-P P1 (docs/lab/rsim-results.md §RSIM-P)",
    seed(db) {
      const area = seedArea(db, "SF Zone A");
      const tag = seedTag(db, "SF AlphaTag");
      const proj = seedProject(db, { title: "SF Proj Alpha", area, start: "active" });
      const head = seedHeading(db, { title: "SF Phase 1", project: proj, index: 0 });
      const a1 = seedTodo(db, { title: "SF Task A1", heading: head, index: 0 });
      tagTask(db, a1, tag);
      seedChecklistItem(db, a1, "SF Sub 1", { index: 0 });
      seedChecklistItem(db, a1, "SF Sub 2", { index: 1 });
      seedTodo(db, { title: "SF Task A2", project: proj, index: 1 });
      return { params: { uuid: proj, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "project-make-repeating-after-completion-children",
    op: "project.make-repeating",
    family: "subtree",
    title:
      "project.make-repeating AFTER-COMPLETION with children (RSIM-R, was P4) — source deleted, children PLAIN",
    evidence: "RSIM-R (was RSIM-P P4) (docs/lab/rsim-results.md §RSIM-R)",
    seed(db) {
      const area = seedArea(db, "SF Zone B");
      const proj = seedProject(db, {
        title: "SF Beta Proj",
        area,
        start: "active",
        startDate: "2026-07-05",
      });
      seedTodo(db, { title: "SF Task B1", project: proj, index: 0 });
      seedTodo(db, { title: "SF Task B2", project: proj, index: 1 });
      return {
        params: { uuid: proj, frequency: "weekly", interval: 1, afterCompletion: true },
        opts: GUI,
      };
    },
  },
  {
    id: "project-make-repeating-nested-flatten",
    op: "project.make-repeating",
    family: "subtree",
    title:
      "project.make-repeating FIXED with a NESTED repeater (RSIM-R flatten) — source PRESERVED, nested flattened",
    evidence: "RSIM-R flatten / RSIM-P2 A1 (docs/lab/rsim-results.md §RSIM-R)",
    seed(db) {
      const tag = seedTag(db, "SF GammaTag");
      const proj = seedProject(db, { title: "SF Gamma Proj", start: "someday" });
      const plain = seedTodo(db, { title: "SF Plain Task", project: proj, index: 0 });
      tagTask(db, plain, tag);
      const nestedTmpl = seedTodo(db, {
        title: "SF Nested Rep",
        project: proj,
        index: 1,
        start: "someday",
        recurrenceRule: true,
      });
      seedTodo(db, {
        title: "SF Nested Rep",
        project: proj,
        index: 2,
        startDate: "2026-07-05",
        repeatingTemplate: nestedTmpl,
      });
      return { params: { uuid: proj, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "project-make-repeating-terminal-children-preserve",
    op: "project.make-repeating",
    family: "subtree",
    title:
      "project.make-repeating FIXED with ALL-TERMINAL children (RSIM-U) — source PRESERVED, children ride along, only the template minted",
    evidence: "RSIM-U (docs/lab/rsim-results.md §RSIM-U)",
    seed(db) {
      // The SECOND fixed-project preserve trigger (RSIM-U: every child terminal —
      // no open child). Someday + area-less so the pure-AX drive can select it
      // (mirrors the nested-flatten case's UIC4-d constraint).
      const proj = seedProject(db, { title: "SF Delta Proj", start: "someday" });
      seedTodo(db, { title: "SF Done Child", project: proj, index: 0, status: "completed" });
      seedTodo(db, { title: "SF Canceled Child", project: proj, index: 1, status: "canceled" });
      return { params: { uuid: proj, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "project-make-repeating-trashed-child",
    op: "project.make-repeating",
    family: "subtree",
    title:
      "project.make-repeating FIXED with a pre-trashed child (RSIM-S S-R1) — trashed child hard-deleted, absent from copies",
    evidence: "RSIM-S S-R1 (docs/lab/rsim-results.md §RSIM-S)",
    seed(db) {
      const area = seedArea(db, "SF Zone SR");
      const proj = seedProject(db, { title: "SF SR Proj", area, start: "active" });
      seedTodo(db, { title: "SF SR Keep", project: proj, index: 0 });
      seedTodo(db, { title: "SF SR Gone", project: proj, index: 1, trashed: true });
      return { params: { uuid: proj, frequency: "weekly", interval: 1 }, opts: GUI };
    },
  },
  {
    id: "project-complete-instance-heading-cascade",
    op: "project.complete",
    family: "subtree",
    title:
      "project.complete an INSTANCE project (RSIM-P P2) — cascades to heading rows, promotes start 2→1",
    evidence: "RSIM-P P2 (docs/lab/rsim-results.md §RSIM-P)",
    seed(db) {
      const template = seedProject(db, {
        title: "SF Repeating Ops",
        start: "someday",
        recurrenceRule: true,
      });
      const instProj = seedProject(db, {
        title: "SF Repeating Ops",
        start: "someday",
        repeatingTemplate: template,
      });
      const head = seedHeading(db, { title: "SF Phase 1", project: instProj });
      seedTodo(db, { title: "SF Under Heading", heading: head });
      seedTodo(db, { title: "SF Direct Child", project: instProj });
      return { params: { uuid: instProj, children: "auto-complete" } };
    },
  },
];

// -------------------------------------------------- seeded rule blobs (for the
// pre-made template pre-states: RSIM4 completion + RSIM5 reschedule). These are
// the SHARED composer's output, so they decode with the real read-path decoder.

import { composeRepeatRuleSpec, ruleXml } from "../../src/write/recurrence-rule-blob.ts";

const RSIM_ANCHOR = "2026-07-05";

function fixedWeeklyRule(): string {
  return ruleXml(
    composeRepeatRuleSpec({ uuid: "x", frequency: "weekly", interval: 1 }, RSIM_ANCHOR, 0),
  );
}
function afterCompletionWeeklyRule(): string {
  return ruleXml(
    composeRepeatRuleSpec(
      { uuid: "x", frequency: "weekly", interval: 1, afterCompletion: true },
      RSIM_ANCHOR,
      0,
    ),
  );
}
