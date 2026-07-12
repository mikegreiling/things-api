/**
 * todo.edit-checklist-item orchestrator — one granular checklist edit, audited
 * as INTENT (not a snapshot).
 *
 * Things has NO item-level checklist write surface: every change is a wholesale
 * rewrite and item uuids regenerate on each rewrite. So a granular edit is
 * applied to the CURRENT list in memory (preserving every other item's checked
 * state) and delivered as a single `todo.replace-checklist` LEG through the
 * normal pipeline (guards + verified read-after-write). What makes undo smart
 * is the SUMMARY record this writes: op `todo.edit-checklist-item`, carrying
 * the intent (`{action, title, position, …}`) plus ONLY the targeted item's
 * pre/post state — enough for `planUndo` to apply a TARGETED inverse against
 * whatever the checklist looks like at undo time (a 3-way merge), instead of
 * restoring a stale whole-list snapshot. The summary is the single undoable
 * unit; the rewrite leg is excluded from undo targeting.
 *
 * HONEST LIMIT (surface, not fixable here): the forward write is still
 * read→rewrite. An out-of-band checklist edit that lands between our read and
 * the rewrite is clobbered by the FORWARD op; capturing intent cannot prevent
 * that (there is no item-level surface and no lock across the app). Canceled
 * checklist items are also flattened to open by the rewrite (the item model
 * carries only a `completed` boolean) — matching the prior granular behavior.
 */
import type { AuditRecord } from "../audit/schema.ts";
import type { Todo } from "../model/entities.ts";
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { applyChecklistEdit, checklistTarget, type ChecklistEdit } from "./checklist.ts";
import type { ChecklistItemSpec } from "./operations.ts";
import { loadTarget } from "./pre-state.ts";
import {
  fingerprintLabel,
  runMutation,
  type MutationResult,
  type WriteDeps,
  type WriteOptions,
} from "./pipeline.ts";

/** Intent + targeted pre/post state recorded for one granular edit. */
interface EditCapture {
  requested: Record<string, unknown>;
  pre: Record<string, unknown> | null;
  observed: Record<string, unknown> | null;
}

function currentItems(target: Todo): ChecklistItemSpec[] {
  return (target.checklist ?? []).map((c) => ({
    title: c.title,
    completed: c.status === "completed",
  }));
}

/**
 * Resolve the intent against the CURRENT list into (requested, pre, observed).
 * `pre` carries exactly what the inverse needs; `observed` describes the
 * targeted item AFTER the edit (used by undo to relocate it + precondition on
 * it). Throws (RangeError) via checklistTarget on an unresolvable target.
 */
function captureEdit(items: ChecklistItemSpec[], edit: ChecklistEdit): EditCapture {
  switch (edit.action) {
    case "add": {
      const at =
        edit.at === undefined ? items.length : Math.max(0, Math.min(items.length, edit.at - 1));
      const position = at + 1;
      return {
        requested: { action: "add", title: edit.title, position },
        pre: null,
        observed: { title: edit.title, completed: false, position },
      };
    }
    case "remove": {
      const i = checklistTarget(items, edit);
      const item = items[i] as ChecklistItemSpec;
      return {
        requested: { action: "remove", title: item.title, position: i + 1 },
        pre: { title: item.title, completed: item.completed === true, position: i + 1 },
        observed: null,
      };
    }
    case "check":
    case "uncheck": {
      const i = checklistTarget(items, edit);
      const item = items[i] as ChecklistItemSpec;
      const completed = edit.action === "check";
      return {
        requested: { action: edit.action, title: item.title, position: i + 1 },
        pre: { title: item.title, completed: item.completed === true, position: i + 1 },
        observed: { title: item.title, completed, position: i + 1 },
      };
    }
    case "rename": {
      const i = checklistTarget(items, edit);
      const old = items[i] as ChecklistItemSpec;
      return {
        // `title` is the POST (new) title — undo relocates by it and renames back to `oldTitle`.
        requested: { action: "rename", title: edit.title, oldTitle: old.title, position: i + 1 },
        pre: { title: old.title, completed: old.completed === true, position: i + 1 },
        observed: { title: edit.title, completed: old.completed === true, position: i + 1 },
      };
    }
    case "move": {
      const from = checklistTarget(items, edit);
      const item = items[from] as ChecklistItemSpec;
      // applyChecklistEdit removes then re-inserts into the shortened list.
      const to = Math.max(0, Math.min(items.length - 1, edit.to - 1));
      return {
        requested: { action: "move", title: item.title, position: from + 1, to: to + 1 },
        pre: { title: item.title, completed: item.completed === true, position: from + 1 },
        observed: { title: item.title, completed: item.completed === true, position: to + 1 },
      };
    }
  }
}

export async function runEditChecklist(
  deps: WriteDeps,
  rawUuid: string,
  edit: ChecklistEdit,
  options: WriteOptions = {},
): Promise<MutationResult> {
  const startedAt = deps.now?.() ?? new Date();
  const uuid = resolveTaskUuidPrefix(deps.db, rawUuid);
  const target = loadTarget(deps.db, uuid);

  if (target === null || target.type !== "to-do") {
    // No checklist to edit — surface the same shape the pipeline uses for a
    // bad destination (the rewrite leg's own guard would say the same).
    appendEditAudit(deps, {
      uuid,
      startedAt,
      requested: { action: edit.action },
      result: "blocked:H-UNKNOWN-DESTINATION",
    });
    return {
      kind: "blocked",
      op: "todo.edit-checklist-item",
      reason: "hazard",
      hazard: "H-UNKNOWN-DESTINATION",
      detail: "no to-do with that id — there is no checklist to edit",
      remediation: "target an existing to-do (checklists live on to-dos, not projects/headings)",
    };
  }

  const items = currentItems(target);
  // Resolve the intent + apply it (both throw RangeError on an unresolvable
  // target/index — the caller surfaces it, matching prior behavior).
  const capture = captureEdit(items, edit);
  const next = applyChecklistEdit(items, edit);

  // Dry-run: preview the actual delivery (the rewrite), relabeled to this op.
  if (options.dryRun === true) {
    const preview = await runMutation(
      deps,
      "todo.replace-checklist",
      { uuid, items: next },
      { ...options, acknowledgeChecklistReset: true },
    );
    if (preview.kind === "dry-run") {
      return {
        kind: "dry-run",
        op: "todo.edit-checklist-item",
        plan: { ...preview.plan, op: "todo.edit-checklist-item" },
      };
    }
    return preview;
  }

  // Deliver as ONE rewrite leg (excluded from undo; the summary below is the
  // undoable unit). The leg reuses replace-checklist's guards + verified
  // read-after-write; acknowledgeChecklistReset is implicit — a granular edit
  // preserves every other item's state by construction.
  const txnId = `txn-${startedAt.getTime().toString(36)}-${process.pid.toString(36)}`;
  const legOptions: WriteOptions = {
    acknowledgeChecklistReset: true,
    txn: { id: txnId, role: "leg" },
  };
  if (options.vector !== undefined) legOptions.vector = options.vector;
  if (options.maxDisruption !== undefined) legOptions.maxDisruption = options.maxDisruption;
  if (options.verifyTimeoutMs !== undefined) legOptions.verifyTimeoutMs = options.verifyTimeoutMs;
  if (options.actor !== undefined) legOptions.actor = options.actor;

  const leg = await runMutation(deps, "todo.replace-checklist", { uuid, items: next }, legOptions);
  if (leg.kind !== "ok") {
    // Delivery failed — record the attempt under this op and surface the
    // rewrite's own failure verbatim (relabeled), so nothing looks applied.
    appendEditAudit(deps, {
      uuid,
      startedAt,
      requested: capture.requested,
      result:
        leg.kind === "blocked" ? `blocked:${leg.hazard ?? leg.reason}` : "verify-failed:mismatch",
    });
    return { ...leg, op: "todo.edit-checklist-item" };
  }

  appendEditAudit(deps, {
    uuid,
    startedAt,
    requested: capture.requested,
    pre: capture.pre,
    observed: capture.observed,
    result: "ok",
    invocation: `edit-checklist(${String(capture.requested["action"])}) id=${uuid}`,
  });
  return {
    kind: "ok",
    op: "todo.edit-checklist-item",
    uuid,
    observed: capture.observed,
    vector: "url-scheme",
    tier: 0,
  };
}

// --------------------------------------------------------------------- audit

function appendEditAudit(
  deps: WriteDeps,
  args: {
    uuid: string;
    startedAt: Date;
    requested: Record<string, unknown>;
    pre?: Record<string, unknown> | null;
    observed?: Record<string, unknown> | null;
    result: AuditRecord["result"];
    invocation?: string;
  },
): void {
  const fp = deps.fingerprint();
  const record: AuditRecord = {
    v: 1,
    ts: args.startedAt.toISOString(),
    actor: deps.config.actor,
    host: deps.config.host,
    op: "todo.edit-checklist-item",
    uuid: args.uuid,
    vector: "url-scheme",
    disruption: 0,
    invocation: args.invocation ?? null,
    requested: { uuid: args.uuid, ...args.requested },
    pre: args.pre ?? null,
    observed: args.observed ?? null,
    result: args.result,
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
