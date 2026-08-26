/**
 * CommandSpec catalog: for each operation — the hazards it must clear, the
 * pre-read it needs, the DeltaSpec that proves it happened, and the compiled
 * invocation per vector. Compilation emits exactly the command shapes the
 * lab validated (u-suite / a-suite evidence ids in the vector matrices).
 */
import type { DatabaseSync } from "node:sqlite";

import { localToday, zonedWallInstant, type IsoDate, type ReminderTime } from "../model/dates.ts";
import type { Todo } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
import { manualLogDateEpoch, pendingLogCount } from "../read/log-boundary.ts";
import { isLooseRef } from "../read/pseudo-area.ts";
import type { HazardId } from "./guards.ts";
import type {
  ContainerRef,
  OperationKind,
  OperationParamsMap,
  ProjectItemSpec,
  RepeatRuleParams,
  WhenValue,
} from "./operations.ts";
import {
  areaMemberCounts,
  childTagTitles,
  classifyHeadingConvert,
  classifyHeadingDissolve,
  classifyHeadingMoveToProject,
  classifyProjectRepeat,
  computeHeadingMovePre,
  computeReorderPre,
  emptyPreState,
  loadTarget,
  projectChildren,
  projectStatus,
  projectSubtreeUuids,
  resolveArea,
  resolveHeading,
  resolveProject,
  resolveTag,
  sameTitleTaskUuids,
  seriesRowUuids,
  trashedCount,
  type PreState,
} from "./pre-state.ts";
import {
  assertNotesModesExclusive,
  normalizeReminder,
  updateAssertions,
  updateWireParams,
  whenAssertions,
  whenWithReminder,
} from "./update-fields.ts";
import { resolveTagRefs } from "./tag-refs.ts";
import { PRIVATE_REORDER_COMMAND } from "./experimental.ts";
import { assertRepeatRule } from "./repeat-rule.ts";
import { assessOffRuleFirst, deadlineDriveNext, deriveFixedAnchor } from "./repeat-anchor.ts";
import { expectedRuleAssertions } from "./repeat-asserts.ts";
import { escapeAppleScript } from "./vectors/applescript.ts";
import {
  areaReorderSidebarRecipe,
  convertToProjectRecipe,
  dissolveHeadingRecipe,
  headingConvertToProjectRecipe,
  moveHeadingChordRecipe,
  moveHeadingToProjectRecipe,
  makeRepeatingRecipe,
  createNextCopyRecipe,
  pauseRepeatRecipe,
  projectMakeRepeatingRecipe,
  projectPauseRepeatRecipe,
  projectRescheduleRepeatRecipe,
  projectResumeRepeatRecipe,
  rescheduleRepeatRecipe,
  resumeRepeatRecipe,
  type RepeatRuleExtras,
} from "./vectors/ui-recipes.ts";
import type { SidebarPlacement } from "./vectors/ui-drag.ts";
import type { CompiledInvocation, UiRecipe, VectorId } from "./vectors/types.ts";
import { buildRepeatingFingerprint, type DeltaSpec, type FieldAssertion } from "./verify/delta.ts";

export interface CompileCtx {
  token: string | null;
  /**
   * Effective consumer zone for THIS write (`options.zone ?? deps.zone`), the
   * same resolution chain reads use. Governs date-only → noon normalization for
   * the resolution-timestamp surface (§5); undefined = the process-local (app
   * host) zone.
   */
  zone?: string;
}

export interface DeltaCtx {
  /** Epoch seconds at execute time (create-probe window). */
  nowEpoch: number;
  /** Local calendar date (guest/host clock) for `when: today|evening`. */
  todayIso: IsoDate;
  /** Effective consumer zone (see {@link CompileCtx.zone}). */
  zone?: string;
}

export interface CommandSpec<K extends OperationKind = OperationKind> {
  op: K;
  hazards: HazardId[];
  preRead(db: DatabaseSync, params: OperationParamsMap[K], now: Date, zone?: string): PreState;
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

function sortedTags(tags: string[]): string[] {
  return [...tags].toSorted();
}

/**
 * Resolve tag refs (title or `parent/child` path — names only) into pre-state:
 * the leaf titles to apply, plus the unknown (`missingTags`) refs the
 * H-UNKNOWN-TAG guard refuses on. Tags apply BY NAME through the app's own
 * vector, so the app resolves the name (duplicate names resolve app-side, as
 * in the GUI) — the resolver is a pure existence check.
 */
function applyTagRefs(db: DatabaseSync, pre: PreState, tags: string[]): void {
  const res = resolveTagRefs(db, tags);
  pre.missingTags = res.missing;
  pre.resolvedTagTitles = res.titles;
}

/**
 * Is a destination container SUPPLIED? A PRESENCE check, not a duck-test (#580):
 * the parameter schema (param-schema.ts) has already proven that a present ref is
 * a `{uuid}`/`{title}` object, so anything else reaching here is an engine bug,
 * not caller input — and it THROWS rather than reading as "no destination given",
 * which is precisely how a bare-string `project` used to compile an Inbox capture
 * with no placement and no placement assertion, then verify clean.
 */
export function containerGiven(ref: ContainerRef | undefined | null): boolean {
  if (ref === undefined || ref === null) return false;
  assertContainerRef(ref);
  return true;
}

/** Belt-and-braces: a present container reference must carry a uuid or a title. */
export function assertContainerRef(ref: ContainerRef): void {
  if (typeof ref !== "object" || Array.isArray(ref)) {
    throw new RangeError(
      `a container reference must be an object naming a uuid or a title — received ${JSON.stringify(ref)}`,
    );
  }
  if (ref.uuid === undefined && ref.title === undefined) {
    throw new RangeError("a container reference must name a uuid or a title — it names neither");
  }
}

/**
 * The create-probe title for the duplicate / identity-replacement ops, whose
 * new row inherits the pre-read target's title. Non-heading targets only (the
 * heading-convert op uses the raw title, headings included); "" when the target
 * did not resolve. Shared by the pre-read same-title capture and the delta so
 * the excluded set and the probe title cannot drift apart.
 */
function nonHeadingTitle(pre: PreState): string {
  const target = pre.target;
  return target !== null && target.type !== "heading" ? target.title : "";
}

// ---- resolution-timestamp add helpers (§2 add rows, §5b) ------------------

interface AddTimestampFields {
  createdAt?: string;
  completedAt?: string;
  when?: WhenValue;
  reminder?: ReminderTime;
}

/** True when an add carries a resolution-timestamp flag (routes it through json). */
function addHasTimestamps(p: { createdAt?: string; completedAt?: string }): boolean {
  return p.createdAt !== undefined || p.completedAt !== undefined;
}

/**
 * Validate the resolution-timestamp flags on an add (shape, chronology, and the
 * schedule contradiction). Instant ordering is zone-independent (both values
 * share one effective zone), so the chronology check resolves against the host
 * zone. Throws RangeError on a bad combination.
 */
function assertAddTimestamps(p: AddTimestampFields): void {
  if (p.createdAt !== undefined) resolveResolutionInstant(p.createdAt);
  if (p.completedAt !== undefined) resolveResolutionInstant(p.completedAt);
  if (
    p.createdAt !== undefined &&
    p.completedAt !== undefined &&
    resolveResolutionInstant(p.createdAt).getTime() >
      resolveResolutionInstant(p.completedAt).getTime()
  ) {
    throw new RangeError("--created-at must not be after --completed-at");
  }
  if (p.completedAt !== undefined && (p.when !== undefined || p.reminder !== undefined)) {
    throw new RangeError(
      "--completed-at creates a resolved (Logbook) item, which has no active schedule — drop --when/--reminder",
    );
  }
  if (p.reminder !== undefined && p.createdAt !== undefined) {
    throw new RangeError("--reminder is not available with --created-at");
  }
}

/** A `things:///json` import payload for a single created to-do/project. */
function addJsonUrl(
  type: "to-do" | "project",
  attributes: Record<string, unknown>,
  token: string | null,
): CompiledInvocation {
  return thingsUrl("json", { data: JSON.stringify([{ type, attributes }]) }, token);
}

/** The completion/creation json attributes for a timestamped add. */
function addDateAttributes(
  p: { createdAt?: string; completedAt?: string },
  zone: string | undefined,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (p.createdAt !== undefined) {
    attrs["creation-date"] = jsonTimestamp(resolveResolutionInstant(p.createdAt, zone));
  }
  if (p.completedAt !== undefined) {
    attrs["completed"] = true;
    attrs["completion-date"] = jsonTimestamp(resolveResolutionInstant(p.completedAt, zone));
  }
  return attrs;
}

/** The completion/creation delta assertions for a timestamped add. */
function addDateAssertions(
  p: { createdAt?: string; completedAt?: string },
  zone: string | undefined,
): FieldAssertion[] {
  const assert: FieldAssertion[] = [];
  if (p.completedAt !== undefined) {
    assert.push({ field: "status", equals: "completed" });
    assert.push({
      field: "stoppedDate",
      equals: hostLocalDate(resolveResolutionInstant(p.completedAt, zone)),
    });
  }
  if (p.createdAt !== undefined) {
    assert.push({
      field: "createdDate",
      equals: hostLocalDate(resolveResolutionInstant(p.createdAt, zone)),
    });
  }
  return assert;
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
    if (containerGiven(params.project) && containerGiven(params.area)) {
      throw new RangeError("project and area are exclusive destinations");
    }
    if (params.heading !== undefined && !containerGiven(params.project)) {
      throw new RangeError("heading requires a project destination");
    }
    assertAddTimestamps(params);
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
    if (params.tags !== undefined) applyTagRefs(db, pre, params.tags);
    pre.sameTitleUuids = sameTitleTaskUuids(db, params.title, "to-do");
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    // A born-resolved (completedAt) item has no active schedule — skip when/reminder.
    if (params.completedAt === undefined) {
      if (params.when !== undefined) assert.push(...whenAssertions(params.when, ctx.todayIso));
      if (params.reminder !== undefined) {
        assert.push({ field: "reminder", equals: normalizeReminder(params.reminder) });
      }
      if (params.deadline !== undefined) {
        assert.push({ field: "deadline", equals: params.deadline });
      }
    }
    assert.push(...addDateAssertions(params, ctx.zone));
    if (params.tags !== undefined) {
      assert.push({ field: "tags", equals: sortedTags(pre.resolvedTagTitles) });
    }
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
      probe: {
        title: params.title,
        type: "to-do",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
      assert,
    };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    const container = pre.destProject?.resolved ?? pre.destArea?.resolved;
    // Timestamped add: the only at-creation backdating surface is things:///json
    // (the plain add URL drops date params — oddity 2g); route through it.
    if (addHasTimestamps(params)) {
      const attrs: Record<string, unknown> = { title: params.title };
      if (params.notes !== undefined) attrs["notes"] = params.notes;
      Object.assign(attrs, addDateAttributes(params, ctx.zone));
      if (params.completedAt === undefined) {
        if (params.when !== undefined) attrs["when"] = params.when;
        if (params.deadline !== undefined) attrs["deadline"] = params.deadline;
      }
      if (params.tags !== undefined) attrs["tags"] = pre.resolvedTagTitles;
      if (params.checklistItems !== undefined) {
        // §9y: things:///json rejects a bare STRING array wholesale (silent
        // no-op) — emit the OBJECT-array shape the app accepts.
        attrs["checklist-items"] = checklistItemsJsonAttr(
          params.checklistItems.map((title) => ({ title })),
        );
      }
      if (container?.uuid !== undefined) attrs["list-id"] = container.uuid;
      if (pre.destHeading?.resolved?.title !== undefined) {
        attrs["heading"] = pre.destHeading.resolved.title;
      }
      return addJsonUrl("to-do", attrs, ctx.token);
    }
    return thingsUrl(
      "add",
      {
        title: params.title,
        notes: params.notes,
        when:
          params.when === undefined ? undefined : whenWithReminder(params.when, params.reminder),
        deadline: params.deadline,
        tags: params.tags === undefined ? undefined : pre.resolvedTagTitles.join(","),
        "checklist-items": params.checklistItems?.join("\n"),
        "list-id": container?.uuid,
        heading: pre.destHeading?.resolved?.title,
      },
      ctx.token,
    );
  },
};

/**
 * The to-do / project update pair. Both legs — the URL parameters and the
 * expected-delta assertions — are DERIVED from the single exhaustive registry in
 * update-fields.ts (the #491 exhaustive-map doctrine): the only per-verb
 * difference is the URL command name, so neither verb can accept a field the
 * other drops, and a field added to `UpdateFields` breaks compilation there
 * until every leg handles it.
 */
function updateSpec<K extends "todo.update" | "project.update">(
  op: K,
  urlCommand: "update" | "update-project",
): CommandSpec<K> {
  return {
    op,
    hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE", "H-REMINDER-SCOPE"],
    preRead(db, params, now) {
      assertNotesModesExclusive(params);
      const pre = emptyPreState();
      pre.todayIso = localToday(now);
      pre.target = loadTarget(db, params.uuid);
      return pre;
    },
    expectedDelta(pre, params, ctx) {
      return { mode: "update", uuid: params.uuid, assert: updateAssertions(params, pre, ctx) };
    },
    compile(params, vector, pre, ctx) {
      if (vector !== "url-scheme") unsupportedVector(op, vector);
      return thingsUrl(
        urlCommand,
        { id: params.uuid, ...updateWireParams(params, pre) },
        ctx.token,
      );
    },
  };
}

const todoUpdate = updateSpec("todo.update", "update");

function statusSpec<K extends "todo.complete" | "todo.cancel" | "todo.reopen">(
  op: K,
  urlParam: Record<string, string>,
  asStatus: "completed" | "canceled" | "open",
  scriptStatus: string,
): CommandSpec<K> {
  return {
    op,
    hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
    preRead(db, params, now, zone) {
      const pre = emptyPreState();
      // Load under the response clock so the target's Today marker (read by the
      // HINTS1 completion-context) reflects the same calendar day the pipeline
      // verifies under, not the host wall clock.
      pre.target = loadTarget(db, params.uuid, now, zone);
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
    const detachFamily = params.loose === true || params.noHeading === true;
    if (params.inbox === true && (container || detachFamily)) {
      throw new RangeError("inbox is exclusive with project/area/heading and --no-heading/--loose");
    }
    if (params.loose === true && (container || params.noHeading === true)) {
      throw new RangeError("--loose is exclusive with project/area/heading and --no-heading");
    }
    if (params.noHeading === true && container) {
      throw new RangeError("--no-heading is exclusive with project/area/heading destinations");
    }
    if (containerGiven(params.project) && containerGiven(params.area)) {
      throw new RangeError("project and area are exclusive destinations");
    }
    if (params.heading !== undefined && !containerGiven(params.project)) {
      throw new RangeError("heading requires a project destination");
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
    // --no-heading re-asserts the CURRENT project as the container: resolve the
    // target's own project (direct or via its heading) so compile/delta pin it.
    if (params.noHeading === true) {
      const t = pre.target;
      const current =
        t !== null && t.type === "to-do" ? (t.project ?? t.headingProject ?? null) : null;
      if (current !== null) {
        pre.destProject = { resolved: { uuid: current.uuid, title: current.title }, matches: 1 };
        pre.destProjectStatus = projectStatus(db, current.uuid);
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
    if (params.loose === true) {
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
    if (params.noHeading === true) {
      // Leave the heading, keep the project: re-assert the current project as
      // the container with no heading (lands in the unheaded block).
      const project = pre.destProject?.resolved;
      assert.push({ field: "heading", equals: null });
      if (project !== undefined && project !== null) {
        assert.push({ field: "project.uuid", equals: project.uuid });
      }
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
    if (params.loose === true) {
      // Empty list-id = clear the container (P21/P22) — URL only; the other
      // vectors reject or silently ignore container removal (P10/P11, P26).
      if (vector !== "url-scheme") unsupportedVector(this.op, vector);
      return thingsUrl("update", { id: params.uuid, "list-id": "" }, ctx.token);
    }
    if (params.noHeading === true) {
      // Re-assert the CURRENT project as the list with no heading param — the
      // to-do drops its heading FK and lands in the project's unheaded block.
      if (vector !== "url-scheme") unsupportedVector(this.op, vector);
      return thingsUrl(
        "update",
        { id: params.uuid, "list-id": pre.destProject?.resolved?.uuid ?? "" },
        ctx.token,
      );
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
    applyTagRefs(db, pre, params.tags);
    return pre;
  },
  expectedDelta(pre, params) {
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "tags", equals: sortedTags(pre.resolvedTagTitles) }],
    };
  },
  compile(params, vector, pre, ctx) {
    const applied = pre.resolvedTagTitles;
    if (vector === "url-scheme") {
      return thingsUrl("update", { id: params.uuid, tags: applied.join(",") }, ctx.token);
    }
    return osa(`set tag names of to do id ${q(params.uuid)} to ${q(applied.join(", "))}`);
  },
};

/** Normalize the string | spec union; decide whether states force the json form. */
/**
 * The `checklist-items` value `things:///json` accepts: an array of
 * `{type:"checklist-item",attributes:{title[,completed]}}` OBJECTS. A bare
 * STRING array is rejected wholesale — the whole import silently no-ops, no row,
 * no error (§9y; RESID1 R-JSONPAR RAW-a..d). `completed` is emitted only when a
 * spec carries it, so an at-creation add (all items open) yields the minimal
 * `{title}` attributes the probe validated (OBJ/OBJ3), while the checklist
 * replace path forwards its per-item state.
 */
function checklistItemsJsonAttr(
  specs: { title: string; completed?: boolean }[],
): { type: "checklist-item"; attributes: { title: string; completed?: boolean } }[] {
  return specs.map((s) => ({
    type: "checklist-item",
    attributes:
      s.completed === undefined ? { title: s.title } : { title: s.title, completed: s.completed },
  }));
}

/**
 * Build a project json import's `items` array from a structured
 * {@link ProjectItemSpec} list (the clone / rich-import path). Order IS the
 * layout: a `heading` node produces a `{type:"heading"}` row and every following
 * `to-do` node inherits it positionally (A4); a `to-do` before the first heading
 * is a project-root child. Children are born OPEN — no `completed` attribute.
 */
function projectItemsJsonAttr(items: ProjectItemSpec[]): Record<string, unknown>[] {
  return items.map((it) => {
    if (it.kind === "heading") {
      return { type: "heading", attributes: { title: it.title } };
    }
    const attrs: Record<string, unknown> = { title: it.title };
    if (it.notes !== undefined) attrs["notes"] = it.notes;
    if (it.when !== undefined) attrs["when"] = it.when;
    if (it.deadline !== undefined) attrs["deadline"] = it.deadline;
    if (it.tags !== undefined) attrs["tags"] = it.tags;
    if (it.checklistItems !== undefined) {
      attrs["checklist-items"] = checklistItemsJsonAttr(
        it.checklistItems.map((title) => ({ title })),
      );
    }
    return { type: "to-do", attributes: attrs };
  });
}

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
          "checklist-items": checklistItemsJsonAttr(specs),
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

const CLONE_ORCHESTRATED_ONLY =
  "todo.clone / project.clone are delivered by the runCloneTodo / runCloneProject orchestrators (a " +
  "compound over todo.add / project.add plus checklist / terminal-state follow-up legs); they have " +
  "no atomic surface and are never dispatched directly through the pipeline";

function cloneStub<K extends "todo.clone" | "project.clone">(op: K): CommandSpec<K> {
  return {
    op,
    hazards: [],
    preRead(db, params) {
      const pre = emptyPreState();
      pre.target = loadTarget(db, params.uuid);
      return pre;
    },
    expectedDelta() {
      throw new Error(CLONE_ORCHESTRATED_ONLY);
    },
    compile() {
      throw new Error(CLONE_ORCHESTRATED_ONLY);
    },
  };
}

const todoClone = cloneStub("todo.clone");
const projectClone = cloneStub("project.clone");

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
    assertAddTimestamps(params);
    // §5b (B-PROJ-JSON.2): a completed-project json import silently reverts to
    // OPEN if any child spec is unresolved. Seed to-dos are always open, so a
    // born-resolved project cannot carry them.
    if (params.completedAt !== undefined && params.todos !== undefined && params.todos.length > 0) {
      throw new RangeError(
        "--completed-at cannot seed child to-dos: a completed-project import reverts to open " +
          "unless every child is resolved (§5b) — create the project resolved, then add logged children",
      );
    }
    if (params.todos !== undefined && params.items !== undefined) {
      throw new RangeError("project.add takes either `todos` or structured `items`, not both");
    }
    if (params.completedAt !== undefined && params.items !== undefined && params.items.length > 0) {
      throw new RangeError(
        "--completed-at cannot seed child items: a completed-project import reverts to open " +
          "unless every child is resolved (§5b)",
      );
    }
    const pre = emptyPreState();
    if (containerGiven(params.area)) pre.destArea = resolveArea(db, params.area as ContainerRef);
    pre.sameTitleUuids = sameTitleTaskUuids(db, params.title, "project");
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const assert: FieldAssertion[] = [];
    if (params.notes !== undefined) assert.push({ field: "notes", equals: params.notes });
    if (params.completedAt === undefined) {
      if (params.when !== undefined) assert.push(...whenAssertions(params.when, ctx.todayIso));
      if (params.deadline !== undefined) {
        assert.push({ field: "deadline", equals: params.deadline });
      }
    }
    assert.push(...addDateAssertions(params, ctx.zone));
    const area = pre.destArea?.resolved;
    if (area !== undefined && area !== null) assert.push({ field: "area.uuid", equals: area.uuid });
    // KNOWN SHALLOW SPOT (audited 2026-08-23, exhaustive-map sweep): the seeded
    // children — `todos` and the structured `items` (headings + rich children) —
    // contribute NO assertion, so a project born with an empty body still
    // verifies `ok`. Unlike a to-do's `checklistItems` (asserted through
    // `checklistTitles`) there is no child-list field on the delta vocabulary to
    // compare against, and adding one needs probe evidence that the imported
    // children are readable inside the verify window before a missing child may
    // be called a failure. Tracked in docs/up-next.md; do NOT "fix" it blind.
    return {
      mode: "create",
      probe: {
        title: params.title,
        type: "project",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
      assert,
    };
  },
  compile(params, vector, pre, ctx) {
    if (vector !== "url-scheme") unsupportedVector(this.op, vector);
    // The json import is required for born-timestamps AND for structured `items`
    // (headings / rich children) — the plain add-project URL carries neither.
    if (addHasTimestamps(params) || params.items !== undefined) {
      const attrs: Record<string, unknown> = { title: params.title };
      if (params.notes !== undefined) attrs["notes"] = params.notes;
      Object.assign(attrs, addDateAttributes(params, ctx.zone));
      if (params.completedAt === undefined) {
        if (params.when !== undefined) attrs["when"] = params.when;
        if (params.deadline !== undefined) attrs["deadline"] = params.deadline;
        if (params.items !== undefined) {
          attrs["items"] = projectItemsJsonAttr(params.items);
        } else if (params.todos !== undefined) {
          attrs["items"] = params.todos.map((t) => ({ type: "to-do", attributes: { title: t } }));
        }
      }
      if (pre.destArea?.resolved?.uuid !== undefined) attrs["area-id"] = pre.destArea.resolved.uuid;
      return addJsonUrl("project", attrs, ctx.token);
    }
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

// Projects carry the same reminderTime codec and notes/schedule semantics as
// to-dos (A3/E18) — same registry, same legs, only the URL command differs.
const projectUpdate = updateSpec("project.update", "update-project");

const projectSetTags: CommandSpec<"project.set-tags"> = {
  op: "project.set-tags",
  hazards: ["H-UNKNOWN-DESTINATION", "H-UNKNOWN-TAG"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    applyTagRefs(db, pre, params.tags);
    return pre;
  },
  expectedDelta(pre, params) {
    return {
      mode: "update",
      uuid: params.uuid,
      assert: [{ field: "tags", equals: sortedTags(pre.resolvedTagTitles) }],
    };
  },
  compile(params, vector, pre, ctx) {
    // Both vectors validated on projects (A1 URL, A2 AppleScript). Full
    // replacement semantics mirror todo.set-tags; unknown tags are guarded
    // pre-write (the app silently drops them).
    const applied = pre.resolvedTagTitles;
    if (vector === "url-scheme") {
      return thingsUrl("update-project", { id: params.uuid, tags: applied.join(",") }, ctx.token);
    }
    return osa(`set tag names of project id ${q(params.uuid)} to ${q(applied.join(", "))}`);
  },
};

const projectMove: CommandSpec<"project.move"> = {
  op: "project.move",
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
  preRead(db, params) {
    if ((params.noArea === true) === containerGiven(params.area)) {
      throw new RangeError("project.move needs exactly one of area / --no-area");
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
        params.noArea === true
          ? { field: "area", equals: null }
          : { field: "area.uuid", equals: pre.destArea?.resolved?.uuid ?? "" },
      ],
    };
  },
  compile(params, vector, pre, ctx) {
    if (vector === "url-scheme") {
      // P23 (move) / P24 (empty area-id = leave the area — URL is the ONLY
      // surface: AppleScript rejects missing value/"" and json-null no-ops).
      return thingsUrl(
        "update-project",
        {
          id: params.uuid,
          "area-id": params.noArea === true ? "" : (pre.destArea?.resolved?.uuid ?? ""),
        },
        ctx.token,
      );
    }
    if (params.noArea === true) unsupportedVector(this.op, vector);
    return osa(
      `set area of project id ${q(params.uuid)} to area id ` +
        q(pre.destArea?.resolved?.uuid ?? ""),
    );
  },
};

const todoRestore: CommandSpec<"todo.restore"> = {
  op: "todo.restore",
  hazards: ["H-UNKNOWN-DESTINATION", "H-TEMPLATE-CHILD-RESTORE", "H-REPEAT-SCHEDULE"],
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
    pre.sameTitleUuids = sameTitleTaskUuids(db, nonHeadingTitle(pre), "project");
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // E17: the copy carries the title, notes AND children; discover it with
    // the create probe (fresh creationDate, same as the to-do path E07). The
    // ORIGINAL shares the copy's title, so it is among the excluded pre-existing
    // rows — discovery lands on the copy, never the source.
    const target = pre.target;
    const notes = target !== null && target.type !== "heading" ? target.notes : "";
    return {
      mode: "create",
      probe: {
        title: nonHeadingTitle(pre),
        type: "project",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
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
  // H-REPEAT-SCHEDULE: a trashed repeating PROJECT template cannot be restored
  // headlessly (Put Back only) — refuse categorically instead of the raw AS-301
  // no-op. (The to-do path already carries it; kind-parity, 2026-08-13.)
  hazards: ["H-UNKNOWN-DESTINATION", "H-REPEAT-SCHEDULE"],
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
    if (params.tags !== undefined) applyTagRefs(db, pre, params.tags);
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
      // Assert the landed tag set on the created area — the app silently
      // drops unknowns (guarded pre-write), so the created row must carry
      // exactly the resolved titles (parity with the other tag-set ops).
      ...(params.tags !== undefined && { assertTags: sortedTags(pre.resolvedTagTitles) }),
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const make = `make new area with properties {name:${q(params.title)}}`;
    if (params.tags === undefined || params.tags.length === 0) return osa(make);
    const payload =
      `tell application "Things3"\n` +
      `  ${make}\n` +
      `  set tag names of area ${q(params.title)} to ${q(pre.resolvedTagTitles.join(", "))}\n` +
      `end tell`;
    return { vector: "applescript", kind: "osascript", payload, redactedPayload: payload };
  },
};

const areaDelete: CommandSpec<"area.delete"> = {
  op: "area.delete",
  hazards: ["H-UNKNOWN-DESTINATION", "H-AREA-NOT-EMPTY", "H-PERMANENT-DELETE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.entityTarget = resolveArea(db, { title: params.target, uuid: params.target });
    if (pre.entityTarget.resolved !== null) {
      pre.areaMembers = areaMemberCounts(db, pre.entityTarget.resolved.uuid);
    }
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
    pre.sameTitleUuids = sameTitleTaskUuids(db, nonHeadingTitle(pre), "to-do");
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // The copy carries the same title/notes with a fresh uuid + creationDate
    // (E07) — discover it with the create probe, assert copy fidelity. The
    // ORIGINAL shares the title, so it is excluded as a pre-existing row.
    const target = pre.target;
    const notes = target !== null && target.type !== "heading" ? target.notes : "";
    return {
      mode: "create",
      probe: {
        title: nonHeadingTitle(pre),
        type: "to-do",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
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
    if (params.tags !== undefined) applyTagRefs(db, pre, params.tags);
    return pre;
  },
  expectedDelta(pre, params) {
    const assert: FieldAssertion[] = [];
    if (params.title !== undefined) assert.push({ field: "title", equals: params.title });
    if (params.tags !== undefined) {
      assert.push({ field: "tags", equals: sortedTags(pre.resolvedTagTitles) });
    }
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
      lines.push(`set tag names of area id ${id} to ${q(pre.resolvedTagTitles.join(", "))}`);
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
  preRead(db, params, now, zone) {
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
    if (params.scope === "container-day") {
      // The container may be a project OR an area (DAYORD-b); resolve whichever
      // the ref names so the compile can pick the right `project id`/`area id`
      // specifier. The planner always passes a resolved uuid.
      const asProject = resolveProject(db, params.container ?? {});
      if (asProject.resolved !== null) {
        pre.destProject = asProject;
        containerUuid = asProject.resolved.uuid;
      } else {
        pre.destArea = resolveArea(db, params.container ?? {});
        containerUuid = pre.destArea.resolved?.uuid ?? null;
      }
    }
    // The `reorder` op IS the pure-native private index wire — the ONE surface
    // runReorder dispatches here (strategy === "native"). So the LOGSORT ORD-13
    // permit is unconditionally offered (`admitResolved: true`); computeReorderPre
    // gates it internally on `key === "index"`, so day-axis native re-ranks
    // (today/container-day/tomorrow → todayIndex) still refuse resolved movees.
    // Every bounce/move/day-axis orchestrator calls computeReorderPre WITHOUT the
    // flag, so a resolved movee reaching an uncertified protocol stays refused.
    pre.reorder = computeReorderPre(db, params, containerUuid, now, { admitResolved: true, zone });
    return pre;
  },
  expectedDelta(pre, params) {
    // Verify the REQUESTED sequence (strictly ascending ranks). The wire
    // list pins the unrequested tail too, but the caller's contract is the
    // requested prefix; tail members are covered by pre-rank tripwires.
    // TODWIRE: on the `today` scope the wire is now MINIMAL — only the named
    // block gets fresh (front, monotonic) `todayIndex`; the unnamed tail keeps
    // its cohort-interleaved (non-monotonic) `todayIndex`, so the FULL
    // `params.uuids` is NOT strictly-ascending after the write. Verify the
    // `todayWire` (the named block) instead — it lands at the visible front in
    // wire order with fresh ascending values, and the untouched tail rides the
    // pre-rank tripwires. Every other scope verifies the requested prefix.
    // LOGSORT ORD-13 byte-lock: any admitted UNSWEPT-resolved movee must read
    // back index-only — status still closed, stoppedDate intact, umd unbumped
    // (a reopen would flip all three). Frozen assertions carry that into verify.
    const frozen = (pre.reorder?.resolvedMembers ?? []).map((m) => ({
      uuid: m.uuid,
      assert: [
        { field: "status", equals: m.status },
        { field: "stoppedDate", equals: m.stoppedDate },
      ] satisfies FieldAssertion[],
    }));
    const sequence =
      params.scope === "today" && pre.reorder?.todayWire != null
        ? pre.reorder.todayWire
        : params.uuids;
    return {
      mode: "ordering",
      key:
        pre.reorder?.key ??
        (params.scope === "today" || params.scope === "evening" ? "todayIndex" : "index"),
      sequence,
      ...(frozen.length > 0 && { frozen }),
    };
  },
  compile(params, vector, pre) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    const containerDaySpecifier =
      pre.destProject?.resolved != null
        ? `project id ${q(pre.destProject.resolved.uuid)}`
        : `area id ${q(pre.destArea?.resolved?.uuid ?? "")}`;
    const specifier =
      params.scope === "project"
        ? `project id ${q(pre.destProject?.resolved?.uuid ?? "")}`
        : params.scope === "area"
          ? `area id ${q(pre.destArea?.resolved?.uuid ?? "")}`
          : params.scope === "container-day"
            ? containerDaySpecifier
            : params.scope === "inbox"
              ? `list "Inbox"`
              : params.scope === "someday"
                ? `list "Someday"`
                : params.scope === "tomorrow"
                  ? `list "Tomorrow"`
                  : params.scope === "upcoming"
                    ? `list "Upcoming"`
                    : `list "Today"`;
    // TODWIRE — the `today` scope sends the MINIMAL visible-order wire (names only
    // what must move; unnamed rows keep their entry cohorts + visible positions),
    // not the OLD full `wireList` that fused every cohort (MOVPLC/ORD-20). Every
    // other native scope keeps the full wire (their `index`/day axes do not
    // re-stamp `tiRef`, so a full re-rank is non-damaging).
    const wire =
      (params.scope === "today" ? pre.reorder?.todayWire : undefined) ??
      pre.reorder?.wireList ??
      params.uuids;
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

// ---- resolution-timestamp normalization (§5 of the plan) ------------------

/**
 * Parse an ISO date (`2025-01-15`) OR datetime (`2025-01-15T09:30[:ss]`) and
 * resolve it to a single UTC instant in the effective `zone`. A date-only value
 * lands at NOON in that zone (B-DATEONLY: noon decodes to the intended calendar
 * date in every zone; midnight can slip a day). A datetime is read as wall-clock
 * time in the effective zone. `zone` undefined = the process-local (app host)
 * zone, which for a local CLI run IS the app's own zone.
 */
export function resolveResolutionInstant(input: string, zone?: string): Date {
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(input);
  if (dateOnly !== null) return zonedWallInstant(dateOnly[1] as string, 12, 0, 0, zone);
  const dt = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (dt !== null) {
    return zonedWallInstant(
      dt[1] as string,
      Number(dt[2]),
      Number(dt[3]),
      dt[4] === undefined ? 0 : Number(dt[4]),
      zone,
    );
  }
  throw new RangeError(
    `invalid timestamp "${input}" — expected an ISO date (YYYY-MM-DD) or datetime (YYYY-MM-DDTHH:mm)`,
  );
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The host-local calendar date (`YYYY-MM-DD`) an instant renders as — what the verify layer observes for stopped/created. */
function hostLocalDate(instant: Date): IsoDate {
  return `${instant.getFullYear()}-${pad2(instant.getMonth() + 1)}-${pad2(instant.getDate())}`;
}

/**
 * The host-local calendar date a resolution-timestamp value resolves to — the
 * value the verify layer observes for `stoppedDate`/`createdDate`. Shared with
 * the multi-leg orchestrators so their synthesized deltas match the op's.
 */
export function resolutionDeltaDate(input: string, zone?: string): IsoDate {
  return hostLocalDate(resolveResolutionInstant(input, zone));
}

/**
 * An instant as a second-precision UTC timestamp (`…Thh:mm:ssZ`) for the json
 * import. WITHOUT milliseconds: the app's json date parser rejects fractional
 * seconds — a `.000Z` stamp fails the whole command (oddity 2h; P4d's validated
 * shape was second-precision).
 */
function jsonTimestamp(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A locale-proof AppleScript date literal built from an instant's HOST-LOCAL
 * wall-clock components — AS `current date` mutation lives in the host zone, so
 * setting those components reproduces exactly this instant regardless of the
 * effective zone the noon was computed in.
 */
function asDateBlockFromInstant(varName: string, instant: Date): string[] {
  return [
    `set ${varName} to current date`,
    `set time of ${varName} to ${instant.getHours()} * hours + ${instant.getMinutes()} * minutes + ${instant.getSeconds()}`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${instant.getFullYear()}`,
    `set month of ${varName} to ${instant.getMonth() + 1}`,
    `set day of ${varName} to ${instant.getDate()}`,
  ];
}

/** Shared spec for the kind-agnostic `set-dates` op (to-do / project). */
function setDatesSpec<K extends "todo.set-dates" | "project.set-dates">(
  op: K,
  addressor: "to do" | "project",
): CommandSpec<K> {
  return {
    op,
    hazards: ["H-UNKNOWN-DESTINATION", "H-BACKDATE-OPEN"],
    preRead(db, params) {
      if (params.completedAt === undefined && params.createdAt === undefined) {
        throw new RangeError("nothing to set: give completedAt and/or createdAt");
      }
      const pre = emptyPreState();
      pre.target = loadTarget(db, params.uuid);
      return pre;
    },
    expectedDelta(_pre, params, ctx) {
      const assert: FieldAssertion[] = [];
      if (params.completedAt !== undefined) {
        assert.push({
          field: "stoppedDate",
          equals: hostLocalDate(resolveResolutionInstant(params.completedAt, ctx.zone)),
        });
      }
      if (params.createdAt !== undefined) {
        assert.push({
          field: "createdDate",
          equals: hostLocalDate(resolveResolutionInstant(params.createdAt, ctx.zone)),
        });
      }
      return { mode: "update", uuid: params.uuid, assert };
    },
    compile(params, vector, _pre, ctx) {
      if (vector !== "applescript") unsupportedVector(this.op, vector);
      const statements: string[] = [];
      if (params.completedAt !== undefined) {
        statements.push(
          ...asDateBlockFromInstant(
            "compDate",
            resolveResolutionInstant(params.completedAt, ctx.zone),
          ),
          `set completion date of ${addressor} id ${q(params.uuid)} to compDate`,
        );
      }
      if (params.createdAt !== undefined) {
        statements.push(
          ...asDateBlockFromInstant(
            "createDate",
            resolveResolutionInstant(params.createdAt, ctx.zone),
          ),
          `set creation date of ${addressor} id ${q(params.uuid)} to createDate`,
        );
      }
      return osaBlock(statements);
    },
  };
}

const todoSetDates = setDatesSpec("todo.set-dates", "to do");
const projectSetDates = setDatesSpec("project.set-dates", "project");

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

const headingRename: CommandSpec<"project.rename-heading"> = {
  op: "project.rename-heading",
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

const headingArchive: CommandSpec<"project.archive-heading"> = {
  op: "project.archive-heading",
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

const headingUnarchive: CommandSpec<"project.unarchive-heading"> = {
  op: "project.unarchive-heading",
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

const headingAdd: CommandSpec<"project.add-heading"> = {
  op: "project.add-heading",
  hazards: ["H-UNKNOWN-DESTINATION"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.destProject = resolveProject(db, params.project);
    pre.sameTitleUuids = sameTitleTaskUuids(db, params.title, "heading");
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const project = pre.destProject?.resolved;
    // A new type=2 row with this title under the project; a pre-existing
    // same-title heading is excluded so discovery cannot bind to it.
    return {
      mode: "create",
      probe: {
        title: params.title,
        type: "heading",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
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

/**
 * project.move-heading — within-project heading order, on the ARROW-CHORD ui
 * vector (CHORDMH1, on the HEADORD1 law). Things 3.23 left the private reorder
 * command declared and inert, which took heading order offline entirely; the
 * replacement is the app's own keyboard affordance (⌘↑/⌘↓/⌘⌥↑/⌘⌥↓ on a selected
 * heading row), driven as a verified closed loop by src/write/vectors/ui-chord.ts.
 * This is the ONE reorder that leaves the `privateReorderIsNoOp` range — every
 * other scope still routes through its own gate.
 */
const projectMoveHeading: CommandSpec<"project.move-heading"> = {
  op: "project.move-heading",
  hazards: ["H-UNKNOWN-DESTINATION", "H-HEADING-ORDER", "H-UI-DRIVE"],
  preRead(db, params) {
    const pre = emptyPreState();
    pre.destProject = resolveProject(db, params.project);
    pre.headingMove = computeHeadingMovePre(db, pre.destProject, params.headings, params.placement);
    return pre;
  },
  expectedDelta(pre) {
    const move = pre.headingMove;
    return {
      mode: "ordering",
      key: "index",
      // The full end state: every heading of the project, strictly ascending.
      sequence: move?.targetOrder ?? [],
      // RRF1: the headings the caller did NOT name must hold their EXACT prior
      // rank — a chord is a single-row write, and this is what proves the one
      // that landed was the row the plan addressed (a heading row exposes no
      // title to read the selection back through).
      unchanged: move?.untouched ?? [],
      // Children follow their heading through an intact FK, un-renumbered and
      // un-touched (no userModificationDate bump — that is what `frozen` adds).
      frozen: (move?.children ?? []).map((c) => ({
        uuid: c.uuid,
        assert: [{ field: "heading.uuid", equals: c.heading }],
      })),
      ...(move?.targetOrder[0] !== undefined && { subject: move.targetOrder[0] }),
    };
  },
  compile(params, vector, pre) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    const move = pre.headingMove;
    if (move === null || move.problems.length > 0) {
      // The membership/anchor/archived refusals are surfaced by H-HEADING-ORDER
      // before compile; reaching here with one means the guard was bypassed.
      throw new Error(
        `project.move-heading: ${move === null ? "no heading move computed (guard bypassed?)" : move.problems.join("; ")}`,
      );
    }
    // The movee set is EXACTLY what the caller named — never derived from the
    // untouched set, which fences a different (smaller) thing: a bystander whose
    // POSITION shifts is still a bystander no chord may move.
    return uiDrive(
      moveHeadingChordRecipe(pre.destProject?.resolved?.uuid ?? "", move.targetOrder, [
        ...params.headings,
      ]),
    );
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

// Re-exported so make-repeating-project.ts and existing callers keep importing
// the validator from commands.ts; the implementation + the full combination
// matrix live in repeat-rule.ts.
export { assertRepeatRule };

/**
 * The recipe extras for a MAKE-REPEATING drive: {@link ruleExtras} with the
 * "Next:" drive date deadline-adjusted, exactly as {@link reschedRuleExtras}
 * does for a reschedule.
 *
 * ONE MEANING FOR `next`, ONE PLACE THAT SHIFTS IT (NEXTPOP1). `next` is the
 * requested first-occurrence START — what `--when` means to a caller — in every
 * params bag, at every layer. A DEADLINED rule anchors the dialog on the
 * DEADLINE (YANCH1 #493), so the date the "Next:" control must carry is
 * `next + startDaysEarlier`; that conversion belongs to the compile, where the
 * dialog is, and nowhere else.
 *
 * It used to happen upstream too: the promote orchestrators shifted `next`
 * before handing the bag to this op, so the SAME field meant a START coming from
 * a caller and a DUE date coming from a composite. Everything downstream that
 * shifts — `assessOffRuleFirst`, via `assertRepeatRule` in preRead — then shifted
 * a second time, and a deadlined MONTHLY promote was refused before it ran with
 * a message about a date the caller never asked for (`--deadline 2026-08-20`
 * + `--when 2026-08-06` → "a first occurrence on 2026-08-20 would not hold",
 * measured in-lab). The orchestrators now pass `--when` through unshifted.
 */
function makeRuleExtras(params: RepeatRuleParams): RepeatRuleExtras {
  const base = ruleExtras(params);
  const drive = deadlineDriveNext(params);
  return drive !== undefined ? { ...base, next: drive } : base;
}

/**
 * The extended-vocabulary fields of a rule as a recipe `extras` bag, including
 * ONLY the keys that are present (exactOptionalPropertyTypes: never set an
 * optional field to undefined). A bare `{ uuid, frequency, interval }` yields
 * `{}`, so the recipe drives exactly the certified two-control path.
 *
 * `next` is copied through VERBATIM — a START. Every compile that drives the
 * dialog wraps this with its own deadline shift ({@link makeRuleExtras},
 * {@link reschedRuleExtras}); this function never shifts (NEXTPOP1).
 */
function ruleExtras(params: RepeatRuleParams): RepeatRuleExtras {
  return {
    ...(params.afterCompletion !== undefined && { afterCompletion: params.afterCompletion }),
    ...(params.weekdays !== undefined && { weekdays: params.weekdays }),
    ...(params.monthly !== undefined && { monthly: params.monthly }),
    ...(params.yearly !== undefined && { yearly: params.yearly }),
    ...(params.ends !== undefined && { ends: params.ends }),
    ...(params.reminder !== undefined && { reminder: params.reminder }),
    ...(params.deadline !== undefined && { deadline: params.deadline }),
    ...(params.startDaysEarlier !== undefined && { startDaysEarlier: params.startDaysEarlier }),
    ...(params.next !== undefined && { next: params.next }),
  };
}

/**
 * The reschedule's EFFECTIVE rule params: the requested params PLUS the calendar
 * anchor DERIVED from `--when` when none was given explicitly (YANCH1 #493 — the
 * SAME derive-and-drive make/add-repeating apply upstream in promote-clone.ts).
 * The anchor is derived from the deadline-shifted drive date (`deadlineDriveNext`
 * = when + startDaysEarlier) so a deadlined rule's anchor names the DUE date,
 * exactly as make/add. A rule-only reschedule (no `--when`) or an explicit anchor
 * flag leaves params UNCHANGED (deriveFixedAnchor returns an empty patch).
 *
 * This is the single source of truth used by BOTH the compile (`reschedRuleExtras`
 * → the recipe DRIVES the anchor pop-ups) AND expectedDelta (`expectedRuleAssertions`
 * ASSERTS the same anchor), so the drive vocabulary and the verify vocabulary
 * derive IDENTICALLY. Without it a `--when`-only reschedule left the anchor at the
 * dialog's untouched default (yearly January 1, monthly 1st, weekly Sunday) — the
 * DRIVE never touched the anchor pop-ups while the reschedule silently kept the old
 * placement (the RSPA1 live failure: a yearly `--when`-only reschedule whose anchor
 * was never driven).
 */
function reschedEffParams(params: RepeatRuleParams): RepeatRuleParams {
  return { ...params, ...deriveFixedAnchor(params, deadlineDriveNext(params)) };
}

/**
 * Recipe extras for a RESCHEDULE: the derived-anchor effective params (so the
 * recipe drives the weekly/monthly/yearly anchor pop-ups for a `--when`-only
 * reschedule), with the "Next:" drive date deadline-adjusted (YANCH1 #493) —
 * `--when` is the scheduled START, but a deadlined rule anchors on the DEADLINE,
 * so the dialog's "Next:" field is driven with `when + startDaysEarlier` and the
 * app back-shifts the instance start to `--when`. The expectedDelta keeps the RAW
 * `params.next` (the cursor asserts the START). {@link makeRuleExtras} is the
 * make/add-repeating twin of this — the shift lands in the compile on every verb
 * that drives the dialog, and nowhere upstream of it (NEXTPOP1).
 */
function reschedRuleExtras(params: RepeatRuleParams): RepeatRuleExtras {
  const base = ruleExtras(reschedEffParams(params));
  const drive = deadlineDriveNext(params);
  return drive !== undefined ? { ...base, next: drive } : base;
}

/**
 * The rule-vocabulary keys this reschedule REQUESTED — the input to the
 * unexplained-delta check (CGRD1 guard 3): every decoded-rule field that moves
 * must be attributable to one of these, or to a mapped co-mover of one.
 *
 * Built from the EFFECTIVE params, the same bag the recipe drives, so a
 * `--when`-only reschedule that DERIVES a calendar anchor counts that anchor as
 * requested rather than as an unexplained move (RSPA1 / YANCH1 #493) — the drive
 * really does address those pop-ups. `uuid` is the target, not a rule field.
 */
function requestedRuleKeys(params: RepeatRuleParams): string[] {
  const eff = reschedEffParams(params);
  return Object.entries(eff)
    .filter(([key, value]) => key !== "uuid" && value !== undefined)
    .map(([key]) => key);
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
    pre.sameTitleUuids = sameTitleTaskUuids(db, nonHeadingTitle(pre), "to-do");
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    // Identity REPLACEMENT or preserve-as-instance (UI2-a / RSIM-R): a NEW
    // template row (type=0 with a recurrence rule) is born; the original uuid is
    // EITHER destroyed OR relinked as the current-occurrence instance. Discover
    // the template with the create probe (excluding the pre-existing same-title
    // rows), pick it by asserting it IS a template, then the `repeating` context
    // hardens discovery (restored time-bound, source-fingerprint tiebreak) and
    // derives instance + source fate for the enriched result. `expectedRule`
    // makes the LANDED rule verifiable at FULL fidelity (#491): a template minted
    // with the wrong frequency/interval (the interval-field race, oddities §8l) OR
    // a dropped anchor / ends / deadline becomes a verify-failed:mismatch instead
    // of a silent ok. includeCursor:false — the fresh template's cursor follows
    // the app's spawn law (ANCH1), not the raw --when, so make verifies the rule
    // BLOB + deadline, not the cursor.
    return {
      mode: "create",
      probe: {
        title: nonHeadingTitle(pre),
        type: "to-do",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
        ...(pre.target !== null && {
          repeating: {
            sourceUuid: pre.target.uuid,
            fingerprint: buildRepeatingFingerprint(pre.target),
            expectedRule: expectedRuleAssertions(params, { includeCursor: false }),
          },
        }),
      },
      assert: [{ field: "repeating.isTemplate", equals: true }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(
      makeRepeatingRecipe(params.uuid, params.frequency, params.interval, makeRuleExtras(params)),
    );
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
    // Identity PRESERVED (UI2-b): the same template uuid, rule mutated in place.
    // Assert the FULL requested rule (#491) — type + unit + interval + calendar
    // anchor + ends bound + deadline offset + the ANCH2 first-occurrence cursor —
    // built from the complete vocabulary by expectedRuleAssertions so the pre-drive
    // idempotency check skips ONLY when EVERY requested field already holds, and
    // the post-drive verify catches a wrong-anchor landing. A shallow unit+interval
    // subset false-noop'd a reschedule that changed only the monthly anchor /
    // deadline / ends (#491). ALSO capture the whole prior rule (+ deadline flag)
    // so the undo can re-drive it faithfully. The DERIVED-anchor effective params
    // (reschedEffParams) are asserted — the SAME bag the compile drives — so a
    // `--when`-only reschedule verifies the derived anchor the drive lands (RSPA1).
    const eff = reschedEffParams(params);
    return {
      mode: "update",
      uuid: params.uuid,
      // includeCursor asserts the first-occurrence cursor == --when. For an OFF-RULE
      // first (explicit anchor ≠ --when) the cursor lands on the next RULE-ALIGNED
      // occurrence, not --when (DACON1 cell DC4: --when Oct 16 with an Oct-16 due
      // anchor cursors to the next aligned start, 2029-10-02), so asserting it would
      // false-fail an honored off-rule reschedule — drop the cursor assertion there
      // and verify the rule anchor only.
      assert: expectedRuleAssertions(eff, {
        includeCursor: assessOffRuleFirst(eff)?.kind !== "honored",
      }),
      capture: [{ field: "repeating.rule" }, { field: "repeating.deadlined" }],
      // UNEXPLAINED-DELTA DETECTION (CGRD1 guard 3). The assertions above prove
      // the requested rule landed; this proves nothing ELSE did. A reschedule
      // rewrites an EXISTING rule, so there is a full pre-state to diff against —
      // which is why make-repeating / add-repeating do not carry it: they mint the
      // rule, so every field is new by construction and there is nothing to compare.
      collateral: { requested: requestedRuleKeys(params) },
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(
      rescheduleRepeatRecipe(
        params.uuid,
        params.frequency,
        params.interval,
        reschedRuleExtras(params),
      ),
    );
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

/**
 * `Items ▸ Repeat ▸ Create Next Copy` (CNC1) — materialize the pending
 * occurrence and advance the series. The INTERNAL first leg of the
 * template-mutation composites (template-mutation.ts); it is not a user-facing
 * verb, because a bare "spawn one now" has no use we have been asked for and
 * every honest use of it mutates the row it mints.
 *
 * Verified as a CREATE: the minted row wears the template's own title, is a
 * to-do, carries a fresh (gesture wall-clock) creationDate, and is not one of
 * the rows the series already had — which is exactly the create-probe's
 * gauntlet, and it hands the composite back the minted uuid it needs. The one
 * field assertion is the FK: the discovered row must be an instance of THIS
 * template, so a same-titled row created by anything else in the window cannot
 * pass. The cursor advance is deliberately NOT asserted here — a create delta
 * asserts against the created row, and the composite re-reads the template
 * afterwards anyway to disclose when the next occurrence lands.
 */
const todoCreateNextCopy: CommandSpec<"todo.create-next-copy"> = {
  op: "todo.create-next-copy",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    // The series' existing rows — the template plus every instance it has
    // already spawned, all of which share its title. They are the create
    // probe's exclusion set, so "the new row" is unambiguous even on a series
    // whose occurrences all look alike.
    pre.sameTitleUuids = seriesRowUuids(db, params.uuid);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    const target = pre.target;
    const title = target !== null && target.type !== "heading" ? target.title : "";
    return {
      mode: "create",
      probe: {
        title,
        type: "to-do",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
      assert: [{ field: "repeating.templateUuid", equals: params.uuid }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(createNextCopyRecipe(params.uuid));
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
    // Identity PRESERVED (UIC2-a): same project uuid, rule mutated in place;
    // capture the prior rule (+ deadline flag) for the faithful undo. Assert the
    // FULL requested rule (#491) via expectedRuleAssertions — same completeness as
    // todo.reschedule-repeat (a shallow unit+interval subset false-noop'd an
    // anchor/deadline/ends-only reschedule). The DERIVED-anchor effective params
    // (reschedEffParams) are asserted — the SAME bag the compile drives — so a
    // `--when`-only reschedule verifies the derived anchor the drive lands (RSPA1).
    const eff = reschedEffParams(params);
    return {
      mode: "update",
      uuid: params.uuid,
      // includeCursor asserts the first-occurrence cursor == --when. For an OFF-RULE
      // first (explicit anchor ≠ --when) the cursor lands on the next RULE-ALIGNED
      // occurrence, not --when (DACON1 cell DC4: --when Oct 16 with an Oct-16 due
      // anchor cursors to the next aligned start, 2029-10-02), so asserting it would
      // false-fail an honored off-rule reschedule — drop the cursor assertion there
      // and verify the rule anchor only.
      assert: expectedRuleAssertions(eff, {
        includeCursor: assessOffRuleFirst(eff)?.kind !== "honored",
      }),
      capture: [{ field: "repeating.rule" }, { field: "repeating.deadlined" }],
      // UNEXPLAINED-DELTA DETECTION (CGRD1 guard 3). The assertions above prove
      // the requested rule landed; this proves nothing ELSE did. A reschedule
      // rewrites an EXISTING rule, so there is a full pre-state to diff against —
      // which is why make-repeating / add-repeating do not carry it: they mint the
      // rule, so every field is new by construction and there is nothing to compare.
      collateral: { requested: requestedRuleKeys(params) },
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(
      projectRescheduleRepeatRecipe(
        params.uuid,
        params.frequency,
        params.interval,
        reschedRuleExtras(params),
      ),
    );
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

// project.make-repeating: the pure-AX row-selection op (UIC4). The command
// spec drives the area / someday cases; the area-less-anytime coercion is done
// by the promoteProjectViaGui internal orchestrator BEFORE this spec sees the target,
// so by drive time the taxonomy is always area or someday. A DIRECT dispatch on
// an anytime project is refused by H-PROJECT-REPEAT (with the orchestrator as
// the remediation).
const projectMakeRepeating: CommandSpec<"project.make-repeating"> = {
  op: "project.make-repeating",
  hazards: ["H-UNKNOWN-DESTINATION", "H-PROJECT-REPEAT", "H-UI-DRIVE"],
  preRead(db, params) {
    assertRepeatRule(params);
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    pre.projectRepeat = classifyProjectRepeat(db, pre.target);
    pre.sameTitleUuids = sameTitleTaskUuids(db, nonHeadingTitle(pre), "project");
    if (pre.target !== null) pre.repeatSubtreeUuids = projectSubtreeUuids(db, pre.target.uuid);
    return pre;
  },
  expectedDelta(pre, params, ctx) {
    // Identity REPLACEMENT or preserve-as-instance (UIC4-b / RSIM-R): a NEW
    // template project (with a recurrence rule) is born; the source project is
    // EITHER destroyed OR (when its subtree holds a nested repeater) relinked as
    // the current-occurrence instance. Pick the TEMPLATE by asserting it IS one,
    // excluding pre-existing same-title rows; the `repeating` context hardens
    // discovery and derives instance + source fate + childrenReplaced.
    // `expectedRule` makes the landed rule verifiable at FULL fidelity (#491):
    // a wrong frequency/interval (interval-race §8l) OR a dropped anchor/ends/
    // deadline is a mismatch, not a silent ok. includeCursor:false — the fresh
    // template's cursor follows the ANCH1 spawn law, not the raw --when.
    return {
      mode: "create",
      probe: {
        title: nonHeadingTitle(pre),
        type: "project",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
        ...(pre.target !== null && {
          repeating: {
            sourceUuid: pre.target.uuid,
            fingerprint: buildRepeatingFingerprint(pre.target),
            subtreeUuids: pre.repeatSubtreeUuids ?? [],
            expectedRule: expectedRuleAssertions(params, { includeCursor: false }),
          },
        }),
      },
      assert: [{ field: "repeating.isTemplate", equals: true }],
    };
  },
  compile(params, vector, pre) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    const tax = pre.projectRepeat;
    if (tax === null || tax.kind === "refuse" || tax.kind === "anytime") {
      // Unreachable in practice: the guards block refuse/anytime before compile.
      throw new Error(
        "project.make-repeating: no selectable-row taxonomy resolved (guard bypassed?)",
      );
    }
    return uiDrive(
      projectMakeRepeatingRecipe(
        tax.containerReveal,
        params.uuid,
        tax.title,
        params.frequency,
        params.interval,
        makeRuleExtras(params),
      ),
    );
  },
};

// project.add-repeating is delivered by the runAddRepeatingProject
// orchestrator (project.add THEN project.make-repeating); it has no single
// atomic surface and is never dispatched directly through the pipeline.
const ADD_REPEATING_ORCHESTRATED =
  "project.add-repeating is delivered by the runAddRepeatingProject orchestrator (create " +
  "the project, then promote it to a repeating series); it has no atomic surface and is never " +
  "dispatched directly through the pipeline";

const projectAddRepeating: CommandSpec<"project.add-repeating"> = {
  op: "project.add-repeating",
  hazards: [],
  preRead() {
    return emptyPreState();
  },
  expectedDelta() {
    throw new Error(ADD_REPEATING_ORCHESTRATED);
  },
  compile() {
    throw new Error(ADD_REPEATING_ORCHESTRATED);
  },
};

// todo.add-repeating is delivered by the runAddRepeatingTodo orchestrator
// (todo.add THEN native promote); it has no atomic surface and is never
// dispatched directly through the pipeline (promote-clone.ts).
const TODO_ADD_REPEATING_ORCHESTRATED =
  "todo.add-repeating is delivered by the runAddRepeatingTodo orchestrator (create the to-do, " +
  "then promote it to a repeating series); it has no atomic surface and is never dispatched " +
  "directly through the pipeline";

const todoAddRepeating: CommandSpec<"todo.add-repeating"> = {
  op: "todo.add-repeating",
  hazards: [],
  preRead() {
    return emptyPreState();
  },
  expectedDelta() {
    throw new Error(TODO_ADD_REPEATING_ORCHESTRATED);
  },
  compile() {
    throw new Error(TODO_ADD_REPEATING_ORCHESTRATED);
  },
};

const todoConvertToProject: CommandSpec<"todo.convert-to-project"> = {
  op: "todo.convert-to-project",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    // The new row is a PROJECT (type=1) — exclude pre-existing same-title
    // projects, not the source to-do (a different type the probe never sees).
    pre.sameTitleUuids = sameTitleTaskUuids(db, nonHeadingTitle(pre), "project");
    return pre;
  },
  expectedDelta(pre, _params, ctx) {
    // Identity REPLACEMENT (UI2-d): the to-do uuid dies; a NEW type=1 project
    // is born, notes preserved. Discover it (its uuid is returned).
    const target = pre.target;
    const notes = target !== null && target.type !== "heading" ? target.notes : "";
    return {
      mode: "create",
      probe: {
        title: nonHeadingTitle(pre),
        type: "project",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
      assert: [{ field: "notes", equals: notes }],
    };
  },
  compile(params, vector) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    return uiDrive(convertToProjectRecipe("todo.convert-to-project", params.uuid));
  },
};

const headingConvertToProject: CommandSpec<"project.promote-heading"> = {
  op: "project.promote-heading",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    // The new row is a PROJECT (type=1) carrying the former heading's title;
    // exclude pre-existing same-title projects. The heading uses its raw title
    // (headings are not covered by nonHeadingTitle).
    const title = pre.target !== null ? pre.target.title : "";
    pre.sameTitleUuids = sameTitleTaskUuids(db, title, "project");
    pre.headingConvert = classifyHeadingConvert(db, pre.target);
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
      probe: {
        title,
        type: "project",
        sinceEpoch: ctx.nowEpoch - 2,
        excludeUuids: pre.sameTitleUuids,
      },
      assert: [],
    };
  },
  compile(_params, vector, pre) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    const tax = pre.headingConvert;
    if (tax === null || tax.kind === "refuse") {
      // H-UNKNOWN-DESTINATION blocks a non-heading target before compile; a
      // refuse here means a parentless heading (or one absent from its project's
      // heading set) slipped past — fail loud rather than drive the wrong row.
      throw new Error(
        `project.promote-heading: ${tax?.kind === "refuse" ? tax.detail : "no heading taxonomy resolved (guard bypassed?)"}`,
      );
    }
    return uiDrive(headingConvertToProjectRecipe(tax.projectReveal, tax.ordinal));
  },
};

const projectMoveHeadingToProject: CommandSpec<"project.move-heading-to-project"> = {
  op: "project.move-heading-to-project",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.headingMoveToProject = classifyHeadingMoveToProject(
      db,
      params.project,
      params.heading,
      params.toProject,
    );
    if (pre.headingMoveToProject.kind === "ok") {
      // Load the heading row so the verify oracle reads its (post-op) project FK.
      pre.target = loadTarget(db, pre.headingMoveToProject.pre.headingUuid);
    }
    return pre;
  },
  expectedDelta(pre) {
    // HEADXPROJ: a single-row change — the heading's `project` FK becomes the
    // destination; its children follow via their intact heading FK (no child
    // rewrite, no index churn), so no per-child assertion is needed.
    const tax = pre.headingMoveToProject;
    const headingUuid = tax?.kind === "ok" ? tax.pre.headingUuid : "";
    const destUuid = tax?.kind === "ok" ? tax.pre.destProjectUuid : "";
    return {
      mode: "update",
      uuid: headingUuid,
      assert: [{ field: "project.uuid", equals: destUuid }],
    };
  },
  compile(_params, vector, pre) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    const tax = pre.headingMoveToProject;
    if (tax === null || tax.kind === "refuse") {
      // The taxonomy refusals are surfaced by H-UNKNOWN-DESTINATION before
      // compile; reaching here with one means the guard was bypassed.
      throw new Error(
        `project.move-heading-to-project: ${tax?.kind === "refuse" ? tax.detail : "no taxonomy resolved (guard bypassed?)"}`,
      );
    }
    return uiDrive(
      moveHeadingToProjectRecipe(
        tax.pre.sourceProjectUuid,
        tax.pre.headingTitle,
        tax.pre.destProjectTitle,
      ),
    );
  },
};

const projectDissolveHeading: CommandSpec<"project.dissolve-heading"> = {
  op: "project.dissolve-heading",
  hazards: UI_HAZARDS,
  preRead(db, params) {
    const pre = emptyPreState();
    pre.target = loadTarget(db, params.uuid);
    pre.headingDissolve = classifyHeadingDissolve(db, pre.target);
    return pre;
  },
  expectedDelta(_pre, params) {
    // DISS1: the heading row is HARD-DELETED (removed from TMTask) while its
    // children become direct project children. The verify oracle is the heading
    // GONE — its children re-home is the DISS1-locked invariant, checked by the
    // op's tests (a childless heading dissolve verifies identically).
    return { mode: "gone", entity: "task", uuid: params.uuid };
  },
  compile(_params, vector, pre) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    const tax = pre.headingDissolve;
    if (tax === null || tax.kind === "refuse") {
      // The taxonomy refusals are surfaced by H-UNKNOWN-DESTINATION before
      // compile; reaching here with one means the guard was bypassed.
      throw new Error(
        `project.dissolve-heading: ${tax?.kind === "refuse" ? tax.detail : "no taxonomy resolved (guard bypassed?)"}`,
      );
    }
    return uiDrive(dissolveHeadingRecipe(tax.pre.projectReveal, tax.pre.headingTitle));
  },
};

// -------------------------------------------------- sidebar AREA reorder

/** The compile-time placement for area.reorder (resolved refs). */
function sidebarPlacementOf(
  params: { before?: string; after?: string; position?: "first" | "last" },
  pre: PreState,
): SidebarPlacement {
  const ref = pre.destArea?.resolved;
  if (params.before !== undefined && ref != null) {
    return { kind: "before", uuid: ref.uuid, title: ref.title };
  }
  if (params.after !== undefined && ref != null) {
    return { kind: "after", uuid: ref.uuid, title: ref.title };
  }
  return { kind: params.position === "first" ? "first" : "last" };
}

const areaReorderSidebar: CommandSpec<"area.reorder"> = {
  op: "area.reorder",
  hazards: ["H-UNKNOWN-DESTINATION", "H-UI-DRIVE"],
  preRead(db, params) {
    const destinations = [params.before, params.after, params.position].filter(
      (d) => d !== undefined,
    );
    if (destinations.length !== 1) {
      throw new RangeError(
        "pass exactly one destination: before, after, or position (first | last)",
      );
    }
    if (
      params.position !== undefined &&
      params.position !== "first" &&
      params.position !== "last"
    ) {
      throw new RangeError(`invalid position "${params.position}" — expected first | last`);
    }
    // The reserved `loose` pseudo-area ref (the derived area-less view) has no
    // sidebar row, so it can be neither moved nor an anchor — refuse it by name
    // with a specific message rather than a generic no-such-area error, matching
    // the loose-pseudo-area write-refusal pattern (src/read/pseudo-area.ts).
    for (const ref of [params.target, params.before, params.after]) {
      if (ref !== undefined && isLooseRef(ref)) {
        throw new RangeError(
          "the loose pseudo-area is a derived view — it has no sidebar row and cannot be " +
            "reordered",
        );
      }
    }
    const pre = emptyPreState();
    pre.entityTarget = resolveArea(db, { uuid: params.target, title: params.target });
    const ref = params.before ?? params.after;
    if (ref !== undefined) pre.destArea = resolveArea(db, { uuid: ref, title: ref });
    const target = pre.entityTarget.resolved;
    const dest = pre.destArea?.resolved;
    if (target != null && dest != null && target.uuid === dest.uuid) {
      throw new RangeError("the destination area is the area being moved");
    }
    // The sidebar drag addresses rows by their VISIBLE NAME. A DUPLICATE area
    // title is now handled by positional disambiguation in the ui-vector driver
    // (ORDFIN2 AXDRAG3: the intended uuid's Nth same-titled row is grabbed by the
    // `(index, uuid)` ASC law, and the post-gesture DB assert + self-invert catch
    // a wrong grab) — so a uuid-targeted ref whose title is shared is NO LONGER
    // refused here. A duplicate NAME ref stays refused upstream (resolveArea
    // returns the ambiguity candidates). Only a SANITY CAP remains: too many
    // same-titled rows could make the positional grab loop unreliable, so refuse
    // rather than churn. (WIRED — lab-cert pending an AXDRAG4 VM sitting.)
    const SAME_TITLE_CAP = 8;
    for (const area of [target, dest]) {
      if (area == null) continue;
      const dup = db
        .prepare("SELECT COUNT(*) AS n FROM TMArea WHERE title = ? COLLATE NOCASE")
        .get(area.title) as { n: number };
      if (dup.n > SAME_TITLE_CAP) {
        throw new RangeError(
          `area title "${area.title}" is shared by ${dup.n} areas (over the ${SAME_TITLE_CAP}-row ` +
            "positional-disambiguation cap) — rename some, or reorder by a uniquely-titled anchor",
        );
      }
    }
    pre.areaOrder = (
      db.prepare(`SELECT uuid FROM TMArea ORDER BY "index", uuid`).all() as unknown as {
        uuid: string;
      }[]
    ).map((r) => r.uuid);
    return pre;
  },
  expectedDelta(pre, params) {
    const target = pre.entityTarget?.resolved?.uuid ?? "";
    const order = (pre.areaOrder ?? []).filter((u) => u !== target);
    const refUuid = pre.destArea?.resolved?.uuid;
    // Assert the implicated RELATIVE pair (index VALUES are never asserted —
    // a drag may renumber a neighbor, AXDRAG1-a); capture the FULL pre-order
    // for undo.
    let sequence: string[];
    if (params.before !== undefined && refUuid !== undefined) {
      sequence = [target, refUuid];
    } else if (params.after !== undefined && refUuid !== undefined) {
      sequence = [refUuid, target];
    } else if (params.position === "first") {
      const first = order[0];
      sequence = first === undefined ? [target] : [target, first];
    } else {
      const last = order.at(-1);
      sequence = last === undefined ? [target] : [last, target];
    }
    return {
      mode: "ordering",
      key: "area-index",
      sequence,
      capture: pre.areaOrder ?? sequence,
      subject: target,
    };
  },
  compile(params, vector, pre) {
    if (vector !== "ui") unsupportedVector(this.op, vector);
    const target = pre.entityTarget?.resolved;
    return uiDrive(
      areaReorderSidebarRecipe(
        { uuid: target?.uuid ?? "", title: target?.title ?? "" },
        sidebarPlacementOf(params, pre),
      ),
    );
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

const logNow: CommandSpec<"log-now"> = {
  op: "log-now",
  hazards: [],
  preRead(db, _params, now, zone) {
    const pre = emptyPreState();
    // The resolved-but-unlogged census the verb will move (the disclosed count),
    // and the pre-op boundary stamp the delta compares against.
    pre.logNow = {
      pending: pendingLogCount(db, now, zone),
      manualLogDatePre: manualLogDateEpoch(db),
    };
    return pre;
  },
  expectedDelta(pre) {
    const ln = pre.logNow ?? { pending: 0, manualLogDatePre: null };
    return { mode: "logged-now", pending: ln.pending, manualLogDatePre: ln.manualLogDatePre };
  },
  compile(_params, vector) {
    if (vector !== "applescript") unsupportedVector(this.op, vector);
    return osa("log completed now");
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
  "project.add-heading": headingAdd,
  "project.rename-heading": headingRename,
  "project.archive-heading": headingArchive,
  "project.unarchive-heading": headingUnarchive,
  "project.promote-heading": headingConvertToProject,
  "project.move-heading": projectMoveHeading,
  "project.move-heading-to-project": projectMoveHeadingToProject,
  "project.dissolve-heading": projectDissolveHeading,
  "todo.clear-dated-reminder": todoClearDatedReminder,
  "todo.make-repeating": todoMakeRepeating,
  "todo.reschedule-repeat": todoRescheduleRepeat,
  "todo.pause-repeat": todoPauseRepeat,
  "todo.create-next-copy": todoCreateNextCopy,
  "todo.resume-repeat": todoResumeRepeat,
  "todo.convert-to-project": todoConvertToProject,
  "project.reschedule-repeat": projectRescheduleRepeat,
  "project.pause-repeat": projectPauseRepeat,
  "project.resume-repeat": projectResumeRepeat,
  "todo.set-dates": todoSetDates,
  "project.set-dates": projectSetDates,
  "area.reorder": areaReorderSidebar,
  "project.make-repeating": projectMakeRepeating,
  "project.add-repeating": projectAddRepeating,
  "todo.add-repeating": todoAddRepeating,
  "todo.clone": todoClone,
  "project.clone": projectClone,
  "log-now": logNow,
};
