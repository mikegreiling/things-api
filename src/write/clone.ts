/**
 * todo.clone / project.clone orchestrators (CLONE verdict-A fidelity matrix,
 * docs/lab/clone-fidelity-and-template-trash.md; direction ratified in
 * docs/design/promote-via-clone.md §2).
 *
 * A clone is a faithful CONTENT copy of an existing item through official write
 * surfaces — a NEW capture (new uuid, born now, landing at its container's native
 * position, no implicit reorder). Delivered as a compound over ordinary cataloged
 * legs:
 *
 *   - the base create (todo.add / project.add via json import — headings + headed
 *     and root children in one payload, A4), children born OPEN;
 *   - a checklist follow-up leg reproducing pre-checked items (json replace, P18);
 *   - terminal-state legs reproducing logged/canceled children AND the item's own
 *     completed/canceled state with the EXACT stopDate (complete/cancel +
 *     set-dates backdate, A5/A7);
 *   - `--preserve-created` backdates the copy's creationDate (minute resolution).
 *
 * The legs are grouped under one txn; the SUMMARY record (op todo.clone /
 * project.clone) is the single undoable unit, and its inverse is trashing the
 * minted clone (undo.ts). The individual legs are `leg`-role records, excluded
 * from independent undo.
 *
 * Refusals (fail-closed): a trashed source (restore it first), a repeating
 * template source (its rt1_recurrenceRule is settable only via the make-repeating
 * GUI, which mints a NEW series identity — a faithful copy is impossible), and —
 * for a project — a subtree holding a LIVE nested repeating template (named in the
 * refusal, A6).
 */
import type { DatabaseSync } from "node:sqlite";

import type { AuditRecord } from "../audit/schema.ts";
import type { ReminderTime } from "../model/dates.ts";
import type { Todo } from "../model/entities.ts";
import { byUuid } from "../read/detail.ts";
import { projectChildren } from "./pre-state.ts";
import { projectView } from "../read/project-view.ts";
import { resolveProjectWriteTarget, resolveTaskUuidPrefix } from "../read/queries.ts";
import { entityStage, entityWhen } from "../read/stage.ts";
import type { CloneParams, OperationKind, ProjectItemSpec, WhenValue } from "./operations.ts";
import { cloneTemplateViaRepromote } from "./promote-clone.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import type { DeltaSpec } from "./verify/delta.ts";

type CloneOp = "todo.clone" | "project.clone";
type LegVector = "url-scheme" | "applescript";

// --------------------------------------------------------------- small helpers

function newTxnId(now: Date): string {
  return `txn-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

function legOptions(
  base: WriteOptions,
  txnId: string,
  vector: LegVector,
  extra?: Partial<WriteOptions>,
): WriteOptions {
  const out: WriteOptions = { txn: { id: txnId, role: "leg" }, vector, ...extra };
  if (base.actor !== undefined) out.actor = base.actor;
  if (base.verifyTimeoutMs !== undefined) out.verifyTimeoutMs = base.verifyTimeoutMs;
  if (base.maxDisruption !== undefined) out.maxDisruption = base.maxDisruption;
  if (base.zone !== undefined) out.zone = base.zone;
  return out;
}

function blocked(op: CloneOp, detail: string, remediation: string): MutationResult {
  return { kind: "blocked", op, reason: "hazard", hazard: "H-CLONE-SOURCE", detail, remediation };
}

/** A create-mode delta for the dry-run plan (verification proper rides each leg). */
function createDelta(title: string, type: "to-do" | "project"): DeltaSpec {
  return { mode: "create", probe: { title, type, sinceEpoch: 0 }, assert: [] };
}

/**
 * Format an instant as a wall-clock `YYYY-MM-DDTHH:mm` in the effective zone
 * (MINUTE resolution — the disclosed precision) so the resolution-timestamp path
 * (`resolveResolutionInstant`, which reads a datetime as wall-clock IN the zone)
 * reconstructs the same instant. Zone undefined = the app-host zone.
 */
function localMinute(instant: Date, zone: string | undefined): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      ...(zone !== undefined && { timeZone: zone }),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

/** The real deadline, or undefined for a null / template-sentinel value. */
function realDeadline(deadline: string | null): string | undefined {
  return deadline !== null && deadline < "4000" ? deadline : undefined;
}

/** The `when` to reproduce for an OPEN item (someday is a stage, not a `when`). */
function scheduleWhen(item: Todo): WhenValue | undefined {
  if (entityStage(item) === "someday") return "someday";
  return entityWhen(item) as WhenValue | undefined;
}

function isDatedWhen(when: WhenValue | undefined): boolean {
  return (
    when === "today" ||
    when === "evening" ||
    (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when))
  );
}

/**
 * The item reminder to reproduce on an OPEN, dated source — the `when` it must be
 * re-supplied with (a reminder requires a schedulable `when` in the same call,
 * H-REMINDER-SCOPE) and the `HH:mm` byte. `undefined` when there is nothing to
 * reproduce (resolved item, undated `when`, or no reminder). This is the same
 * predicate {@link todoAddParams} uses to decide whether the base add carries a
 * reminder — factored out so the caller can sequence it into a SEPARATE leg when
 * it would otherwise collide with a backdated `createdAt` (see runCloneTodo).
 */
function reproducibleReminder(src: Todo): { when: WhenValue; reminder: ReminderTime } | undefined {
  if (src.status !== "open") return undefined;
  const when = scheduleWhen(src);
  if (!isDatedWhen(when) || when === undefined || src.derived.reminder === null) return undefined;
  return { when, reminder: src.derived.reminder };
}

// ------------------------------------------------------------------ leg runner

interface LegRun {
  result: MutationResult;
  describe: string;
}

/** Run one cataloged leg; carries a human describe for disclosure/recovery. */
async function runLeg(
  deps: WriteDeps,
  op: OperationKind,
  params: Record<string, unknown>,
  options: WriteOptions,
  describe: string,
): Promise<LegRun> {
  const result = await runMutation(deps, op, params as never, options);
  return { result, describe };
}

/** A leg that did not verify: honest recovery report naming the minted clone. */
function legFailure(
  op: CloneOp,
  cloneUuid: string,
  legs: string[],
  failed: LegRun,
  finalDelta: DeltaSpec,
): MutationResult {
  const r = failed.result;
  return {
    kind: "verify-failed",
    op,
    reason: r.kind === "verify-failed" ? r.reason : "mismatch",
    expected: finalDelta,
    observed: r.kind === "verify-failed" ? r.observed : null,
    detail:
      `the clone was created (uuid ${cloneUuid}) but a follow-up leg failed — ${failed.describe}: ` +
      `${r.kind === "blocked" ? r.detail : "did not verify"}. Applied so far: ` +
      `${legs.join("; ") || "the base copy only"}. Trash the partial clone with ` +
      `${op === "project.clone" ? "`things project delete`" : "`things todo delete`"} ${cloneUuid} and retry`,
  };
}

// ------------------------------------------------------------------ audit tail

function appendSummary(
  deps: WriteDeps,
  args: {
    startedAt: Date;
    op: CloneOp;
    uuid: string;
    source: string;
    mintedChildren: string[];
    txnId: string;
    invocation: string;
    /** "summary" for a standalone clone; "leg" when EMBEDDED as one leg of a
     * larger compound (promote-via-clone) — a leg is excluded from independent
     * undo, so the parent's summary is the single undoable unit. */
    role?: "summary" | "leg";
  },
): void {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: args.op,
    uuid: args.uuid,
    vector: "url-scheme",
    disruption: 0,
    invocation: args.invocation,
    requested: { source: args.source, mintedChildren: args.mintedChildren },
    txn: { id: args.txnId, role: args.role ?? "summary" },
    pre: null,
    observed: { uuid: args.uuid, mintedChildren: args.mintedChildren },
    result: "ok",
    verify: null,
    durationMs: (deps.now?.() ?? new Date()).getTime() - args.startedAt.getTime(),
    env: {
      pkg: deps.pkgVersion ?? "0.0.1",
      dbVersion: fp.observation.databaseVersion,
      fingerprint: fingerprintLabel(fp, deps.config),
    },
  };
  deps.audit.append(record);
}

// ============================================================== todo.clone

/**
 * The base `todo.add` params reproducing a source to-do's content (born OPEN).
 * `omitReminder` drops the reproduced reminder from THIS add — used when the copy
 * also backdates its creation (`--preserve-created`), because a single add cannot
 * carry both `reminder` and `createdAt` (the json import forbids it,
 * commands.ts assertAddTimestamps); the caller then reproduces the reminder in a
 * separate `todo.update` leg.
 */
function todoAddParams(
  src: Todo,
  title: string,
  preserveCreated: boolean,
  zone: string | undefined,
  omitReminder: boolean,
  templateContent: boolean,
): Record<string, unknown> {
  const resolved = src.status !== "open";
  // A TEMPLATE cloned as plain content carries NO schedule/reminder — the
  // recurrence (and the "starting" date) come from the promote leg that follows,
  // so the plain clone is born unscheduled (from-scratch add-repeating semantics).
  const when = resolved || templateContent ? undefined : scheduleWhen(src);
  const reminder =
    !omitReminder &&
    !templateContent &&
    !resolved &&
    isDatedWhen(when) &&
    src.derived.reminder !== null
      ? src.derived.reminder
      : undefined;
  const deadline = realDeadline(src.deadline);
  const checklist = src.checklist ?? [];
  const anyChecked = checklist.some((c) => c.status === "completed");
  // Birth checklist titles here ONLY when nothing is checked; a checklist with
  // checked items is (re)born pre-checked by the follow-up replace leg (P18).
  const checklistTitles =
    checklist.length > 0 && !anyChecked ? checklist.map((c) => c.title) : undefined;

  const container: Record<string, unknown> = {};
  if (src.heading !== null && src.headingProject !== undefined) {
    container["project"] = { uuid: src.headingProject.uuid };
    container["heading"] = src.heading.title;
  } else if (src.project !== null) {
    container["project"] = { uuid: src.project.uuid };
  } else if (src.area !== null) {
    container["area"] = { uuid: src.area.uuid };
  }

  return {
    title,
    ...(src.notes !== "" && { notes: src.notes }),
    ...(src.tags.length > 0 && { tags: src.tags.map((t) => t.title) }),
    ...(when !== undefined && { when }),
    ...(reminder !== undefined && { reminder }),
    ...(deadline !== undefined && { deadline }),
    ...(checklistTitles !== undefined && { checklistItems: checklistTitles }),
    ...container,
    ...(preserveCreated && { createdAt: localMinute(src.created, zone) }),
  };
}

export async function runCloneTodo(
  deps: WriteDeps,
  params: CloneParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const srcUuid = resolveTaskUuidPrefix(deps.db, params.uuid, "to-do");
  const src = byUuid(deps.db, srcUuid, deps.now?.() ?? new Date(), deps.zone);
  if (src === null || src.type !== "to-do") {
    return blocked(
      "todo.clone",
      "the source is not a to-do (todo.clone copies a to-do)",
      "verify the uuid with `things show <uuid>`, or use `things project clone` for a project",
    );
  }
  if (src.derived.trashed) {
    return blocked(
      "todo.clone",
      "the source to-do is in the Trash — a trashed item cannot be cloned",
      "restore it first with `things todo restore <uuid>`, then clone",
    );
  }
  if (src.repeating.isTemplate && options.cloneTemplateAsPlain !== true) {
    // Cloning a repeating template = clone its content as a PLAIN item, then
    // native-promote the clone with the SOURCE's decoded rule (a NEW series
    // identity; no instances cloned). The compound sets cloneTemplateAsPlain on
    // the embedded clone leg to reach the plain-content path below.
    return cloneTemplateViaRepromote(deps, "todo", src, srcUuid, params, options);
  }
  const templateContent = src.repeating.isTemplate; // reached only in plain mode

  const title = params.title ?? src.title;
  const preserveCreated = params.preserveCreated === true;
  const zone = options.zone ?? deps.zone;
  const finalDelta = createDelta(title, "to-do");
  // A reminder + a backdated creationDate cannot ride ONE add (the json import
  // forbids the pair, commands.ts assertAddTimestamps). When both apply, the
  // base add carries createdAt only and the reminder is reproduced in a
  // follow-up `todo.update` leg (still inside the clone txn).
  const reminderSplit = preserveCreated && !templateContent ? reproducibleReminder(src) : undefined;

  if (options.dryRun === true) {
    const checklist = src.checklist ?? [];
    const steps = [
      "todo.add (title, notes, tags, when" +
        (reminderSplit === undefined ? ", reminder" : "") +
        ", deadline, checklist, container" +
        (preserveCreated ? ", created-at" : "") +
        ")",
      ...(reminderSplit !== undefined ? ["todo.update (reproduce reminder)"] : []),
      ...(checklist.some((c) => c.status === "completed")
        ? ["todo.replace-checklist (reproduce checked items)"]
        : []),
      ...(src.status === "completed"
        ? ["todo.complete + set-dates (reproduce logged state + stopDate)"]
        : src.status === "canceled"
          ? ["todo.complete + set-dates + cancel (reproduce canceled state + stopDate)"]
          : []),
    ];
    return {
      kind: "dry-run",
      op: "todo.clone",
      plan: {
        op: "todo.clone",
        vector: "url-scheme",
        tier: 0,
        invocation: `${steps.length}-leg clone (not atomic): ${steps.join(" → ")}`,
        expectedDelta: finalDelta,
        hazardsChecked: ["H-CLONE-SOURCE"],
      },
    };
  }

  const startedAt = deps.now?.() ?? new Date();
  // Embedded (promote-via-clone): when the caller passes a leg-role txn, share
  // its id and record THIS clone's summary as a leg (subsumed by the parent).
  const embedded = options.txn?.role === "leg";
  const txnId = options.txn?.id ?? newTxnId(startedAt);
  const applied: string[] = [];

  const add = await runLeg(
    deps,
    "todo.add",
    todoAddParams(src, title, preserveCreated, zone, reminderSplit !== undefined, templateContent),
    legOptions(options, txnId, "url-scheme"),
    "copy content",
  );
  if (add.result.kind !== "ok" || add.result.uuid === null) {
    if (add.result.kind === "blocked" || add.result.kind === "verify-failed") return add.result;
    return {
      kind: "verify-failed",
      op: "todo.clone",
      reason: "mismatch",
      expected: finalDelta,
      observed: null,
      detail: "the clone was created but its uuid was not discovered",
    };
  }
  const cloneUuid = add.result.uuid;
  applied.push("copied content");
  const baseVector = add.result.vector;
  const baseTier = add.result.tier;

  // Reminder follow-up (only when it was split off the base add for a backdated
  // creation): re-supply the source `when` together with the reminder so the
  // R-suite guard (H-REMINDER-SCOPE) accepts it. The CLONE campaign proved a
  // when+reminder leg reproduces an item reminder faithfully.
  if (reminderSplit !== undefined) {
    const leg = await runLeg(
      deps,
      "todo.update",
      { uuid: cloneUuid, when: reminderSplit.when, reminder: reminderSplit.reminder },
      legOptions(options, txnId, "url-scheme"),
      "reproduce reminder",
    );
    if (leg.result.kind !== "ok")
      return legFailure("todo.clone", cloneUuid, applied, leg, finalDelta);
    applied.push("reproduced reminder");
  }

  // Checked checklist items → one json replace leg (P18).
  const checklist = src.checklist ?? [];
  if (checklist.some((c) => c.status === "completed")) {
    const items = checklist.map((c) => ({ title: c.title, completed: c.status === "completed" }));
    const leg = await runLeg(
      deps,
      "todo.replace-checklist",
      { uuid: cloneUuid, items },
      legOptions(options, txnId, "url-scheme", { acknowledgeChecklistReset: true }),
      "reproduce checked checklist items",
    );
    if (leg.result.kind !== "ok")
      return legFailure("todo.clone", cloneUuid, applied, leg, finalDelta);
    applied.push("reproduced checked checklist items");
  }

  // Terminal state of the item itself (exact stopDate).
  for (const leg of terminalLegs("todo", cloneUuid, src.status, src.stopped, zone)) {
    const run = await runLeg(
      deps,
      leg.op,
      leg.params,
      legOptions(options, txnId, leg.vector),
      leg.describe,
    );
    if (run.result.kind !== "ok")
      return legFailure("todo.clone", cloneUuid, applied, run, finalDelta);
    applied.push(leg.describe);
  }

  appendSummary(deps, {
    startedAt,
    op: "todo.clone",
    uuid: cloneUuid,
    source: srcUuid,
    mintedChildren: [],
    txnId,
    role: embedded ? "leg" : "summary",
    invocation: `todo.clone ${srcUuid} → ${cloneUuid} (${applied.length} legs)`,
  });

  return cloneOk(
    "todo.clone",
    cloneUuid,
    title,
    baseVector,
    baseTier,
    txnId,
    applied,
    preserveCreated,
  );
}

// ============================================================== project.clone

/**
 * Build the ordered {@link ProjectItemSpec} list for a project clone's base json
 * import — root children first (A4 positional inheritance), then each heading
 * followed by its children — AND the parallel source-child list (in the SAME
 * order) the terminal-state follow-up walks. Children are born OPEN. Templates are
 * excluded (a nested template refuses the whole clone before we get here).
 */
function projectStructure(
  db: DatabaseSync,
  projectUuid: string,
  now: Date,
  zone: string | undefined,
): { items: ProjectItemSpec[]; sourceChildren: Todo[]; headingTitles: string[] } {
  const view = projectView(db, projectUuid, now, {}, zone);
  const items: ProjectItemSpec[] = [];
  const sourceChildren: Todo[] = [];
  const headingTitles: string[] = [];
  const pushChild = (child: Todo): void => {
    if (child.repeating.isTemplate) return; // never in the clone (refused upstream)
    items.push({ kind: "to-do", ...childSpec(child) });
    sourceChildren.push(child);
  };
  for (const child of view.bodyChildren) pushChild(child);
  for (const hc of view.headingContainers) {
    items.push({ kind: "heading", title: hc.heading.title });
    headingTitles.push(hc.heading.title);
    for (const child of hc.children) pushChild(child);
  }
  return { items, sourceChildren, headingTitles };
}

/** One child's born-OPEN content spec (checklist titles only; checked state is a residual). */
function childSpec(child: Todo): {
  title: string;
  notes?: string;
  when?: WhenValue;
  deadline?: string;
  tags?: string[];
  checklistItems?: string[];
} {
  const when = child.status === "open" ? scheduleWhen(child) : undefined;
  const deadline = realDeadline(child.deadline);
  const checklist = child.checklist ?? [];
  return {
    title: child.title,
    ...(child.notes !== "" && { notes: child.notes }),
    ...(when !== undefined && { when }),
    ...(deadline !== undefined && { deadline }),
    ...(child.tags.length > 0 && { tags: child.tags.map((t) => t.title) }),
    ...(checklist.length > 0 && { checklistItems: checklist.map((c) => c.title) }),
  };
}

export async function runCloneProject(
  deps: WriteDeps,
  params: CloneParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const now = deps.now?.() ?? new Date();
  const srcUuid = resolveProjectWriteTarget(deps.db, params.uuid);
  const src = byUuid(deps.db, srcUuid, now, deps.zone);
  if (src === null || src.type !== "project") {
    return blocked(
      "project.clone",
      "the source is not a project (project.clone copies a project)",
      "verify the uuid with `things projects`, or use `things todo clone` for a to-do",
    );
  }
  if (src.derived.trashed) {
    return blocked(
      "project.clone",
      "the source project is in the Trash — a trashed item cannot be cloned",
      "restore it first with `things project restore <uuid>`, then clone",
    );
  }
  if (src.repeating.isTemplate && options.cloneTemplateAsPlain !== true) {
    // Cloning a repeating template = clone its content (incl. child/heading
    // structure) as a PLAIN project, then native-promote the clone with the
    // SOURCE's decoded rule. The nested-repeater refusal below still fires on the
    // embedded plain-clone leg (a template CONTAINING a nested repeater is
    // unclonable — this change is about the template AS the source).
    return cloneTemplateViaRepromote(deps, "project", src, srcUuid, params, options);
  }
  // A6: a live nested repeating template inside the subtree is UNCLONABLE.
  const nestedTemplate = projectChildren(deps.db, srcUuid).find((c) => c.repeating.isTemplate);
  if (nestedTemplate !== undefined) {
    return blocked(
      "project.clone",
      `this project contains a nested repeating template ("${nestedTemplate.title}"); its ` +
        "recurrence rule cannot be reproduced on any official write surface, so the project " +
        "cannot be faithfully cloned",
      "remove or promote the nested repeater out of the project first, then clone (or duplicate " +
        "the project in the Things app, which the app does natively)",
    );
  }

  const title = params.title ?? src.title;
  const preserveCreated = params.preserveCreated === true;
  const zone = options.zone ?? deps.zone;
  const finalDelta = createDelta(title, "project");
  const { items, sourceChildren, headingTitles } = projectStructure(
    deps.db,
    srcUuid,
    now,
    deps.zone,
  );
  const resolvedChildren = sourceChildren.filter((c) => c.status !== "open");

  if (options.dryRun === true) {
    const steps = [
      `project.add (json import: ${headingTitles.length} heading(s), ${sourceChildren.length} ` +
        `child(ren), area/notes/deadline${preserveCreated ? "/created-at" : ""})`,
      ...(resolvedChildren.length > 0
        ? [`${resolvedChildren.length} child terminal-state leg(s) (complete/cancel + stopDate)`]
        : []),
      ...(src.status !== "open" ? [`resolve the project itself (${src.status} + stopDate)`] : []),
    ];
    return {
      kind: "dry-run",
      op: "project.clone",
      plan: {
        op: "project.clone",
        vector: "url-scheme",
        tier: 0,
        invocation: `${steps.length}-leg clone (not atomic): ${steps.join(" → ")}`,
        expectedDelta: finalDelta,
        hazardsChecked: ["H-CLONE-SOURCE"],
      },
    };
  }

  const startedAt = now;
  const embedded = options.txn?.role === "leg";
  const txnId = options.txn?.id ?? newTxnId(startedAt);
  const applied: string[] = [];

  const addParams: Record<string, unknown> = {
    title,
    ...(src.notes !== "" && { notes: src.notes }),
    ...(src.area !== null && { area: { uuid: src.area.uuid } }),
    ...(realDeadline(src.deadline) !== undefined && { deadline: realDeadline(src.deadline) }),
    ...(items.length > 0 && { items }),
    ...(preserveCreated && { createdAt: localMinute(src.created, zone) }),
  };
  const add = await runLeg(
    deps,
    "project.add",
    addParams,
    legOptions(options, txnId, "url-scheme"),
    "copy project structure",
  );
  if (add.result.kind !== "ok" || add.result.uuid === null) {
    if (add.result.kind === "blocked" || add.result.kind === "verify-failed") return add.result;
    return {
      kind: "verify-failed",
      op: "project.clone",
      reason: "mismatch",
      expected: finalDelta,
      observed: null,
      detail: "the project clone was created but its uuid was not discovered",
    };
  }
  const cloneUuid = add.result.uuid;
  applied.push("copied structure");
  const baseVector = add.result.vector;
  const baseTier = add.result.tier;

  // Map the clone's freshly-minted children to their source counterparts by the
  // preserved index order, so terminal-state legs target the right rows.
  const cloneView = projectView(deps.db, cloneUuid, now, {}, deps.zone);
  const cloneChildren: Todo[] = [
    ...cloneView.bodyChildren.filter((c) => !c.repeating.isTemplate),
    ...cloneView.headingContainers.flatMap((hc) =>
      hc.children.filter((c) => !c.repeating.isTemplate),
    ),
  ];
  const mintedChildren = cloneChildren.map((c) => c.uuid);
  const warnings: string[] = [];

  if (cloneChildren.length !== sourceChildren.length) {
    warnings.push(
      "the clone's child set did not match the source one-for-one — logged/canceled child states " +
        "were NOT reproduced (the copy is otherwise faithful)",
    );
  } else {
    for (let i = 0; i < sourceChildren.length; i++) {
      const s = sourceChildren[i] as Todo;
      if (s.status === "open") continue;
      const target = (cloneChildren[i] as Todo).uuid;
      for (const leg of terminalLegs("todo", target, s.status, s.stopped, zone)) {
        const run = await runLeg(
          deps,
          leg.op,
          leg.params,
          legOptions(options, txnId, leg.vector),
          `child "${s.title}": ${leg.describe}`,
        );
        if (run.result.kind !== "ok") {
          return legFailure("project.clone", cloneUuid, applied, run, finalDelta);
        }
      }
      applied.push(`reproduced child "${s.title}" ${s.status}`);
    }
  }

  // The project's own terminal state (require-resolved: its children were made to
  // match the source above, so a completed/canceled source's children are resolved).
  for (const leg of terminalLegs("project", cloneUuid, src.status, src.stopped, zone)) {
    const run = await runLeg(
      deps,
      leg.op,
      leg.params,
      legOptions(options, txnId, leg.vector),
      leg.describe,
    );
    if (run.result.kind !== "ok")
      return legFailure("project.clone", cloneUuid, applied, run, finalDelta);
    applied.push(leg.describe);
  }

  appendSummary(deps, {
    startedAt,
    op: "project.clone",
    uuid: cloneUuid,
    source: srcUuid,
    mintedChildren,
    txnId,
    role: embedded ? "leg" : "summary",
    invocation: `project.clone ${srcUuid} → ${cloneUuid} (${applied.length} legs, ${mintedChildren.length} children)`,
  });

  const ok = cloneOk(
    "project.clone",
    cloneUuid,
    title,
    baseVector,
    baseTier,
    txnId,
    applied,
    preserveCreated,
  );
  return warnings.length > 0 ? { ...ok, warnings: [...(ok.warnings ?? []), ...warnings] } : ok;
}

// -------------------------------------------------------------- shared tail

interface TerminalLeg {
  op: OperationKind;
  params: Record<string, unknown>;
  vector: LegVector;
  describe: string;
}

/**
 * The legs that reproduce a resolved item's terminal state with the EXACT
 * stopDate: complete → set-dates (completed), or complete → set-dates → cancel
 * (canceled). Flipping completed→canceled preserves the backdated stopDate
 * (BACKDT B-FLIP). Empty for an open item.
 */
function terminalLegs(
  kind: "todo" | "project",
  uuid: string,
  status: "open" | "completed" | "canceled",
  stopped: Date | null,
  zone: string | undefined,
): TerminalLeg[] {
  if (status === "open" || stopped === null) return [];
  const completeOp: OperationKind = kind === "project" ? "project.complete" : "todo.complete";
  const cancelOp: OperationKind = kind === "project" ? "project.cancel" : "todo.cancel";
  const setDatesOp: OperationKind = kind === "project" ? "project.set-dates" : "todo.set-dates";
  const childrenPolicyComplete = kind === "project" ? { children: "require-resolved" } : {};
  const childrenPolicyCancel = kind === "project" ? { children: "require-resolved" } : {};
  const completedAt = localMinute(stopped, zone);
  const legs: TerminalLeg[] = [
    {
      op: completeOp,
      params: { uuid, ...childrenPolicyComplete },
      vector: "url-scheme",
      describe: "flip → completed",
    },
    {
      op: setDatesOp,
      params: { uuid, completedAt },
      vector: "applescript",
      describe: `backdate stopDate = ${completedAt}`,
    },
  ];
  if (status === "canceled") {
    legs.push({
      op: cancelOp,
      params: { uuid, ...childrenPolicyCancel },
      vector: "url-scheme",
      describe: "flip → canceled (stopDate preserved)",
    });
  }
  return legs;
}

type OkResult = Extract<MutationResult, { kind: "ok" }>;

function cloneOk(
  op: CloneOp,
  uuid: string,
  title: string,
  vector: OkResult["vector"],
  tier: OkResult["tier"],
  txnId: string,
  applied: string[],
  preserveCreated: boolean,
): OkResult {
  const warnings = [`applied as ${applied.length} non-atomic legs: ${applied.join("; ")}`];
  if (preserveCreated) {
    warnings.push(
      "the source's creation date was copied at MINUTE resolution (sub-minute precision is lost)",
    );
  }
  return {
    kind: "ok",
    op,
    uuid,
    title,
    observed: { uuid },
    vector,
    tier,
    undoToken: txnId,
    warnings,
  };
}
