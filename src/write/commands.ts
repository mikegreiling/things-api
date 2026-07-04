/**
 * CommandSpec catalog: for each operation — the hazards it must clear, the
 * pre-read it needs, the DeltaSpec that proves it happened, and the compiled
 * invocation per vector. Compilation emits exactly the command shapes the
 * lab validated (u-suite / a-suite evidence ids in the vector matrices).
 */
import type { DatabaseSync } from "node:sqlite";

import type { IsoDate } from "../model/dates.ts";
import type { HazardId } from "./guards.ts";
import type { ContainerRef, OperationKind, OperationParamsMap, WhenValue } from "./operations.ts";
import {
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
import type { CompiledInvocation, VectorId } from "./vectors/types.ts";
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

function q(value: string): string {
  return `"${escapeAppleScript(value)}"`;
}

function unsupportedVector(op: string, vector: VectorId): never {
  throw new Error(`${op} cannot be compiled for vector ${vector} (planner bug)`);
}

function whenAssertions(when: WhenValue, todayIso: IsoDate): FieldAssertion[] {
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
        when: params.when,
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

const todoUpdate: CommandSpec<"todo.update"> = {
  op: "todo.update",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    if (params.when !== undefined) assert.push(...whenAssertions(params.when, ctx.todayIso));
    if (params.deadline !== undefined) assert.push({ field: "deadline", equals: params.deadline });
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl(
      "update",
      {
        id: params.uuid,
        title: params.title,
        notes: params.notes,
        when: params.when,
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
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "checklistTitles", equals: params.items }],
    };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl(
      "update",
      { id: params.uuid, "checklist-items": params.items.join("\n") },
      ctx.token,
    );
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
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    return pre;
  },
  expectedDelta(_pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    if (params.when !== undefined) assert.push(...whenAssertions(params.when, ctx.todayIso));
    if (params.deadline !== undefined) assert.push({ field: "deadline", equals: params.deadline });
    return { mode: "update", uuid: params.uuid, assert };
  },
  compile(params, vector, _pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    return thingsUrl(
      "update-project",
      {
        id: params.uuid,
        title: params.title,
        notes: params.notes,
        when: params.when,
        deadline: params.deadline === null ? "" : params.deadline,
      },
      ctx.token,
    );
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
  hazards: ["H-UNKNOWN-DESTINATION", "H-PERMANENT-DELETE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.entityTarget = resolveTag(db, params.target);
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

const reorder: CommandSpec<"reorder"> = {
  op: "reorder",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REORDER-SCOPE"],
  preRead(db, params, now) {
    const pre = emptyPreState();
    let containerUuid: string | null = null;
    if (params.scope === "project") {
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
        (params.scope === "project" || params.scope === "area" ? "index" : "todayIndex"),
      sequence: params.uuids,
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const specifier =
      params.scope === "project"
        ? `project id ${q(pre.destProject?.resolved?.uuid ?? "")}`
        : params.scope === "area"
          ? `area id ${q(pre.destArea?.resolved?.uuid ?? "")}`
          : `list "Today"`;
    const ids = (pre.reorder?.wireList ?? params.uuids).join(",");
    return osa(`${PRIVATE_REORDER_COMMAND} ${specifier} with ids ${q(ids)}`);
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
};
