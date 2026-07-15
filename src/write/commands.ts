/**
 * CommandSpec catalog: for each operation — the hazards it must clear, the
 * pre-read it needs, the DeltaSpec that proves it happened, and the compiled
 * invocation per vector. Compilation emits exactly the command shapes the
 * lab validated (u-suite / a-suite evidence ids in the vector matrices).
 */
import type { DatabaseSync } from "node:sqlite";

import {
  decodeReminderTime,
  encodeReminderTime,
  reminderUrlToken,
  type IsoDate,
  type ReminderTime,
} from "../model/dates.ts";
import type { Todo } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
import type { HazardId } from "./guards.ts";
import type {
  ContainerRef,
  OperationKind,
  OperationParamsMap,
  RepeatFrequency,
  WhenValue,
} from "./operations.ts";
import {
  childTagTitles,
  computeReorderPre,
  emptyPreState,
  loadTarget,
  missingTagTitles,
  projectChildren,
  projectStatus,
  resolveArea,
  resolveHeading,
  resolveProject,
  resolveTag,
  trashedCount,
  type PreState,
} from "./pre-state.ts";
import { PRIVATE_REORDER_COMMAND } from "./experimental.ts";
import { escapeAppleScript } from "./vectors/applescript.ts";
import {
  convertToProjectRecipe,
  makeRepeatingRecipe,
  pauseRepeatRecipe,
  projectPauseRepeatRecipe,
  projectRescheduleRepeatRecipe,
  projectResumeRepeatRecipe,
  rescheduleRepeatRecipe,
  resumeRepeatRecipe,
} from "./vectors/ui-recipes.ts";
import type { CompiledInvocation, UiRecipe, VectorId } from "./vectors/types.ts";
import type { DeltaSpec, FieldAssertion } from "./verify/delta.ts";

export interface CompileCtx {
  token: string | null;
}

export interface DeltaCtx {
  /** Epoch seconds at execute time (create-probe window). */
  nowEpoch: number;
  /** Local calendar date (guest/host clock) for `when: today|evening`. */
  todayIso: IsoDate;
}

export interface CommandSpec<K extends OperationKind = OperationKind> {
  op: K;
  hazards: HazardId[];
  preRead(db: DatabaseSync, params: OperationParamsMap[K], now: Date): PreState;
  expectedDelta(pre: PreState, params: OperationParamsMap[K], ctx: DeltaCtx): DeltaSpec;
  compile(
    params: OperationParamsMap[K],
    vector: VectorId,
    pre: PreState,
    ctx: CompileCtx,
  ): CompiledInvocation;
}

// ------------------------------------------------------------------ helpers

function thingsUrl(
  command: string,
  params: Record<string, string | undefined>,
  token: string | null,
): CompiledInvocation {
  const parts: string[] = [];
  const redactedParts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${key}=${encodeURIComponent(value)}`);
    redactedParts.push(`${key}=${encodeURIComponent(value)}`);
  }
  if (token !== null) {
    parts.push(`auth-token=${encodeURIComponent(token)}`);
    redactedParts.push("auth-token=REDACTED");
  }
  return {
    vector: "url-scheme",
    kind: "open-url",
    payload: `things:///${command}?${parts.join("&")}`,
    redactedPayload: `things:///${command}?${redactedParts.join("&")}`,
  };
}

function osa(script: string): CompiledInvocation {
  const payload = `tell application "Things3" to ${script}`;
  return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
}

/**
 * A `shortcuts run <name>` invocation. The input dict is piped to the proxy
 * as JSON (no secrets — the auth token is never sent to a shortcut), so the
 * redacted rendering equals the payload. Key names come verbatim from the
 * proxy input contracts in docs/lab/s-campaign-results.md.
 */
function shortcutsRun(shortcut: string, input: Record<string, unknown>): CompiledInvocation {
  const rendered = `shortcuts run ${shortcut} <- ${JSON.stringify(input)}`;
  return {
    vector: "shortcuts",
    kind: "shortcuts-run",
    payload: rendered,
    redactedPayload: rendered,
    shortcut,
    input,
  };
}

/** Multi-statement `tell` block (one osascript invocation, several events). */
function osaBlock(statements: string[]): CompiledInvocation {
  const payload = `tell application "Things3"\n  ${statements.join("\n  ")}\nend tell`;
  return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
}

function q(value: string): string {
  return `"${escapeAppleScript(value)}"`;
}

function unsupportedVector(op: string, vector: VectorId): never {
  throw new Error(`${op} cannot be compiled for vector ${vector} (planner bug)`);
}

function whenAssertions(when: WhenValue, todayIso: IsoDate): FieldAssertion[] {
  // Strict shape check: an unvalidated string used to flow straight into the
  // URL (e.g. "2026-07-20@09:30", the raw URL grammar) — the app would SET
  // date+reminder while verification asserted the literal string as the date,
  // reporting a false mismatch on a write that succeeded.
  if (
    when !== "today" &&
    when !== "evening" &&
    when !== "anytime" &&
    when !== "someday" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(when)
  ) {
    throw new RangeError(
      when.includes("@")
        ? `invalid when "${when}" — a reminder time is a separate parameter (reminder: "HH:mm"; CLI --reminder), not an @ suffix`
        : `invalid when "${when}" — expected today | evening | anytime | someday | YYYY-MM-DD`,
    );
  }
  switch (when) {
    case "today":
      return [
        { field: "start", equals: "active" },
        { field: "startDate", equals: todayIso },
        { field: "todaySection", equals: "today" },
      ];
    case "evening":
      return [
        { field: "start", equals: "active" },
        { field: "startDate", equals: todayIso },
        { field: "todaySection", equals: "evening" },
      ];
    case "anytime":
      return [
        { field: "start", equals: "active" },
        { field: "startDate", equals: null },
      ];
    case "someday":
      return [{ field: "start", equals: "someday" }];
    default:
      // Concrete date: assert only the date — start-state semantics differ
      // for past/today/future dates (only the date itself is invariant).
      return [{ field: "startDate", equals: when }];
  }
}

function sortedTags(tags: string[]): string[] {
  return [...tags].toSorted();
}

/** Round-trip normalization: "6:5"-style inputs → canonical "06:05". */
function normalizeReminder(time: ReminderTime): ReminderTime {
  return decodeReminderTime(encodeReminderTime(time)) ?? time;
}

/**
 * The URL `when` value with an optional reminder token appended through the
 * deterministic emitter (never a bare 1–11 hour — oddity 2d).
 */
function whenWithReminder(when: WhenValue, reminder: ReminderTime | null | undefined): string {
  if (reminder === undefined || reminder === null) return when;
  return `${when}@${reminderUrlToken(reminder)}`;
}

function containerGiven(ref: ContainerRef | undefined): boolean {
  return ref !== undefined && (ref.uuid !== undefined || ref.title !== undefined);
}

// ----------------------------------------------------------------- commands

const todoAdd: CommandSpec<"todo.add"> = {
  op: "todo.add",
  hazards: [
    "H-UNKNOWN-TAG",
    "H-UNKNOWN-DESTINATION",
    "H-AMBIGUOUS-HEADING",
    "H-REOPEN-RESOLVED-PROJECT",
    "H-REMINDER-SCOPE",
  ],
  preRead(db, params) {
    const pre = emptyPreState();
    if (containerGiven(params.project)) {
      pre.destProject = resolveProject(db, params.project as ContainerRef);
      if (pre.destProject.resolved !== null) {
        pre.destProjectStatus = projectStatus(db, pre.destProject.resolved.uuid);
        if (params.heading !== undefined) {
          pre.destHeading = resolveHeading(db, pre.destProject.resolved.uuid, params.heading);
        }
      }
    }
    if (containerGiven(params.area)) pre.destArea = resolveArea(db, params.area as ContainerRef);
    if (params.tags !== undefined) pre.missingTags = missingTagTitles(db, params.tags);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    if (params.when !== undefined) assert.push(...whenAssertions(params.when, ctx.todayIso));
    if (params.reminder !== undefined) {
      assert.push({ field: "reminder", equals: normalizeReminder(params.reminder) });
    }
    if (params.deadline !== undefined) assert.push({ field: "deadline", equals: params.deadline });
    if (params.tags !== undefined) assert.push({ field: "tags", equals: sortedTags(params.tags) });
    if (params.checklistItems !== undefined) {
      assert.push({ field: "checklistTitles", equals: params.checklistItems });
    }
    const heading = pre.destHeading?.resolved;
    const project = pre.destProject?.resolved;
    if (heading !== undefined && heading !== null) {
      assert.push({ field: "heading.uuid", equals: heading.uuid });
    } else if (project !== undefined && project !== null) {
      assert.push({ field: "project.uuid", equals: project.uuid });
    }
    const area = pre.destArea?.resolved;
    if (area !== undefined && area !== null) assert.push({ field: "area.uuid", equals: area.uuid });
    return {
      mode: "create",
      probe: { title: params.title, type: "to-do", sinceEpoch: ctx.nowEpoch - 2 },
      assert,
    };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    const container = pre.destProject?.resolved ?? pre.destArea?.resolved;
    return thingsUrl(
      "add",
      {
        title: params.title,
        notes: params.notes,
        when:
          params.when === undefined ? undefined : whenWithReminder(params.when, params.reminder),
        deadline: params.deadline,
        tags: params.tags?.join(","),
        "checklist-items": params.checklistItems?.join("\n"),
        "list-id": container?.uuid,
        heading: pre.destHeading?.resolved?.title,
      },
      ctx.token,
    );
  },
};

/**
 * The effective reminder a when-bearing update should leave behind. A bare
 * `when=` CLEARS an existing reminder (R07/R20), so when the caller
 * re-schedules to today/evening/a date without addressing the reminder we
 * auto-preserve the current one; an explicit null is the intentional clear.
 */
function effectiveReminder(
  pre: PreState,
  params: { when?: WhenValue; reminder?: ReminderTime | null },
): ReminderTime | null {
  if (params.reminder !== undefined) return params.reminder;
  const when = params.when;
  const schedulable =
    when === "today" ||
    when === "evening" ||
    (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when));
  if (!schedulable) return null;
  const target = pre.target;
  if (target === null || target.type === "heading") return null;
  return target.reminder;
}

function assertNotesModesExclusive(params: {
  notes?: string;
  appendNotes?: string;
  prependNotes?: string;
}): void {
  if (
    params.notes !== undefined &&
    (params.appendNotes !== undefined || params.prependNotes !== undefined)
  ) {
    throw new RangeError("notes (replace) is exclusive with appendNotes/prependNotes");
  }
  if (params.appendNotes !== undefined && params.prependNotes !== undefined) {
    throw new RangeError("appendNotes and prependNotes cannot be combined in one update");
  }
}

function expectedNotes(pre: PreState, params: { appendNotes?: string; prependNotes?: string }) {
  const current = pre.target !== null && pre.target.type !== "heading" ? pre.target.notes : "";
  // Separator semantics probed: newline-joined, no stray newline against an
  // empty note (E04/E05/E11/E12).
  if (params.appendNotes !== undefined) {
    return current === "" ? params.appendNotes : `${current}\n${params.appendNotes}`;
  }
  if (params.prependNotes !== undefined) {
    return current === "" ? params.prependNotes : `${params.prependNotes}\n${current}`;
  }
  return undefined;
}

const todoUpdate: CommandSpec<"todo.update"> = {
  op: "todo.update",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE", "H-REMINDER-SCOPE"],
  preRead(db, params) {
    assertNotesModesExclusive(params);
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    const joined = expectedNotes(pre, params);
    if (joined !== undefined) assert.push({ field: "notes", equals: joined });
    if (params.when !== undefined) {
      assert.push(...whenAssertions(params.when, ctx.todayIso));
      const reminder = effectiveReminder(pre, params);
      assert.push({
        field: "reminder",
        equals: reminder === null ? null : normalizeReminder(reminder),
      });
    }
    if (params.deadline !== undefined) assert.push({ field: "deadline", equals: params.deadline });
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl(
      "update",
      {
        id: params.uuid,
        title: params.title,
        notes: params.notes,
        "append-notes": params.appendNotes,
        "prepend-notes": params.prependNotes,
        when:
          params.when === undefined
            ? undefined
            : whenWithReminder(params.when, effectiveReminder(pre, params)),
        deadline: params.deadline === null ? "" : params.deadline,
      },
      ctx.token,
    );
  },
};

function statusSpec<K extends "todo.complete" | "todo.cancel" | "todo.reopen">(
  op: K,
  urlParam: Record<string, string>,
  asStatus: "completed" | "canceled" | "open",
  scriptStatus: string,
): CommandSpec<K> {
  return {
    op,
    hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
    preRead(db, params) {
      const pre = emptyPreState();
      pre.target = loadTarget(db, params.uuid);
      return pre;
    },
    expectedDelta(_pre, params) {
      return { mode: "state", uuid: params.uuid, assert: [{ field: "status", equals: asStatus }] };
    },
    compile(params, vector, _pre, ctx) {
      if (vector === "url-scheme") {
        return thingsUrl("update", { id: params.uuid, ...urlParam }, ctx.token);
      }
      return osa(`set status of to do id ${q(params.uuid)} to ${scriptStatus}`);
    },
  };
}

const todoComplete = statusSpec("todo.complete", { completed: "true" }, "completed", "completed");
const todoCancel = statusSpec("todo.cancel", { canceled: "true" }, "canceled", "canceled");
const todoReopen = statusSpec("todo.reopen", { completed: "false" }, "open", "open");

const todoMove: CommandSpec<"todo.move"> = {
  op: "todo.move",
  hazards: [
    "H-UNKNOWN-DESTINATION",
    "H-AMBIGUOUS-HEADING",
    "H-REOPEN-RESOLVED-PROJECT",
    "H-REPEAT-SCHEDULE",
  ],
  preRead(db, params) {
    const container =
      containerGiven(params.project) || containerGiven(params.area) || params.heading !== undefined;
    if (params.inbox === true && (container || params.detach === true)) {
      throw new RangeError("inbox is exclusive with project/area/heading/detach");
    }
    if (params.detach === true && container) {
      throw new RangeError("detach is exclusive with project/area/heading destinations");
    }
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    if (containerGiven(params.project)) {
      pre.destProject = resolveProject(db, params.project as ContainerRef);
      if (pre.destProject.resolved !== null) {
        pre.destProjectStatus = projectStatus(db, pre.destProject.resolved.uuid);
        if (params.heading !== undefined) {
          pre.destHeading = resolveHeading(db, pre.destProject.resolved.uuid, params.heading);
        }
      }
    }
    if (containerGiven(params.area)) pre.destArea = resolveArea(db, params.area as ContainerRef);
    return pre;
  },
  expectedDelta(pre, params) {
    const assert: FieldAssertion[] = [];
    if (params.inbox === true) {
      // De-schedules cleanly (E06): back to the Inbox bucket, no start date.
      assert.push({ field: "start", equals: "inbox" }, { field: "startDate", equals: null });
      return { mode: "update", uuid: params.uuid, assert };
    }
    if (params.detach === true) {
      // P21/P22: empty list-id strips every container link; the schedule is
      // untouched (pin it — a silent de-schedule would be a contrary write).
      const target = pre.target;
      const startDate =
        target !== null && target.type !== "heading" ? (target.startDate ?? null) : null;
      assert.push(
        { field: "project", equals: null },
        { field: "area", equals: null },
        { field: "heading", equals: null },
        { field: "startDate", equals: startDate },
      );
      return { mode: "update", uuid: params.uuid, assert };
    }
    const heading = pre.destHeading?.resolved;
    const project = pre.destProject?.resolved;
    const area = pre.destArea?.resolved;
    if (heading !== undefined && heading !== null) {
      assert.push({ field: "heading.uuid", equals: heading.uuid });
    } else if (project !== undefined && project !== null) {
      assert.push({ field: "project.uuid", equals: project.uuid });
    }
    if (area !== undefined && area !== null) {
      assert.push({ field: "area.uuid", equals: area.uuid });
      // Validated (A22B): assigning an area clears any project link.
      assert.push({ field: "project", equals: null });
    }
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector, pre, ctx) {
    if (params.inbox === true) {
      if (vector !== "applescript") unsupportedVector(this.op, vector);
      return osa(`move to do id ${q(params.uuid)} to list "Inbox"`);
    }
    if (params.detach === true) {
      // Empty list-id = clear the container (P21/P22) — URL only; the other
      // vectors reject or silently ignore container removal (P10/P11, P26).
      if (vector !== "url-scheme") unsupportedVector(this.op, vector);
      return thingsUrl("update", { id: params.uuid, "list-id": "" }, ctx.token);
    }
    const project = pre.destProject?.resolved;
    const area = pre.destArea?.resolved;
    if (vector === "url-scheme") {
      return thingsUrl(
        "update",
        {
          id: params.uuid,
          "list-id": (project ?? area)?.uuid,
          heading: pre.destHeading?.resolved?.title,
        },
        ctx.token,
      );
    }
    if (project !== undefined && project !== null) {
      return osa(`set project of to do id ${q(params.uuid)} to project id ${q(project.uuid)}`);
    }
    if (area !== undefined && area !== null) {
      return osa(`set area of to do id ${q(params.uuid)} to area id ${q(area.uuid)}`);
    }
    unsupportedVector(this.op, vector);
  },
};

const todoSetTags: CommandSpec<"todo.set-tags"> = {
  op: "todo.set-tags",
  hazards: ["H-UNKNOWN-DESTINATION", "H-UNKNOWN-TAG"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    pre.missingTags = missingTagTitles(db, params.tags);
    return pre;
  },
  expectedDelta(_pre, params) {
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "tags", equals: sortedTags(params.tags) }],
    };
  },
  compile(params, vector, _pre, ctx) {
    if (vector === "url-scheme") {
      return thingsUrl("update", { id: params.uuid, tags: params.tags.join(",") }, ctx.token);
    }
    return osa(`set tag names of to do id ${q(params.uuid)} to ${q(params.tags.join(", "))}`);
  },
};

/** Normalize the string | spec union; decide whether states force the json form. */
function checklistSpecs(items: (string | { title: string; completed?: boolean })[]): {
  specs: { title: string; completed: boolean }[];
  needsJson: boolean;
} {
  const specs = items.map((i) =>
    typeof i === "string"
      ? { title: i, completed: false }
      : { title: i.title, completed: i.completed === true },
  );
  const needsJson = items.some((i) => typeof i !== "string" && i.completed !== undefined);
  return { specs, needsJson };
}

const todoReplaceChecklist: CommandSpec<"todo.replace-checklist"> = {
  op: "todo.replace-checklist",
  hazards: ["H-UNKNOWN-DESTINATION", "H-CHECKLIST-REPLACE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    if (pre.target !== null && pre.target.type === "to-do") {
      pre.checklistCount = pre.target.checklist?.length ?? 0;
    }
    return pre;
  },
  expectedDelta(_pre, params) {
    const { specs } = checklistSpecs(params.items);
    // Always assert titles AND states: the non-json form recreates every item
    // OPEN (T07) and the json form honors per-item `completed` (P18), so the
    // resulting states are known either way. Asserting them (a) strengthens
    // verification and (b) records the ordered states into `pre`/`observed`,
    // which the wholesale undo needs to restore states and to precondition on.
    const assert: FieldAssertion[] = [
      { field: "checklistTitles", equals: specs.map((s) => s.title) },
      { field: "checklistStates", equals: specs.map((s) => (s.completed ? "completed" : "open")) },
    ];
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    const { specs, needsJson } = checklistSpecs(params.items);
    if (!needsJson) {
      return thingsUrl(
        "update",
        { id: params.uuid, "checklist-items": specs.map((s) => s.title).join("\n") },
        ctx.token,
      );
    }
    // things:///json — the only surface that recreates items PRE-CHECKED
    // (P18). Items are replaced wholesale; their uuids are not stable.
    const payload = JSON.stringify([
      {
        type: "to-do",
        operation: "update",
        id: params.uuid,
        attributes: {
          "checklist-items": specs.map((s) => ({
            type: "checklist-item",
            attributes: { title: s.title, completed: s.completed },
          })),
        },
      },
    ]);
    return thingsUrl("json", { data: payload }, ctx.token);
  },
};

const ORCHESTRATED_ONLY =
  "todo.edit-checklist-item is delivered by the runEditChecklist orchestrator (a targeted " +
  "todo.replace-checklist rewrite that preserves every other item's state); it has no atomic " +
  "surface and is never dispatched directly through the pipeline";

const todoEditChecklistItem: CommandSpec<"todo.edit-checklist-item"> = {
  op: "todo.edit-checklist-item",
  hazards: [],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta() {
    throw new Error(ORCHESTRATED_ONLY);
  },
  compile() {
    throw new Error(ORCHESTRATED_ONLY);
  },
};

const todoDelete: CommandSpec<"todo.delete"> = {
  op: "todo.delete",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    return { mode: "update", uuid: params.uuid, assert: [{ field: "trashed", equals: true }] };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`delete to do id ${q(params.uuid)}`);
  },
};

const projectAdd: CommandSpec<"project.add"> = {
  op: "project.add",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    if (containerGiven(params.area)) pre.destArea = resolveArea(db, params.area as ContainerRef);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    if (params.when !== undefined) assert.push(...whenAssertions(params.when, ctx.todayIso));
    if (params.deadline !== undefined) assert.push({ field: "deadline", equals: params.deadline });
    const area = pre.destArea?.resolved;
    if (area !== undefined && area !== null) assert.push({ field: "area.uuid", equals: area.uuid });
    return {
      mode: "create",
      probe: { title: params.title, type: "project", sinceEpoch: ctx.nowEpoch - 2 },
      assert,
    };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl(
      "add-project",
      {
        title: params.title,
        notes: params.notes,
        when: params.when,
        deadline: params.deadline,
        "area-id": pre.destArea?.resolved?.uuid,
        "to-dos": params.todos?.join("\n"),
      },
      ctx.token,
    );
  },
};

const projectUpdate: CommandSpec<"project.update"> = {
  op: "project.update",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE", "H-REMINDER-SCOPE"],
  preRead(db, params) {
    assertNotesModesExclusive(params);
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    const joined = expectedNotes(pre, params);
    if (joined !== undefined) assert.push({ field: "notes", equals: joined });
    if (params.when !== undefined) {
      assert.push(...whenAssertions(params.when, ctx.todayIso));
      // Projects carry the same reminderTime codec as to-dos (A3); a bare
      // when= clears an existing reminder unless auto-preserved.
      const reminder = effectiveReminder(pre, params);
      assert.push({
        field: "reminder",
        equals: reminder === null ? null : normalizeReminder(reminder),
      });
    }
    if (params.deadline !== undefined) assert.push({ field: "deadline", equals: params.deadline });
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl(
      "update-project",
      {
        id: params.uuid,
        title: params.title,
        notes: params.notes,
        "append-notes": params.appendNotes,
        "prepend-notes": params.prependNotes,
        when:
          params.when === undefined
            ? undefined
            : whenWithReminder(params.when, effectiveReminder(pre, params)),
        deadline: params.deadline === null ? "" : params.deadline,
      },
      ctx.token,
    );
  },
};

const projectSetTags: CommandSpec<"project.set-tags"> = {
  op: "project.set-tags",
  hazards: ["H-UNKNOWN-DESTINATION", "H-UNKNOWN-TAG"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    pre.missingTags = missingTagTitles(db, params.tags);
    return pre;
  },
  expectedDelta(_pre, params) {
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "tags", equals: sortedTags(params.tags) }],
    };
  },
  compile(params, vector, _pre, ctx) {
    // Both vectors validated on projects (A1 URL, A2 AppleScript). Full
    // replacement semantics mirror todo.set-tags; unknown tags are guarded
    // pre-write (the app silently drops them).
    if (vector === "url-scheme") {
      return thingsUrl(
        "update-project",
        { id: params.uuid, tags: params.tags.join(",") },
        ctx.token,
      );
    }
    return osa(`set tag names of project id ${q(params.uuid)} to ${q(params.tags.join(", "))}`);
  },
};

const projectMove: CommandSpec<"project.move"> = {
  op: "project.move",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    if ((params.detach === true) === containerGiven(params.area)) {
      throw new RangeError("project.move needs exactly one of area / detach");
    }
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    if (containerGiven(params.area)) pre.destArea = resolveArea(db, params.area as ContainerRef);
    return pre;
  },
  expectedDelta(pre, params) {
    // Area (re/un-)assignment only (E14/P23/P24): status/start/schedule
    // untouched by the app — the delta pins the new area link.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [
        params.detach === true
          ? { field: "area", equals: null }
          : { field: "area.uuid", equals: pre.destArea?.resolved?.uuid ?? "" },
      ],
    };
  },
  compile(params, vector, pre, ctx) {
    if (vector === "url-scheme") {
      // P23 (move) / P24 (empty area-id = detach — URL is the ONLY detach
      // surface: AppleScript rejects missing value/"" and json-null no-ops).
      return thingsUrl(
        "update-project",
        {
          id: params.uuid,
          "area-id": params.detach === true ? "" : (pre.destArea?.resolved?.uuid ?? ""),
        },
        ctx.token,
      );
    }
    if (params.detach === true) unsupportedVector(this.op, vector);
    return osa(
      `set area of project id ${q(params.uuid)} to area id ` +
        q(pre.destArea?.resolved?.uuid ?? ""),
    );
  },
};

const todoRestore: CommandSpec<"todo.restore"> = {
  op: "todo.restore",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // The UI's "Put Back", scripted (E15): the item un-trashes into the
    // Inbox, de-scheduled. Prior list/schedule are NOT restored.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [
        { field: "trashed", equals: false },
        { field: "start", equals: "inbox" },
      ],
    };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`move to do id ${q(params.uuid)} to list "Inbox"`);
  },
};

const projectDuplicate: CommandSpec<"project.duplicate"> = {
  op: "project.duplicate",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // E17: the copy carries the title, notes AND children; discover it with
    // the create probe (fresh creationDate, same as the to-do path E07).
    const target = pre.target;
    const title = target !== null && target.type !== "heading" ? target.title : "";
    const notes = target !== null && target.type !== "heading" ? target.notes : "";
    return {
      mode: "create",
      probe: { title, type: "project", sinceEpoch: ctx.nowEpoch - 2 },
      assert: [{ field: "notes", equals: notes }],
    };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl("update-project", { id: params.uuid, duplicate: "true" }, ctx.token);
  },
};

const projectComplete: CommandSpec<"project.complete"> = {
  op: "project.complete",
  hazards: ["H-UNKNOWN-DESTINATION", "H-PROJECT-COMPLETE-CHILDREN"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    if (pre.target !== null && pre.target.type === "project") {
      const children = projectChildren(db, params.uuid);
      pre.openChildren = children.filter((c) => c.status === "open");
      pre.canceledChildren = children.filter((c) => c.status === "canceled");
    }
    return pre;
  },
  expectedDelta(pre, params) {
    // Cascade semantics validated by T08/U08: open children auto-complete,
    // canceled children stay canceled — verified, not assumed.
    const cascade = [
      ...pre.openChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: "completed" }],
      })),
      ...pre.canceledChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: "canceled" }],
      })),
    ];
    return {
      mode: "state",
      uuid: params.uuid,
      assert: [{ field: "status", equals: "completed" }],
      ...(cascade.length > 0 && { cascade }),
    };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl("update-project", { id: params.uuid, completed: "true" }, ctx.token);
  },
};

const projectCancel: CommandSpec<"project.cancel"> = {
  op: "project.cancel",
  hazards: ["H-UNKNOWN-DESTINATION", "H-PROJECT-COMPLETE-CHILDREN"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    if (pre.target !== null && pre.target.type === "project") {
      const children = projectChildren(db, params.uuid);
      pre.openChildren = children.filter((c) => c.status === "open");
      pre.completedChildren = children.filter((c) => c.status === "completed");
    }
    return pre;
  },
  expectedDelta(pre, params) {
    // Cancel cascade validated by P01: open children auto-cancel, completed
    // children keep their status AND stopDate — verified, not assumed.
    const cascade = [
      ...pre.openChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: "canceled" }],
      })),
      ...pre.completedChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: "completed" }],
      })),
    ];
    return {
      mode: "state",
      uuid: params.uuid,
      assert: [{ field: "status", equals: "canceled" }],
      ...(cascade.length > 0 && { cascade }),
    };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl("update-project", { id: params.uuid, canceled: "true" }, ctx.token);
  },
};

const projectReopen: CommandSpec<"project.reopen"> = {
  op: "project.reopen",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Reopens ONLY the project row (P02/P05): cascade-resolved children
    // stay resolved — restoring them is a separate, explicit concern
    // (client restoreChildren / undo's audit-exact replay).
    return { mode: "state", uuid: params.uuid, assert: [{ field: "status", equals: "open" }] };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    // The pre status picks the parameter: completed=false vs canceled=false
    // (each only reverses its own status — P02/P05).
    const wasCanceled =
      pre.target !== null && pre.target.type !== "heading" && pre.target.status === "canceled";
    return thingsUrl(
      "update-project",
      { id: params.uuid, ...(wasCanceled ? { canceled: "false" } : { completed: "false" }) },
      ctx.token,
    );
  },
};

const projectRestore: CommandSpec<"project.restore"> = {
  op: "project.restore",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // P06: the Anytime list-move on a trashed project flips trashed IN
    // PLACE — schedule, area link, and children all keep their state
    // (better than the to-do restore, which relocates to the Inbox).
    return { mode: "update", uuid: params.uuid, assert: [{ field: "trashed", equals: false }] };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`move project id ${q(params.uuid)} to list "Anytime"`);
  },
};

const projectDelete: CommandSpec<"project.delete"> = {
  op: "project.delete",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Shallow by design (A24B): only the project row flips trashed=1;
    // children keep their links (derived Trash membership).
    return { mode: "update", uuid: params.uuid, assert: [{ field: "trashed", equals: true }] };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`delete project id ${q(params.uuid)}`);
  },
};

const areaAdd: CommandSpec<"area.add"> = {
  op: "area.add",
  hazards: ["H-UNKNOWN-TAG"],
  preRead(db, params) {
    const pre = emptyPreState();
    if (params.tags !== undefined) pre.missingTags = missingTagTitles(db, params.tags);
    pre.existingEntityUuids = (
      db.prepare("SELECT uuid FROM TMArea WHERE title = ? COLLATE NOCASE").all(params.title) as {
        uuid: string;
      }[]
    ).map((r) => r.uuid);
    return pre;
  },
  expectedDelta(pre, params) {
    return {
      mode: "entity-created",
      entity: "area",
      title: params.title,
      excludeUuids: pre.existingEntityUuids,
    };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const make = `make new area with properties {name:${q(params.title)}}`;
    if (params.tags === undefined || params.tags.length === 0) return osa(make);
    const payload =
      `tell application "Things3"\n` +
      `  ${make}\n` +
      `  set tag names of area ${q(params.title)} to ${q(params.tags.join(", "))}\n` +
      `end tell`;
    return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
  },
};

const areaDelete: CommandSpec<"area.delete"> = {
  op: "area.delete",
  hazards: ["H-UNKNOWN-DESTINATION", "H-PERMANENT-DELETE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.entityTarget = resolveArea(db, { title: params.target, uuid: params.target });
    return pre;
  },
  expectedDelta(pre) {
    const uuid = pre.entityTarget?.resolved?.uuid ?? "";
    return { mode: "gone", entity: "area", uuid };
  },
  compile(_params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`delete area id ${q(pre.entityTarget?.resolved?.uuid ?? "")}`);
  },
};

const tagAdd: CommandSpec<"tag.add"> = {
  op: "tag.add",
  hazards: ["H-UNKNOWN-TAG"],
  preRead(db, params) {
    const pre = emptyPreState();
    if (params.parent !== undefined) {
      pre.parentTag = resolveTag(db, params.parent);
      if (pre.parentTag.resolved === null) pre.missingTags = [params.parent];
    }
    pre.existingEntityUuids = (
      db.prepare("SELECT uuid FROM TMTag WHERE title = ? COLLATE NOCASE").all(params.title) as {
        uuid: string;
      }[]
    ).map((r) => r.uuid);
    return pre;
  },
  expectedDelta(pre, params) {
    return {
      mode: "entity-created",
      entity: "tag",
      title: params.title,
      excludeUuids: pre.existingEntityUuids,
      parentUuid: pre.parentTag?.resolved?.uuid ?? null,
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const make = `make new tag with properties {name:${q(params.title)}}`;
    const parent = pre.parentTag?.resolved;
    if (parent === undefined || parent === null) return osa(make);
    const payload =
      `tell application "Things3"\n` +
      `  ${make}\n` +
      `  set parent tag of tag ${q(params.title)} to tag ${q(parent.title)}\n` +
      `end tell`;
    return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
  },
};

const tagDelete: CommandSpec<"tag.delete"> = {
  op: "tag.delete",
  hazards: ["H-UNKNOWN-DESTINATION", "H-PERMANENT-DELETE", "H-TAG-SUBTREE-DELETE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.entityTarget = resolveTag(db, params.target);
    if (pre.entityTarget.resolved !== null) {
      pre.childTags = childTagTitles(db, pre.entityTarget.resolved.uuid);
    }
    return pre;
  },
  expectedDelta(pre) {
    return { mode: "gone", entity: "tag", uuid: pre.entityTarget?.resolved?.uuid ?? "" };
  },
  compile(_params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`delete tag id ${q(pre.entityTarget?.resolved?.uuid ?? "")}`);
  },
};

const todoDuplicate: CommandSpec<"todo.duplicate"> = {
  op: "todo.duplicate",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // The copy carries the same title/notes with a fresh uuid + creationDate
    // (E07) — discover it with the create probe, assert copy fidelity.
    const target = pre.target;
    const title = target !== null && target.type !== "heading" ? target.title : "";
    const notes = target !== null && target.type !== "heading" ? target.notes : "";
    return {
      mode: "create",
      probe: { title, type: "to-do", sinceEpoch: ctx.nowEpoch - 2 },
      assert: [{ field: "notes", equals: notes }],
    };
  },
  compile(params, vector, _pre, ctx) {
    // AppleScript refuses duplication outright ("can not be copied", E08).
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl("update", { id: params.uuid, duplicate: "true" }, ctx.token);
  },
};

const areaUpdate: CommandSpec<"area.update"> = {
  op: "area.update",
  hazards: ["H-UNKNOWN-DESTINATION", "H-UNKNOWN-TAG"],
  preRead(db, params) {
    if (params.title === undefined && params.tags === undefined) {
      throw new RangeError("area.update needs title and/or tags");
    }
    const pre = emptyPreState();
    pre.entityTarget = resolveArea(db, { title: params.target, uuid: params.target });
    if (params.tags !== undefined) pre.missingTags = missingTagTitles(db, params.tags);
    return pre;
  },
  expectedDelta(pre, params) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.tags !== undefined) assert.push({ field: "tags", equals: sortedTags(params.tags) });
    return {
      mode: "entity-updated",
      entity: "area",
      uuid: pre.entityTarget?.resolved?.uuid ?? "",
      assert,
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const id = q(pre.entityTarget?.resolved?.uuid ?? "");
    const lines: string[] = [];
    if (params.title !== undefined) lines.push(`set name of area id ${id} to ${q(params.title)}`);
    if (params.tags !== undefined) {
      lines.push(`set tag names of area id ${id} to ${q(params.tags.join(", "))}`);
    }
    if (lines.length === 1) return osa(lines[0] as string);
    const payload = `tell application "Things3"\n${lines.map((l) => `  ${l}`).join("\n")}\nend tell`;
    return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
  },
};

const tagUpdate: CommandSpec<"tag.update"> = {
  op: "tag.update",
  hazards: ["H-UNKNOWN-DESTINATION", "H-UNKNOWN-TAG"],
  preRead(db, params) {
    if (
      params.title === undefined &&
      params.parent === undefined &&
      params.unnest === undefined &&
      params.shortcut === undefined &&
      params.clearShortcut === undefined
    ) {
      throw new RangeError(
        "tag.update needs title, parent, unnest, shortcut, and/or clearShortcut",
      );
    }
    if (params.parent !== undefined && params.unnest === true) {
      throw new RangeError("parent and unnest are exclusive");
    }
    if (params.shortcut !== undefined && params.clearShortcut === true) {
      throw new RangeError("shortcut and clearShortcut are exclusive");
    }
    const pre = emptyPreState();
    pre.entityTarget = resolveTag(db, params.target);
    if (params.parent !== undefined) {
      pre.parentTag = resolveTag(db, params.parent);
      if (pre.parentTag.resolved === null) pre.missingTags = [params.parent];
    }
    return pre;
  },
  expectedDelta(pre, params) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.parent !== undefined) {
      assert.push({ field: "parent", equals: pre.parentTag?.resolved?.uuid ?? "" });
    }
    if (params.unnest === true) assert.push({ field: "parent", equals: null });
    if (params.shortcut !== undefined) assert.push({ field: "shortcut", equals: params.shortcut });
    if (params.clearShortcut === true) assert.push({ field: "shortcut", equals: null });
    return {
      mode: "entity-updated",
      entity: "tag",
      uuid: pre.entityTarget?.resolved?.uuid ?? "",
      assert,
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const id = q(pre.entityTarget?.resolved?.uuid ?? "");
    const lines: string[] = [];
    if (params.title !== undefined) lines.push(`set name of tag id ${id} to ${q(params.title)}`);
    if (params.parent !== undefined) {
      lines.push(
        `set parent tag of tag id ${id} to tag id ${q(pre.parentTag?.resolved?.uuid ?? "")}`,
      );
    }
    if (params.unnest === true) {
      // The property-DELETE form is the only working un-nest spelling (P29):
      // `set parent tag … to missing value` errors (E19). By NAME, exactly
      // as probed — resolveTag already guaranteed the title is unique.
      lines.push(`delete parent tag of tag ${q(pre.entityTarget?.resolved?.title ?? "")}`);
    }
    if (params.shortcut !== undefined) {
      lines.push(`set keyboard shortcut of tag id ${id} to ${q(params.shortcut)}`);
    }
    if (params.clearShortcut === true) {
      // The property-DELETE form clears the shortcut (A4 — the P29 un-nest
      // spelling generalizes to `shortcut`; `set … to ""`/missing value has
      // no validated clear path). By NAME, exactly as probed.
      lines.push(`delete keyboard shortcut of tag ${q(pre.entityTarget?.resolved?.title ?? "")}`);
    }
    if (lines.length === 1) return osa(lines[0] as string);
    const payload = `tell application "Things3"\n${lines.map((l) => `  ${l}`).join("\n")}\nend tell`;
    return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
  },
};

const reorder: CommandSpec<"reorder"> = {
  op: "reorder",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REORDER-SCOPE"],
  preRead(db, params, now) {
    const pre = emptyPreState();
    let containerUuid: string | null = null;
    if (params.scope === "project" || params.scope === "headings") {
      pre.destProject = resolveProject(db, params.container ?? {});
      containerUuid = pre.destProject.resolved?.uuid ?? null;
    }
    if (params.scope === "area") {
      pre.destArea = resolveArea(db, params.container ?? {});
      containerUuid = pre.destArea.resolved?.uuid ?? null;
    }
    pre.reorder = computeReorderPre(db, params, containerUuid, now);
    return pre;
  },
  expectedDelta(pre, params) {
    // Verify the REQUESTED sequence (strictly ascending ranks). The wire
    // list pins the unrequested tail too, but the caller's contract is the
    // requested prefix; tail members are covered by pre-rank tripwires.
    return {
      mode: "ordering",
      key:
        pre.reorder?.key ??
        (params.scope === "today" || params.scope === "evening" ? "todayIndex" : "index"),
      sequence: params.uuids,
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const specifier =
      params.scope === "project" || params.scope === "headings"
        ? `project id ${q(pre.destProject?.resolved?.uuid ?? "")}`
        : params.scope === "area"
          ? `area id ${q(pre.destArea?.resolved?.uuid ?? "")}`
          : params.scope === "inbox"
            ? `list "Inbox"`
            : params.scope === "someday"
              ? `list "Someday"`
              : `list "Today"`;
    const wire = pre.reorder?.wireList ?? params.uuids;
    if (params.scope === "someday") {
      // The Someday handler STACKS each sent id above the list's current top
      // (the current top itself never moves), with OPPOSITE stack directions
      // by row type: to-dos ascend — later-sent higher (P6h/P7e/P8b) —
      // while projects DESCEND — earlier-sent higher (P9e, incl. a
      // predicted-failure control). Both use the same two-call protocol:
      // (1) push the desired BOTTOM item to the top, making it the anchor;
      // (2) anchor first, then the rest in the direction that stacks into
      // the desired order — reversed for to-dos (P8b: exact), FORWARD for
      // projects (P9e: exact ×2).
      const bottom = wire.at(-1) ?? "";
      const isProjects = pre.reorder?.projectMembers.length ?? 0;
      const call2 =
        isProjects > 0 ? [bottom, ...wire.slice(0, -1)].join(",") : wire.toReversed().join(",");
      return osaBlock([
        `${PRIVATE_REORDER_COMMAND} ${specifier} with ids ${q(bottom)}`,
        `${PRIVATE_REORDER_COMMAND} ${specifier} with ids ${q(call2)}`,
      ]);
    }
    return osa(`${PRIVATE_REORDER_COMMAND} ${specifier} with ids ${q(wire.join(","))}`);
  },
};

/** Locale-proof AppleScript date literal: local noon on an ISO date. */
function asDateBlock(varName: string, iso: string): string[] {
  const [y, m, d] = iso.split("-").map(Number);
  return [
    `set ${varName} to current date`,
    `set time of ${varName} to 12 * hours`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${y}`,
    `set month of ${varName} to ${m}`,
    `set day of ${varName} to ${d}`,
  ];
}

/**
 * Local noon -> UTC instant, so the stored timestamp decodes back to the
 * requested local DATE in every timezone (P4d: json attrs honored exactly).
 * WITHOUT milliseconds: the app's json date parser rejects fractional
 * seconds — a `.000Z` timestamp fails the whole command (error modal, no
 * write; caught live by the e2e 2026-07-09 — P4d's validated shape was
 * second-precision).
 */
function utcNoon(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 12, 0, 0).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const todoBackdate: CommandSpec<"todo.backdate"> = {
  op: "todo.backdate",
  hazards: ["H-UNKNOWN-DESTINATION", "H-BACKDATE-OPEN"],
  preRead(db, params) {
    if (params.completionDate === undefined && params.creationDate === undefined) {
      throw new RangeError("nothing to backdate: give completionDate and/or creationDate");
    }
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    const assert: FieldAssertion[] = [];
    if (params.completionDate !== undefined) {
      assert.push({ field: "stoppedDate", equals: params.completionDate });
    }
    if (params.creationDate !== undefined) {
      assert.push({ field: "createdDate", equals: params.creationDate });
    }
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const statements: string[] = [];
    if (params.completionDate !== undefined) {
      statements.push(
        ...asDateBlock("compDate", params.completionDate),
        `set completion date of to do id ${q(params.uuid)} to compDate`,
      );
    }
    if (params.creationDate !== undefined) {
      statements.push(
        ...asDateBlock("createDate", params.creationDate),
        `set creation date of to do id ${q(params.uuid)} to createDate`,
      );
    }
    return osaBlock(statements);
  },
};

const todoAddLogged: CommandSpec<"todo.add-logged"> = {
  op: "todo.add-logged",
  hazards: [],
  preRead(db, params) {
    if (
      params.creationDate !== undefined &&
      params.creationDate.localeCompare(params.completionDate) > 0
    ) {
      throw new RangeError("creationDate must not be after completionDate");
    }
    const pre = emptyPreState();
    pre.sameTitleUuids = (
      db.prepare("SELECT uuid FROM TMTask WHERE title = ? AND type = 0").all(params.title) as {
        uuid: string;
      }[]
    ).map((r) => r.uuid);
    return pre;
  },
  expectedDelta(pre, params) {
    const assert: FieldAssertion[] = [
      { field: "status", equals: "completed" },
      { field: "stoppedDate", equals: params.completionDate },
    ];
    if (params.creationDate !== undefined) {
      assert.push({ field: "createdDate", equals: params.creationDate });
    }
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    return {
      mode: "create",
      probe: {
        title: params.title,
        type: "to-do",
        sinceEpoch: 0,
        excludeUuids: pre.sameTitleUuids,
      },
      assert,
    };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    const payload = JSON.stringify([
      {
        type: "to-do",
        attributes: {
          title: params.title,
          ...(params.notes !== undefined && { notes: params.notes }),
          completed: true,
          "completion-date": utcNoon(params.completionDate),
          ...(params.creationDate !== undefined && {
            "creation-date": utcNoon(params.creationDate),
          }),
        },
      },
    ]);
    return thingsUrl("json", { data: payload }, ctx.token);
  },
};

/** Children of a heading (open ones drive the archive policies). */
function headingChildren(db: DatabaseSync, headingUuid: string): Todo[] {
  const rows = db
    .prepare("SELECT uuid FROM TMTask WHERE type = 0 AND trashed = 0 AND heading = ?")
    .all(headingUuid) as { uuid: string }[];
  const todos: Todo[] = [];
  for (const r of rows) {
    const t = byUuid(db, r.uuid);
    if (t !== null && t.type === "to-do") todos.push(t);
  }
  return todos;
}

const headingRename: CommandSpec<"heading.rename"> = {
  op: "heading.rename",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "title", equals: params.title }],
    };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    // Heading rows are invisible to AppleScript enumeration but fully
    // addressable by id (P10d — the oddity-5e pattern).
    return osa(`set name of to do id ${q(params.uuid)} to ${q(params.title)}`);
  },
};

const headingArchive: CommandSpec<"heading.archive"> = {
  op: "heading.archive",
  hazards: ["H-UNKNOWN-DESTINATION", "H-HEADING-CHILDREN"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    if (pre.target?.type === "heading") {
      const children = headingChildren(db, params.uuid);
      pre.openChildren = children.filter((c) => c.status === "open");
      pre.canceledChildren = children.filter((c) => c.status === "canceled");
      pre.completedChildren = children.filter((c) => c.status === "completed");
    }
    return pre;
  },
  expectedDelta(pre, params) {
    // The app has no canceled heading state: BOTH cascades store the heading
    // as completed; children land per the policy (P10b-b1 complete, P11c
    // cancel). Pre-resolved children keep their status + stopDate (P11d).
    const childStatus = params.children === "cancel" ? "canceled" : "completed";
    const cascade = [
      ...pre.openChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: childStatus }],
      })),
      ...pre.canceledChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: "canceled" }],
      })),
      ...pre.completedChildren.map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "status", equals: "completed" }],
      })),
    ];
    return {
      mode: "state",
      uuid: params.uuid,
      // Asserting the (unchanged) title captures it in the audit pre-state —
      // the compound undo needs it to restore reparented children's heading
      // placement (todo.move's heading param takes a NAME).
      assert: [
        { field: "status", equals: "completed" },
        { field: "title", equals: pre.target?.type === "heading" ? pre.target.title : "" },
      ],
      cascade,
    };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const status = params.children === "cancel" ? "canceled" : "completed";
    return osa(`set status of to do id ${q(params.uuid)} to ${status}`);
  },
};

const headingUnarchive: CommandSpec<"heading.unarchive"> = {
  op: "heading.unarchive",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    return {
      mode: "state",
      uuid: params.uuid,
      assert: [{ field: "status", equals: "open" }],
    };
  },
  compile(params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa(`set status of to do id ${q(params.uuid)} to open`);
  },
};

const headingCreate: CommandSpec<"heading.create"> = {
  op: "heading.create",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.destProject = resolveProject(db, params.project);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const project = pre.destProject?.resolved;
    // A new type=2 row with this title under the project; disambiguate
    // duplicate titles by newest creationDate (findCreated orders DESC).
    return {
      mode: "create",
      probe: { title: params.title, type: "heading", sinceEpoch: ctx.nowEpoch - 2 },
      assert:
        project !== undefined && project !== null
          ? [{ field: "project.uuid", equals: project.uuid }]
          : [],
    };
  },
  compile(params, vector, pre) {
    if (vector !== "shortcuts") unsupportedVector(this.op, vector);
    // `things-proxy-create-heading` input: {"title": <str>, "project": <uuid>}.
    return shortcutsRun("things-proxy-create-heading", {
      title: params.title,
      project: pre.destProject?.resolved?.uuid ?? "",
    });
  },
};

const todoClearDatedReminder: CommandSpec<"todo.clear-dated-reminder"> = {
  op: "todo.clear-dated-reminder",
  hazards: ["H-UNKNOWN-DESTINATION", "H-NO-REMINDER"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, params) {
    // The reminder clears; the scheduled date is left untouched (P3b).
    const target = pre.target;
    const startDate =
      target !== null && target.type === "to-do" ? (target.startDate ?? null) : null;
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [
        { field: "reminder", equals: null },
        { field: "startDate", equals: startDate },
      ],
    };
  },
  compile(params, vector) {
    if (vector !== "shortcuts") unsupportedVector(this.op, vector);
    // `things-proxy-set-detail` input: {"id": <uuid>, "detail": <Detail>, "value": <str>}.
    // Reminder Time = "" is the clear path (scf P3b); the Detail selector name
    // comes from the app's Edit Items action list.
    return shortcutsRun("things-proxy-set-detail", {
      id: params.uuid,
      detail: "Reminder Time",
      value: "",
    });
  },
};

// ------------------------------------------------------- ui (GUI) vector

/** A compiled Accessibility recipe as a CompiledInvocation (no secrets). */
function uiDrive(recipe: UiRecipe): CompiledInvocation {
  const rendered = `ui-drive ${recipe.op} on ${recipe.targetUuid}: ${recipe.steps
    .map((s) => s.label)
    .join(" → ")}`;
  return { vector: "ui", kind: "ui-drive", payload: rendered, redactedPayload: rendered, recipe };
}

function assertRepeatRule(params: { frequency: RepeatFrequency; interval: number }): void {
  const units: RepeatFrequency[] = ["daily", "weekly", "monthly", "yearly"];
  if (!units.includes(params.frequency)) {
    throw new RangeError(`invalid frequency "${params.frequency}" — expected ${units.join(" | ")}`);
  }
  if (!Number.isInteger(params.interval) || params.interval < 1 || params.interval > 99) {
    throw new RangeError(`invalid interval ${params.interval} — expected an integer 1–99`);
  }
}

/** ui ops all guard existence/type + the H-UI-DRIVE acknowledgement. */
const UI_HAZARDS: HazardId[] = ["H-UNKNOWN-DESTINATION", "H-UI-DRIVE"];

const todoMakeRepeating: CommandSpec<"todo.make-repeating"> = {
  op: "todo.make-repeating",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    assertRepeatRule(params);
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    // Identity REPLACEMENT (UI2-a): the original to-do uuid dies; a NEW
    // template row (type=0 with a recurrence rule) is born. Discover it with
    // the create probe, and pick the template (not the spawned instance) by
    // asserting it IS a template.
    const target = pre.target;
    const title = target !== null && target.type !== "heading" ? target.title : "";
    return {
      mode: "create",
      probe: { title, type: "to-do", sinceEpoch: ctx.nowEpoch - 2 },
      assert: [{ field: "repeating.isTemplate", equals: true }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(makeRepeatingRecipe(params.uuid, params.frequency, params.interval));
  },
};

const todoRescheduleRepeat: CommandSpec<"todo.reschedule-repeat"> = {
  op: "todo.reschedule-repeat",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    assertRepeatRule(params);
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Identity PRESERVED (UI2-b): the same template uuid, rule mutated in
    // place. Assert the decoded rule's frequency + interval.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [
        { field: "repeating.rule.unit", equals: params.frequency },
        { field: "repeating.rule.interval", equals: params.interval },
      ],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(rescheduleRepeatRecipe(params.uuid, params.frequency, params.interval));
  },
};

const todoPauseRepeat: CommandSpec<"todo.pause-repeat"> = {
  op: "todo.pause-repeat",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Pause (UI2-c): rt1_instanceCreationPaused → 1; identity preserved.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "repeating.paused", equals: true }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(pauseRepeatRecipe(params.uuid));
  },
};

const todoResumeRepeat: CommandSpec<"todo.resume-repeat"> = {
  op: "todo.resume-repeat",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Resume (UI2-c): rt1_instanceCreationPaused → 0; identity preserved.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "repeating.paused", equals: false }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(resumeRepeatRecipe(params.uuid));
  },
};

// ------------------------------------------------- repeating-PROJECT ops
// The project analogs of reschedule/pause/resume. Same recurrence codec and
// Repeat dialog as the to-do ops (identical DB deltas), reached through the
// project view's always-visible repeat bar (UIC2). No project.stop-repeat is
// built — the project Stop then selecting the demoted project crashes Things
// (CRASH1 / oddities §7 C5).

const projectRescheduleRepeat: CommandSpec<"project.reschedule-repeat"> = {
  op: "project.reschedule-repeat",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    assertRepeatRule(params);
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Identity PRESERVED (UIC2-a): same project uuid, rule mutated in place.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [
        { field: "repeating.rule.unit", equals: params.frequency },
        { field: "repeating.rule.interval", equals: params.interval },
      ],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(projectRescheduleRepeatRecipe(params.uuid, params.frequency, params.interval));
  },
};

const projectPauseRepeat: CommandSpec<"project.pause-repeat"> = {
  op: "project.pause-repeat",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Pause (UIC2-a): rt1_instanceCreationPaused → 1; identity preserved.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "repeating.paused", equals: true }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(projectPauseRepeatRecipe(params.uuid));
  },
};

const projectResumeRepeat: CommandSpec<"project.resume-repeat"> = {
  op: "project.resume-repeat",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params) {
    // Resume (UIC2-a): rt1_instanceCreationPaused → 0; identity preserved.
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "repeating.paused", equals: false }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(projectResumeRepeatRecipe(params.uuid));
  },
};

const todoConvertToProject: CommandSpec<"todo.convert-to-project"> = {
  op: "todo.convert-to-project",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // Identity REPLACEMENT (UI2-d): the to-do uuid dies; a NEW type=1 project
    // is born, notes preserved. Discover it (its uuid is returned).
    const target = pre.target;
    const title = target !== null && target.type !== "heading" ? target.title : "";
    const notes = target !== null && target.type !== "heading" ? target.notes : "";
    return {
      mode: "create",
      probe: { title, type: "project", sinceEpoch: ctx.nowEpoch - 2 },
      assert: [{ field: "notes", equals: notes }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(convertToProjectRecipe("todo.convert-to-project", params.uuid));
  },
};

const headingConvertToProject: CommandSpec<"heading.convert-to-project"> = {
  op: "heading.convert-to-project",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // Identity REPLACEMENT (UI2-d): the heading uuid dies; a NEW type=1
    // project is born (promoted into the parent project's area, children
    // reparented). Discover the new project by its (former heading) title.
    const target = pre.target;
    const title = target !== null ? target.title : "";
    return {
      mode: "create",
      probe: { title, type: "project", sinceEpoch: ctx.nowEpoch - 2 },
      assert: [],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(convertToProjectRecipe("heading.convert-to-project", params.uuid));
  },
};

const trashEmpty: CommandSpec<"trash.empty"> = {
  op: "trash.empty",
  hazards: ["H-PERMANENT-DELETE"],
  preRead(db) {
    const pre = emptyPreState();
    pre.trashedCount = trashedCount(db);
    return pre;
  },
  expectedDelta() {
    return { mode: "trash-emptied" };
  },
  compile(_params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa("empty trash");
  },
};

export const COMMANDS: { [K in OperationKind]: CommandSpec<K> } = {
  "todo.add": todoAdd,
  "todo.update": todoUpdate,
  "todo.complete": todoComplete,
  "todo.cancel": todoCancel,
  "todo.reopen": todoReopen,
  "todo.move": todoMove,
  "todo.set-tags": todoSetTags,
  "todo.replace-checklist": todoReplaceChecklist,
  "todo.edit-checklist-item": todoEditChecklistItem,
  "todo.delete": todoDelete,
  "project.add": projectAdd,
  "project.update": projectUpdate,
  "project.complete": projectComplete,
  "project.delete": projectDelete,
  "area.add": areaAdd,
  "area.delete": areaDelete,
  "tag.add": tagAdd,
  "tag.delete": tagDelete,
  "trash.empty": trashEmpty,
  reorder,
  "todo.duplicate": todoDuplicate,
  "area.update": areaUpdate,
  "tag.update": tagUpdate,
  "project.move": projectMove,
  "todo.restore": todoRestore,
  "project.duplicate": projectDuplicate,
  "project.cancel": projectCancel,
  "project.reopen": projectReopen,
  "project.restore": projectRestore,
  "project.set-tags": projectSetTags,
  "todo.backdate": todoBackdate,
  "todo.add-logged": todoAddLogged,
  "heading.rename": headingRename,
  "heading.archive": headingArchive,
  "heading.unarchive": headingUnarchive,
  "heading.create": headingCreate,
  "todo.clear-dated-reminder": todoClearDatedReminder,
  "todo.make-repeating": todoMakeRepeating,
  "todo.reschedule-repeat": todoRescheduleRepeat,
  "todo.pause-repeat": todoPauseRepeat,
  "todo.resume-repeat": todoResumeRepeat,
  "todo.convert-to-project": todoConvertToProject,
  "heading.convert-to-project": headingConvertToProject,
  "project.reschedule-repeat": projectRescheduleRepeat,
  "project.pause-repeat": projectPauseRepeat,
  "project.resume-repeat": projectResumeRepeat,
};
