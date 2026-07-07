/**
 * `things undo` — inverse mutations replayed from the audit trail.
 *
 * Every successful mutation's audit record carries the pre-values of the
 * fields it asserted (title, notes, status, tags, ranks, …) plus the target
 * uuid — enough to compile an INVERSE plan for most operations. The inverse
 * runs through the SAME pipeline as any mutation (guards, verified
 * read-after-write, audit), so a concurrently-edited target surfaces as a
 * blocked/verify-failed result, never a blind overwrite.
 *
 * Honesty rules:
 *  - Ops with no validated inverse surface are reported IRREVERSIBLE with
 *    the reason (permanent deletes, project completion cascades, un-nesting
 *    a tag to root — E19, project→no-area — unprobed).
 *  - Partial inversions carry notes (todo.delete undo restores to the Inbox
 *    de-scheduled; checklist per-item state is unrecoverable).
 *  - Inverse mutations are audited under an `undo:`-prefixed actor and are
 *    themselves EXCLUDED from later undo target selection (no undo-the-undo).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AuditRecord } from "../audit/schema.ts";
import { localToday } from "../model/dates.ts";
import type { OperationKind, ReorderParams } from "./operations.ts";
import { runMutation, type MutationResult, type WriteDeps, type WriteOptions } from "./pipeline.ts";
import { runReorder, type ReorderResult } from "./reorder.ts";

export interface UndoStep {
  op: OperationKind;
  params: Record<string, unknown>;
  /** Acknowledgements the inverse op needs (surfaced in the plan). */
  options?: {
    acknowledgeChecklistReset?: boolean;
    dangerouslyPermanent?: boolean;
  };
}

export interface UndoPlan {
  /** The audit record being undone. */
  target: { ts: string; op: string; uuid: string | null; actor: string };
  kind: "invertible" | "irreversible";
  steps: UndoStep[];
  /** Fidelity caveats — what the inverse cannot restore. */
  notes: string[];
  /** Present when kind is "irreversible". */
  reason?: string;
}

export interface UndoItemResult {
  plan: UndoPlan;
  /** One result per executed step (empty for dry-run/irreversible). */
  results: (MutationResult | ReorderResult)[];
  outcome: "ok" | "partial" | "failed" | "irreversible" | "dry-run";
}

export interface UndoOptions {
  /** How many trailing mutations to undo (default 1). */
  last?: number;
  dryRun?: boolean;
  /** Required for inverses that delete areas/tags permanently. */
  dangerouslyPermanent?: boolean;
  verifyTimeoutMs?: number;
  actor?: string;
}

// -------------------------------------------------------------- audit reads

/** Parse every audit record from the monthly JSONL files, oldest first. */
export function readAuditRecords(dir: string): AuditRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .toSorted();
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as AuditRecord;
        if (parsed.v === 1 && typeof parsed.op === "string") records.push(parsed);
      } catch {
        // tolerate a torn/corrupt line — audit files are append-only
      }
    }
  }
  return records.toSorted((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * The last N undoable targets, NEWEST FIRST (undo unwinds a stack). Only
 * successful mutations qualify; inverse mutations (actor `undo:…`) never do.
 */
export function selectUndoTargets(records: AuditRecord[], last: number): AuditRecord[] {
  return records
    .filter((r) => r.result === "ok" && !r.actor.startsWith("undo:"))
    .slice(-Math.max(1, last))
    .toReversed();
}

// -------------------------------------------------------------- plan builder

const IRREVERSIBLE: Partial<Record<string, string>> = {
  "area.delete": "areas are deleted permanently — there is nothing to restore (A25)",
  "tag.delete": "tags are deleted permanently — assignments already cascaded (A26)",
  "trash.empty": "emptying the Trash hard-deletes every row — nothing to restore (A27)",
};

function preField(record: AuditRecord, field: string): unknown {
  return record.pre === null ? undefined : record.pre[field];
}

/**
 * Reconstruct the scheduling step that restores a to-do's pre-op placement
 * from the captured pre-values (start / startDate / todaySection / reminder).
 */
function scheduleSteps(
  uuid: string,
  record: AuditRecord,
  todayIso: string,
): { steps: UndoStep[]; notes: string[] } {
  const notes: string[] = [];
  const start = preField(record, "start");
  const startDate = preField(record, "startDate");
  const section = preField(record, "todaySection");
  const reminder = preField(record, "reminder");

  if (start === "inbox") {
    if (reminder !== undefined && reminder !== null) {
      notes.push("the pre-state carried a reminder in the Inbox — not reproducible, skipped");
    }
    return { steps: [{ op: "todo.move", params: { uuid, inbox: true } }], notes };
  }

  let when: string | null = null;
  if (typeof startDate === "string") {
    // startDate == today maps back to the today/evening keywords (which also
    // keep the reminder-clear path open); other dates restore literally.
    if (startDate === todayIso) when = section === "evening" ? "evening" : "today";
    else {
      when = startDate;
      if (section === "evening") {
        notes.push(
          "the item was a STALE evening entry (past startDate) — the date is restored but " +
            "the evening bucket cannot be (bucket placement is today-only)",
        );
      }
    }
  } else if (start === "someday") {
    when = "someday";
  } else if (start === "active" && startDate === null) {
    when = "anytime";
  }

  if (when === null) {
    if (start !== undefined || startDate !== undefined) {
      notes.push("pre-op scheduling state was not captured fully — when/schedule not restored");
    }
    return { steps: [], notes };
  }

  const params: Record<string, unknown> = { uuid, when };
  if (reminder !== undefined) {
    if (reminder === null) {
      // The undone op SET a reminder where none was: clear it. Only
      // today/evening have a clear path (R20/R21 — dated are sticky).
      if (when === "today" || when === "evening") params["reminder"] = null;
      else {
        notes.push(
          "cannot clear the reminder the undone op set: dated reminders are sticky " +
            "(R20/R21) — clear via `--when today --clear-reminder`, then re-date",
        );
      }
    } else {
      params["reminder"] = reminder;
    }
  }
  return { steps: [{ op: "todo.update", params }], notes };
}

/** Build the inverse plan for one audit record. Pure — unit-testable. */
export function planUndo(record: AuditRecord, now: Date): UndoPlan {
  const target = { ts: record.ts, op: record.op, uuid: record.uuid, actor: record.actor };
  const todayIso = localToday(now);
  const notes: string[] = [];
  const irreversible = (reason: string): UndoPlan => ({
    target,
    kind: "irreversible",
    steps: [],
    notes,
    reason,
  });

  const fixed = IRREVERSIBLE[record.op];
  if (fixed !== undefined) return irreversible(fixed);

  const uuid = record.uuid;

  switch (record.op) {
    // Creations: the inverse is deleting what appeared. To-dos/projects go
    // to the Trash (restorable); areas/tags delete PERMANENTLY (ack needed).
    case "todo.add":
    case "todo.duplicate": {
      if (uuid === null) return irreversible("the created uuid was never discovered");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "todo.delete", params: { uuid } }],
        notes,
      };
    }
    case "project.add":
    case "project.duplicate": {
      if (uuid === null) return irreversible("the created uuid was never discovered");
      notes.push("the project (and any children it carried) moves to the Trash");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "project.delete", params: { uuid } }],
        notes,
      };
    }
    case "area.add": {
      if (uuid === null) return irreversible("the created uuid was never discovered");
      notes.push("area deletion is PERMANENT — requires --dangerously-permanent");
      return {
        target,
        kind: "invertible",
        steps: [
          { op: "area.delete", params: { target: uuid }, options: { dangerouslyPermanent: true } },
        ],
        notes,
      };
    }
    case "tag.add": {
      if (uuid === null) return irreversible("the created uuid was never discovered");
      notes.push("tag deletion is PERMANENT — requires --dangerously-permanent");
      return {
        target,
        kind: "invertible",
        steps: [
          { op: "tag.delete", params: { target: uuid }, options: { dangerouslyPermanent: true } },
        ],
        notes,
      };
    }

    // Status flips: the pre status says exactly where to go back to.
    case "todo.complete":
    case "todo.cancel": {
      if (uuid === null) return irreversible("no target uuid recorded");
      if (preField(record, "status") !== "open") {
        return irreversible("the to-do was not open before the op — nothing to restore");
      }
      return {
        target,
        kind: "invertible",
        steps: [{ op: "todo.reopen", params: { uuid } }],
        notes,
      };
    }
    case "todo.reopen": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const was = preField(record, "status");
      if (was !== "completed" && was !== "canceled") {
        return irreversible("the pre-op status was not captured — cannot restore");
      }
      return {
        target,
        kind: "invertible",
        steps: [{ op: was === "completed" ? "todo.complete" : "todo.cancel", params: { uuid } }],
        notes,
      };
    }

    case "todo.delete": {
      if (uuid === null) return irreversible("no target uuid recorded");
      notes.push(
        "restore lands in the Inbox DE-SCHEDULED (E15) — the prior list/schedule was not " +
          "captured by the delete",
      );
      return {
        target,
        kind: "invertible",
        steps: [{ op: "todo.restore", params: { uuid } }],
        notes,
      };
    }
    case "todo.restore": {
      if (uuid === null) return irreversible("no target uuid recorded");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "todo.delete", params: { uuid } }],
        notes,
      };
    }

    case "project.delete": {
      if (uuid === null) return irreversible("no target uuid recorded");
      notes.push("restored IN PLACE (P06) — schedule/area/children keep their state");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "project.restore", params: { uuid } }],
        notes,
      };
    }

    // Project completion/cancellation: reopen the project (P02/P05), then
    // reopen exactly the children the cascade resolved — the audit captured
    // their pre-op statuses (nested pre map when a cascade was asserted).
    case "project.complete":
    case "project.cancel": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const steps: UndoStep[] = [{ op: "project.reopen", params: { uuid } }];
      const pre = record.pre ?? {};
      if (!("status" in pre)) {
        for (const [childUuid, fields] of Object.entries(pre)) {
          if (childUuid === uuid) continue;
          if (
            typeof fields === "object" &&
            fields !== null &&
            (fields as Record<string, unknown>)["status"] === "open"
          ) {
            steps.push({ op: "todo.reopen", params: { uuid: childUuid } });
          }
        }
      }
      if (steps.length > 1) {
        notes.push(`${steps.length - 1} cascade-resolved child(ren) will be reopened too`);
      }
      return { target, kind: "invertible", steps, notes };
    }

    case "project.reopen": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const was = preField(record, "status");
      if (was !== "completed" && was !== "canceled") {
        return irreversible("the pre-op project status was not captured — cannot restore");
      }
      notes.push(
        "children were untouched by the reopen; require-resolved will block if any were " +
          "reopened since — resolve them or redo manually",
      );
      return {
        target,
        kind: "invertible",
        steps: [
          was === "completed"
            ? { op: "project.complete", params: { uuid, children: "require-resolved" } }
            : { op: "project.cancel", params: { uuid, children: "require-resolved" } },
        ],
        notes,
      };
    }

    case "project.restore": {
      if (uuid === null) return irreversible("no target uuid recorded");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "project.delete", params: { uuid } }],
        notes,
      };
    }

    case "todo.update": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const steps: UndoStep[] = [];
      const params: Record<string, unknown> = { uuid };
      const title = preField(record, "title");
      const notesPre = preField(record, "notes");
      const deadline = preField(record, "deadline");
      if (title !== undefined) params["title"] = title;
      if (notesPre !== undefined) params["notes"] = notesPre; // covers append/prepend too
      if (deadline !== undefined) params["deadline"] = deadline;
      const requestedWhen =
        (record.requested["when"] ?? record.requested["reminder"]) !== undefined;
      if (requestedWhen) {
        const schedule = scheduleSteps(uuid, record, todayIso);
        notes.push(...schedule.notes);
        const scheduleStep = schedule.steps[0];
        if (scheduleStep !== undefined && scheduleStep.op === "todo.update") {
          Object.assign(params, scheduleStep.params);
        } else if (scheduleStep !== undefined) {
          steps.push(scheduleStep); // inbox restore is a separate move op
        }
      }
      if (Object.keys(params).length > 1) steps.unshift({ op: "todo.update", params });
      if (steps.length === 0) {
        return irreversible("no pre-values were captured for the changed fields");
      }
      return { target, kind: "invertible", steps, notes };
    }

    case "project.update": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const params: Record<string, unknown> = { uuid };
      const title = preField(record, "title");
      const notesPre = preField(record, "notes");
      const deadline = preField(record, "deadline");
      if (title !== undefined) params["title"] = title;
      if (notesPre !== undefined) params["notes"] = notesPre;
      if (deadline !== undefined) params["deadline"] = deadline;
      if (record.requested["when"] !== undefined) {
        const startDate = preField(record, "startDate");
        const start = preField(record, "start");
        if (typeof startDate === "string") params["when"] = startDate;
        else if (start === "someday") params["when"] = "someday";
        else if (start === "active" && startDate === null) params["when"] = "anytime";
        else notes.push("pre-op project scheduling was not captured fully — when not restored");
      }
      if (Object.keys(params).length === 1) {
        return irreversible("no pre-values were captured for the changed fields");
      }
      return {
        target,
        kind: "invertible",
        steps: [{ op: "project.update", params }],
        notes,
      };
    }

    case "todo.move": {
      if (uuid === null) return irreversible("no target uuid recorded");
      if (record.requested["detach"] === true) {
        // The detach delta captured the old container Refs directly.
        const projRef = preField(record, "project");
        const areaRef = preField(record, "area");
        const oldProj =
          typeof projRef === "object" && projRef !== null
            ? (projRef as { uuid?: unknown }).uuid
            : undefined;
        const oldArea =
          typeof areaRef === "object" && areaRef !== null
            ? (areaRef as { uuid?: unknown }).uuid
            : undefined;
        if (preField(record, "heading") !== null && preField(record, "heading") !== undefined) {
          notes.push(
            "heading placement cannot be restored — the to-do returns to the project root",
          );
        }
        if (typeof oldProj === "string") {
          return {
            target,
            kind: "invertible",
            steps: [{ op: "todo.move", params: { uuid, project: { uuid: oldProj } } }],
            notes,
          };
        }
        if (typeof oldArea === "string") {
          return {
            target,
            kind: "invertible",
            steps: [{ op: "todo.move", params: { uuid, area: { uuid: oldArea } } }],
            notes,
          };
        }
        return irreversible("the to-do had no container before the detach — nothing to restore");
      }
      // A move-to-inbox op asserted start/startDate instead of containers.
      if (record.requested["inbox"] === true) {
        const schedule = scheduleSteps(uuid, record, todayIso);
        notes.push(...schedule.notes);
        notes.push(
          "the pre-op project/area link was not captured by the inbox move — not restored",
        );
        if (schedule.steps.length === 0) {
          return irreversible("pre-op scheduling state was not captured — cannot leave the Inbox");
        }
        return { target, kind: "invertible", steps: schedule.steps, notes };
      }
      // The audit captured the OLD value of whatever destination-kind fields
      // the move asserted: "project.uuid"/"heading.uuid" (project moves),
      // "area.uuid" + "project" as a Ref (area moves — A22B clears the link).
      const projectRef = preField(record, "project");
      const oldProject =
        preField(record, "project.uuid") ??
        (typeof projectRef === "object" && projectRef !== null
          ? (projectRef as { uuid?: unknown }).uuid
          : undefined);
      const oldArea = preField(record, "area.uuid");
      if (typeof oldProject === "string") {
        if (preField(record, "heading.uuid") !== undefined) {
          notes.push(
            "heading placement cannot be restored (no heading-move surface) — " +
              "the to-do returns to the project root",
          );
        }
        return {
          target,
          kind: "invertible",
          steps: [{ op: "todo.move", params: { uuid, project: { uuid: oldProject } } }],
          notes,
        };
      }
      if (typeof oldArea === "string") {
        return {
          target,
          kind: "invertible",
          steps: [{ op: "todo.move", params: { uuid, area: { uuid: oldArea } } }],
          notes,
        };
      }
      // The captured fields say only "no <destination-kind> before" — the
      // real prior container (a different kind, or none) was never recorded.
      return irreversible(
        "the pre-op container was not fully captured (only the destination-kind field is " +
          "audited) — move it back manually",
      );
    }

    case "project.move": {
      if (uuid === null) return irreversible("no target uuid recorded");
      if (record.requested["detach"] === true) {
        const areaRef = preField(record, "area");
        const oldArea =
          typeof areaRef === "object" && areaRef !== null
            ? (areaRef as { uuid?: unknown }).uuid
            : undefined;
        if (typeof oldArea === "string") {
          return {
            target,
            kind: "invertible",
            steps: [{ op: "project.move", params: { uuid, area: { uuid: oldArea } } }],
            notes,
          };
        }
        return irreversible("the project had no area before the detach — nothing to restore");
      }
      const areaPre = preField(record, "area.uuid");
      if (typeof areaPre === "string") {
        return {
          target,
          kind: "invertible",
          steps: [{ op: "project.move", params: { uuid, area: { uuid: areaPre } } }],
          notes,
        };
      }
      if (areaPre === null) {
        // The project had no area before: detach restores that state (P24).
        return {
          target,
          kind: "invertible",
          steps: [{ op: "project.move", params: { uuid, detach: true } }],
          notes,
        };
      }
      return irreversible("the pre-op area was not captured");
    }

    case "todo.set-tags": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const tags = preField(record, "tags");
      if (!Array.isArray(tags)) return irreversible("the pre-op tag set was not captured");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "todo.set-tags", params: { uuid, tags } }],
        notes,
      };
    }

    case "todo.replace-checklist": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const items = preField(record, "checklistTitles");
      if (!Array.isArray(items)) return irreversible("the pre-op checklist was not captured");
      notes.push("checklist TITLES are restored; per-item completion state is unrecoverable (T07)");
      return {
        target,
        kind: "invertible",
        steps: [
          {
            op: "todo.replace-checklist",
            params: { uuid, items },
            options: { acknowledgeChecklistReset: true },
          },
        ],
        notes,
      };
    }

    case "area.update": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const patch: Record<string, unknown> = { target: uuid };
      const title = preField(record, "title");
      const tags = preField(record, "tags");
      if (title !== undefined) patch["title"] = title;
      if (Array.isArray(tags)) patch["tags"] = tags;
      if (Object.keys(patch).length === 1) return irreversible("no pre-values were captured");
      return { target, kind: "invertible", steps: [{ op: "area.update", params: patch }], notes };
    }

    case "tag.update": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const patch: Record<string, unknown> = { target: uuid };
      const title = preField(record, "title");
      const parent = preField(record, "parent");
      const shortcut = preField(record, "shortcut");
      if (title !== undefined) patch["title"] = title;
      if (typeof parent === "string" && parent !== "") patch["parent"] = parent;
      else if (parent === null) {
        notes.push(
          "the tag was un-nested before the op — un-nesting to root is IMPOSSIBLE via " +
            "automation (E19); fix the parent in the app",
        );
      }
      if (typeof shortcut === "string") patch["shortcut"] = shortcut;
      else if (shortcut === null && record.requested["shortcut"] !== undefined) {
        notes.push("clearing a keyboard shortcut is unprobed — the new shortcut stays");
      }
      if (Object.keys(patch).length === 1) {
        return irreversible("none of the changed tag fields can be restored (see notes)");
      }
      return { target, kind: "invertible", steps: [{ op: "tag.update", params: patch }], notes };
    }

    case "reorder": {
      const pre = record.pre;
      if (pre === null) {
        return irreversible(
          "bounce reorders record no pre-ranks in their summary — undo their individual " +
            "when= legs instead (separate audit records)",
        );
      }
      const requested = record.requested as unknown as ReorderParams;
      const ranked = Object.entries(pre).filter(([, rank]) => typeof rank === "number") as [
        string,
        number,
      ][];
      if (ranked.length === 0) return irreversible("no pre-ranks were captured");
      const uuids = ranked.toSorted((a, b) => a[1] - b[1]).map(([id]) => id);
      const params: Record<string, unknown> = { scope: requested.scope, uuids };
      if (requested.container !== undefined) params["container"] = requested.container;
      notes.push(
        "the requested uuids return to their pre-op relative order; other members keep " +
          "their current positions",
      );
      return { target, kind: "invertible", steps: [{ op: "reorder", params }], notes };
    }

    default:
      return irreversible(`no inverse is defined for operation "${record.op}"`);
  }
}

// ----------------------------------------------------------------- executor

export async function runUndo(
  deps: WriteDeps,
  auditDirPath: string,
  options: UndoOptions = {},
  onItem?: (item: UndoItemResult) => void,
): Promise<UndoItemResult[]> {
  const records = readAuditRecords(auditDirPath);
  const targets = selectUndoTargets(records, options.last ?? 1);
  const now = deps.now?.() ?? new Date();
  const items: UndoItemResult[] = [];

  for (const record of targets) {
    const plan = planUndo(record, now);
    let item: UndoItemResult;

    if (plan.kind === "irreversible") {
      item = { plan, results: [], outcome: "irreversible" };
    } else if (options.dryRun === true) {
      item = { plan, results: [], outcome: "dry-run" };
    } else {
      const results: (MutationResult | ReorderResult)[] = [];
      let failed = false;
      for (const step of plan.steps) {
        const needsPermanent = step.options?.dangerouslyPermanent === true;
        if (needsPermanent && options.dangerouslyPermanent !== true) {
          results.push({
            kind: "blocked",
            op: step.op,
            reason: "hazard",
            hazard: "H-PERMANENT-DELETE",
            detail: `undoing this ${record.op} deletes the created entity PERMANENTLY`,
            remediation: "re-run with --dangerously-permanent",
          });
          failed = true;
          break;
        }
        const writeOptions: WriteOptions = {
          actor: `undo:${options.actor ?? deps.config.actor}`,
          ...(options.verifyTimeoutMs !== undefined && {
            verifyTimeoutMs: options.verifyTimeoutMs,
          }),
          ...(step.options?.acknowledgeChecklistReset === true && {
            acknowledgeChecklistReset: true,
          }),
          ...(needsPermanent && { dangerouslyPermanent: true }),
        };
        const result =
          step.op === "reorder"
            ? await runReorder(deps, step.params as unknown as ReorderParams, writeOptions)
            : await runMutation(
                deps,
                step.op as Exclude<OperationKind, "reorder">,
                step.params as never,
                writeOptions,
              );
        results.push(result);
        if (result.kind !== "ok") {
          failed = true;
          break;
        }
      }
      const okCount = results.filter((r) => r.kind === "ok").length;
      item = {
        plan,
        results,
        outcome: failed ? (okCount > 0 ? "partial" : "failed") : "ok",
      };
    }

    items.push(item);
    onItem?.(item);
    // A failed inverse means the state no longer matches the audit trail —
    // unwinding further would compound the divergence.
    if (item.outcome === "failed" || item.outcome === "partial") break;
  }
  return items;
}
