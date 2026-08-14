/**
 * Promote-via-clone orchestrators (design of record: docs/design/promote-via-clone.md;
 * rulings 2026-08-11/13). The four public promote verbs live here:
 *
 *   - `todo.make-repeating` / `project.make-repeating` — the REWIRED promote:
 *       clone(X, preserveCreated) → native-promote(the clone) → trash(X).
 *     Recoverable (X survives in the Trash) and deterministic (the RSIM source-fate
 *     lottery lands on a disposable clone row we were going to discard anyway,
 *     CLONE verdict B). The result carries the minted template uuid (unchanged
 *     contract) plus the trashed original's uuid; the audit SUMMARY captures
 *     template + instance + original so `things undo` is the automated trash-both
 *     + restore (SERDEL S1/S2). The old direct-promote is GONE (ALPHA-CONTRACT):
 *     the native dialog stays the INTERNAL mechanism (runMutation on the clone /
 *     promoteProjectViaGui), never a user-facing mode.
 *
 *   - `todo.add-repeating` (NEW, closes §0.2) / `project.add-repeating` (full
 *     write vocabulary, closes §0.3) — add(full vocabulary) → native-promote(the
 *     fresh row). No trash leg (there is no original).
 *
 * A nested-repeater project refuses at the CLONE leg (H-CLONE-SOURCE), which
 * surfaces coherently at the make-repeating surface (ruling 2026-08-13, no
 * --flatten). Placement of the resulting instance is disclosed best-effort (see
 * PLACEMENT_NOTE).
 */
import type { AuditRecord } from "../audit/schema.ts";
import { undoToken } from "../audit/schema.ts";
import { byUuid } from "../read/detail.ts";
import { resolveProjectWriteTarget, resolveTaskUuidPrefix } from "../read/queries.ts";
import { runCloneProject, runCloneTodo } from "./clone.ts";
import { promoteProjectViaGui } from "./make-repeating-project.ts";
import type {
  AddRepeatingRuleFields,
  OperationKind,
  ProjectAddRepeatingParams,
  RepeatRuleParams,
  TodoAddRepeatingParams,
} from "./operations.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";
import { assertRepeatRule } from "./repeat-rule.ts";
import { createDbReader, type PreModDates, type RepeatingDiscovery } from "./verify/delta.ts";

type PromoteOp =
  | "todo.make-repeating"
  | "project.make-repeating"
  | "todo.add-repeating"
  | "project.add-repeating";

const PLACEMENT_NOTE =
  "the series' current instance lands at its container's default position — its prior slot was " +
  "not automatically restored (best-effort placement is not yet wired for this container); " +
  "reposition it with `things reorder` if the order matters";

// --------------------------------------------------------------- small helpers

function newTxnId(now: Date): string {
  return `txn-${now.getTime().toString(36)}-${process.pid.toString(36)}`;
}

/**
 * Forward the caller's audit/timeout/GUI knobs onto a delegated leg. `extra`
 * carries per-leg additions — `preserveModified` is threaded ONLY onto the legs
 * that touch a PRE-EXISTING row (the trash-X leg); the clone/promote legs mint
 * fresh rows, where the flag would be a no-op.
 */
function legOptions(
  base: WriteOptions,
  txnId: string,
  vector?: WriteOptions["vector"],
  extra?: Partial<WriteOptions>,
): WriteOptions {
  const out: WriteOptions = { txn: { id: txnId, role: "leg" } };
  if (vector !== undefined) out.vector = vector;
  if (base.actor !== undefined) out.actor = base.actor;
  if (base.verifyTimeoutMs !== undefined) out.verifyTimeoutMs = base.verifyTimeoutMs;
  if (base.dangerouslyDriveGui !== undefined) out.dangerouslyDriveGui = base.dangerouslyDriveGui;
  if (base.maxDisruption !== undefined) out.maxDisruption = base.maxDisruption;
  if (base.zone !== undefined) out.zone = base.zone;
  if (extra?.preserveModified === true) out.preserveModified = true;
  return out;
}

/** The two-key GUI-drive block (mirrors H-UI-DRIVE) — the promote leg drives the app. */
function blockedUiDrive(op: PromoteOp): MutationResult {
  return {
    kind: "blocked",
    op,
    reason: "hazard",
    hazard: "H-UI-DRIVE",
    detail:
      "this operation promotes an item to a repeating series by driving the local Things app " +
      "through the Accessibility API (the Repeat… dialog) — it may briefly interact with the UI",
    remediation:
      "pass dangerouslyDriveGui (--dangerously-drive-gui) to proceed; the vector also requires " +
      "`things config set ui-enabled true` and Accessibility granted to this process (see docs/setup.md)",
  };
}

/** Pick the rule fields (frequency/interval + calendar anchors) as a RepeatRuleParams. */
function ruleParamsFor(uuid: string, rule: AddRepeatingRuleFields): RepeatRuleParams {
  return {
    uuid,
    frequency: rule.frequency,
    interval: rule.interval,
    ...(rule.afterCompletion !== undefined && { afterCompletion: rule.afterCompletion }),
    ...(rule.weekdays !== undefined && { weekdays: rule.weekdays }),
    ...(rule.monthly !== undefined && { monthly: rule.monthly }),
    ...(rule.yearly !== undefined && { yearly: rule.yearly }),
    ...(rule.ends !== undefined && { ends: rule.ends }),
  };
}

/** The discovered template/instance from a promote leg's result. */
function discoveryOf(promote: Extract<MutationResult, { kind: "ok" }>): {
  templateUuid: string;
  instanceUuid: string | null;
} {
  const rep = promote.repeating;
  return {
    templateUuid: rep?.templateUuid ?? promote.uuid ?? "",
    instanceUuid: rep?.instanceUuid ?? null,
  };
}

// -------------------------------------------------------------- audit summary

function appendPromoteSummary(
  deps: WriteDeps,
  args: {
    startedAt: Date;
    op: PromoteOp;
    txnId: string;
    templateUuid: string;
    instanceUuid: string | null;
    originalUuid?: string;
    invocation: string;
    requested: Record<string, unknown>;
    /** The trashed original's pre-write umd (--preserve-modified) — drives the
     * symmetric undo restore (undo.ts) so the reversal is also timeline-silent. */
    preModDates?: PreModDates;
  },
): void {
  const fp = deps.fingerprint();
  const observed: Record<string, unknown> = {
    templateUuid: args.templateUuid,
    instanceUuid: args.instanceUuid,
    ...(args.originalUuid !== undefined && { originalUuid: args.originalUuid }),
  };
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: args.op,
    uuid: args.templateUuid,
    vector: "ui",
    disruption: 3,
    invocation: args.invocation,
    requested: args.requested,
    txn: { id: args.txnId, role: "summary" },
    pre: null,
    observed,
    result: "ok",
    ...(args.preModDates !== undefined && { preModDates: args.preModDates }),
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

/** Build the ok result for a promote (make/add-repeating). */
function promoteOk(args: {
  op: PromoteOp;
  templateUuid: string;
  instanceUuid: string | null;
  replacedUuid: string | null;
  title: string;
  txnId: string;
  warnings: string[];
}): Extract<MutationResult, { kind: "ok" }> {
  const repeating: RepeatingDiscovery = {
    templateUuid: args.templateUuid,
    instanceUuid: args.instanceUuid,
    replacedUuid: args.replacedUuid,
  };
  return {
    kind: "ok",
    op: args.op,
    uuid: args.templateUuid,
    title: args.title,
    observed: { templateUuid: args.templateUuid, instanceUuid: args.instanceUuid },
    vector: "ui",
    tier: 3,
    undoToken: undoToken({
      ts: "",
      op: args.op,
      actor: "",
      host: "",
      uuid: args.templateUuid,
      txn: { id: args.txnId, role: "summary" },
    }),
    repeating,
    ...(args.warnings.length > 0 && { warnings: args.warnings }),
  };
}

// ============================================================ make-repeating

/**
 * Shared clone → native-promote → trash(X) for `todo.make-repeating` /
 * `project.make-repeating`. `promoteLeg` runs the native promote on the clone.
 */
async function makeRepeatingViaClone(
  deps: WriteDeps,
  kind: "todo" | "project",
  params: RepeatRuleParams,
  options: WriteOptions,
): Promise<MutationResult> {
  const op: PromoteOp = kind === "project" ? "project.make-repeating" : "todo.make-repeating";
  // Validate the rule BEFORE anything (a bad rule must never mint a clone).
  assertRepeatRule(params);

  const now = deps.now?.() ?? new Date();
  const srcUuid =
    kind === "project"
      ? resolveProjectWriteTarget(deps.db, params.uuid)
      : resolveTaskUuidPrefix(deps.db, params.uuid, "to-do");
  const src = byUuid(deps.db, srcUuid, now, deps.zone);
  const expectedType = kind === "project" ? "project" : "to-do";
  if (src === null || src.type !== expectedType) {
    return {
      kind: "blocked",
      op,
      reason: "hazard",
      hazard: "H-UNKNOWN-DESTINATION",
      detail: `the target is not a ${expectedType} (make-repeating needs an existing ${expectedType})`,
      remediation:
        kind === "project"
          ? "verify the uuid with `things projects`, or use `things todo make-repeating` for a to-do"
          : "verify the uuid with `things show <uuid>`, or use `things project make-repeating` for a project",
    };
  }

  // The promote leg drives the GUI — block before minting a clone if the ack is missing.
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive(op);
  }

  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op,
      plan: {
        op,
        vector: "ui",
        tier: 3,
        invocation:
          `clone ${srcUuid} (--preserve-created) → make-repeating the clone (Repeat… → ` +
          `frequency=${params.frequency}, interval=${params.interval}) → trash the original ${srcUuid}`,
        expectedDelta: {
          mode: "create",
          probe: { title: src.title, type: expectedType, sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-UNKNOWN-DESTINATION", "H-CLONE-SOURCE", "H-UI-DRIVE"],
      },
    };
  }

  const startedAt = now;
  const txnId = newTxnId(startedAt);

  // 1. Clone the source as a disposable, embedded leg (--preserve-created). The
  // clone has captured X's full content by the time it returns.
  const clone =
    kind === "project"
      ? await runCloneProject(
          deps,
          { uuid: srcUuid, preserveCreated: true },
          legOptions(options, txnId),
        )
      : await runCloneTodo(
          deps,
          { uuid: srcUuid, preserveCreated: true },
          legOptions(options, txnId),
        );
  if (clone.kind !== "ok" || clone.uuid === null) {
    // A clone refusal (nested repeating template, H-CLONE-SOURCE) surfaces
    // coherently here — re-label it to the make-repeating op for the caller.
    return clone.kind === "ok"
      ? {
          kind: "verify-failed",
          op,
          reason: "mismatch",
          expected: {
            mode: "create",
            probe: { title: src.title, type: expectedType, sinceEpoch: 0 },
            assert: [],
          },
          observed: null,
          detail:
            "the disposable clone was created but its uuid was not discovered — nothing was promoted or trashed",
        }
      : { ...clone, op };
  }
  const cloneUuid = clone.uuid;

  // --preserve-modified: X is the ONLY pre-existing row the compound touches (the
  // clone/promote legs mint fresh rows). Capture its pre-write umd BEFORE the
  // trash bumps it — the trash leg restores it forward, and the value rides the
  // summary record's preModDates so the symmetric undo restore fires on the
  // revived X (undo.ts, 2026-08-13 ruling). The clone leg above reads X but never
  // writes it, so its umd is still pristine here.
  const preserveModified = options.preserveModified === true;
  const preUmd = preserveModified
    ? createDbReader(deps.db, now, deps.zone).modDateOf(srcUuid)
    : null;

  // 2. Trash the original BEFORE promoting — the clone already holds X's content,
  // and a live same-titled X would make the promote's project row-selection
  // ambiguous (H-PROJECT-REPEAT). X survives in the Trash (the recoverable half).
  const trash = await runMutation(
    deps,
    `${kind}.delete`,
    { uuid: srcUuid },
    legOptions(
      options,
      txnId,
      undefined,
      preserveModified ? { preserveModified: true } : undefined,
    ),
  );
  if (trash.kind !== "ok") {
    return {
      ...trash,
      op,
      ...("detail" in trash
        ? {
            detail:
              `${trash.detail} — the disposable clone (uuid ${cloneUuid}) was created but the ` +
              `original ${srcUuid} could not be moved to the Trash, so it was NOT promoted; trash ` +
              "the clone and retry",
          }
        : {}),
    } as MutationResult;
  }

  // 3. Native-promote the clone.
  const rule = ruleParamsFor(cloneUuid, params);
  const promote =
    kind === "project"
      ? await promoteProjectViaGui(deps, rule, legOptions(options, txnId, "ui"))
      : await runMutation(deps, "todo.make-repeating", rule, legOptions(options, txnId, "ui"));
  if (promote.kind !== "ok") {
    // The clone persists but was not promoted; best-effort ROLL BACK the trash so
    // the original is not stranded in the Trash.
    const restoreOp: OperationKind = kind === "project" ? "project.restore" : "todo.restore";
    const rolledBack = await runMutation(
      deps,
      restoreOp,
      { uuid: srcUuid },
      legOptions(options, txnId),
    );
    const rollNote =
      rolledBack.kind === "ok"
        ? `the original ${srcUuid} was restored from the Trash`
        : `the original ${srcUuid} could NOT be restored from the Trash — restore it in the app`;
    return {
      ...promote,
      op,
      ...("detail" in promote
        ? {
            detail:
              `${promote.detail} — the disposable clone (uuid ${cloneUuid}) was created but the ` +
              `promote did not land; ${rollNote}. Trash the clone and retry`,
          }
        : {}),
    } as MutationResult;
  }
  const { templateUuid, instanceUuid } = discoveryOf(promote);

  const warnings: string[] = [
    `the original ${expectedType} (uuid ${srcUuid}) was moved to the Trash; \`things undo\` ` +
      "removes the new series (trash-both) and restores it",
    PLACEMENT_NOTE,
  ];
  if (promote.warnings !== undefined) warnings.push(...promote.warnings);

  appendPromoteSummary(deps, {
    startedAt,
    op,
    txnId,
    templateUuid,
    instanceUuid,
    originalUuid: srcUuid,
    invocation: `${op}: clone ${srcUuid} → trash ${srcUuid} → promote ${cloneUuid} → template ${templateUuid}`,
    requested: params as unknown as Record<string, unknown>,
    ...(preserveModified && preUmd !== null && { preModDates: { [srcUuid]: preUmd } }),
  });

  return promoteOk({
    op,
    templateUuid,
    instanceUuid,
    replacedUuid: cloneUuid,
    title: src.title,
    txnId,
    warnings,
  });
}

export function runMakeRepeatingTodo(
  deps: WriteDeps,
  params: RepeatRuleParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  return makeRepeatingViaClone(deps, "todo", params, options);
}

export function runMakeRepeatingProject(
  deps: WriteDeps,
  params: RepeatRuleParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  return makeRepeatingViaClone(deps, "project", params, options);
}

// ============================================================== add-repeating

/**
 * Shared add(full vocabulary) → native-promote for `todo.add-repeating` /
 * `project.add-repeating`. No trash leg — there is no original. The two legs are
 * NOT atomic: the created item persists even if the promote refuses.
 */
async function addRepeatingViaCreate(
  deps: WriteDeps,
  kind: "todo" | "project",
  addParams: Record<string, unknown>,
  rule: AddRepeatingRuleFields,
  title: string,
  options: WriteOptions,
): Promise<MutationResult> {
  const op: PromoteOp = kind === "project" ? "project.add-repeating" : "todo.add-repeating";
  assertRepeatRule(rule);

  // The promote leg drives the GUI — block before creating anything if the ack is missing.
  if (options.dangerouslyDriveGui !== true && options.dryRun !== true) {
    return blockedUiDrive(op);
  }

  const expectedType = kind === "project" ? "project" : "to-do";
  if (options.dryRun === true) {
    return {
      kind: "dry-run",
      op,
      plan: {
        op,
        vector: "ui",
        tier: 3,
        invocation:
          `create ${expectedType} "${title}" (persists on its own) → then make-repeating ` +
          `(Repeat… → frequency=${rule.frequency}, interval=${rule.interval})`,
        expectedDelta: {
          mode: "create",
          probe: { title, type: expectedType, sinceEpoch: 0 },
          assert: [{ field: "repeating.isTemplate", equals: true }],
        },
        hazardsChecked: ["H-UI-DRIVE"],
      },
    };
  }

  const startedAt = deps.now?.() ?? new Date();
  const txnId = newTxnId(startedAt);

  // 1. Create the item (full add vocabulary) as an embedded leg.
  const addOp = kind === "project" ? "project.add" : "todo.add";
  const add = await runMutation(
    deps,
    addOp,
    addParams as never,
    legOptions(options, txnId, "url-scheme"),
  );
  if (add.kind !== "ok" || add.uuid === null) {
    return add.kind === "ok"
      ? {
          kind: "verify-failed",
          op,
          reason: "mismatch",
          expected: {
            mode: "create",
            probe: { title, type: expectedType, sinceEpoch: 0 },
            assert: [],
          },
          observed: null,
          detail: `the ${expectedType} was created but its uuid was not discovered — it cannot be promoted to repeating`,
        }
      : ({ ...add, op } as MutationResult);
  }
  const createdUuid = add.uuid;

  // 2. Native-promote the fresh row.
  const ruleParams = ruleParamsFor(createdUuid, rule);
  const promote =
    kind === "project"
      ? await promoteProjectViaGui(deps, ruleParams, legOptions(options, txnId, "ui"))
      : await runMutation(
          deps,
          "todo.make-repeating",
          ruleParams,
          legOptions(options, txnId, "ui"),
        );
  if (promote.kind !== "ok") {
    // Honest: the item was created (and persists) but the promote did not land.
    return { ...promote, op } as MutationResult;
  }
  const { templateUuid, instanceUuid } = discoveryOf(promote);

  const warnings: string[] = [PLACEMENT_NOTE];
  if (promote.warnings !== undefined) warnings.push(...promote.warnings);

  appendPromoteSummary(deps, {
    startedAt,
    op,
    txnId,
    templateUuid,
    instanceUuid,
    invocation: `${op}: add "${title}" ${createdUuid} → template ${templateUuid}`,
    requested: { title, ...rule },
  });

  return promoteOk({
    op,
    templateUuid,
    instanceUuid,
    replacedUuid: createdUuid,
    title,
    txnId,
    warnings,
  });
}

export function runAddRepeatingTodo(
  deps: WriteDeps,
  params: TodoAddRepeatingParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const { frequency, interval, afterCompletion, weekdays, monthly, yearly, ends, ...add } = params;
  const rule: AddRepeatingRuleFields = {
    frequency,
    interval,
    ...(afterCompletion !== undefined && { afterCompletion }),
    ...(weekdays !== undefined && { weekdays }),
    ...(monthly !== undefined && { monthly }),
    ...(yearly !== undefined && { yearly }),
    ...(ends !== undefined && { ends }),
  };
  const addParams: Record<string, unknown> = {
    title: add.title,
    ...(add.notes !== undefined && { notes: add.notes }),
    ...(add.when !== undefined && { when: add.when }),
    ...(add.reminder !== undefined && { reminder: add.reminder }),
    ...(add.deadline !== undefined && { deadline: add.deadline }),
    ...(add.tags !== undefined && { tags: add.tags }),
    ...(add.checklistItems !== undefined && { checklistItems: add.checklistItems }),
    ...(add.project !== undefined && { project: add.project }),
    ...(add.area !== undefined && { area: add.area }),
    ...(add.heading !== undefined && { heading: add.heading }),
    ...(add.createdAt !== undefined && { createdAt: add.createdAt }),
  };
  return addRepeatingViaCreate(deps, "todo", addParams, rule, add.title, options);
}

export function runAddRepeatingProject(
  deps: WriteDeps,
  params: ProjectAddRepeatingParams,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const { frequency, interval, afterCompletion, weekdays, monthly, yearly, ends, ...add } = params;
  const rule: AddRepeatingRuleFields = {
    frequency,
    interval,
    ...(afterCompletion !== undefined && { afterCompletion }),
    ...(weekdays !== undefined && { weekdays }),
    ...(monthly !== undefined && { monthly }),
    ...(yearly !== undefined && { yearly }),
    ...(ends !== undefined && { ends }),
  };
  // Seed a pure-AX taxonomy: an area lands a selectable AREA-view row; otherwise
  // create in Someday (UIC4-f) so the promote skips the anytime-header problem.
  const seedWhen = add.when ?? (add.area === undefined ? "someday" : undefined);
  const addParams: Record<string, unknown> = {
    title: add.title,
    ...(add.notes !== undefined && { notes: add.notes }),
    ...(add.area !== undefined && { area: add.area }),
    ...(seedWhen !== undefined && { when: seedWhen }),
    ...(add.deadline !== undefined && { deadline: add.deadline }),
    ...(add.todos !== undefined && { todos: add.todos }),
    ...(add.items !== undefined && { items: add.items }),
    ...(add.createdAt !== undefined && { createdAt: add.createdAt }),
  };
  return addRepeatingViaCreate(deps, "project", addParams, rule, add.title, options);
}
