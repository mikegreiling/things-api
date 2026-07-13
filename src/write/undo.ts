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
 *    the reason (permanent deletes, empty-trash, project→no-area — unprobed).
 *  - Partial inversions carry notes (todo.delete undo restores to the Inbox
 *    de-scheduled).
 *  - Checklist undos are CURRENT-STATE-AWARE: a granular edit
 *    (todo.edit-checklist-item) inverts only the targeted item against the
 *    live list (a 3-way merge, so an out-of-band edit to a DIFFERENT item
 *    survives), refusing when the targeted item itself moved. A wholesale
 *    replace restores titles AND per-item state via the json form (P18) and
 *    refuses on ANY out-of-band difference from its recorded post snapshot.
 *  - Inverse mutations are audited under an `undo:`-prefixed actor and are
 *    themselves EXCLUDED from later undo target selection (no undo-the-undo).
 *  - PRECONDITION guard: before executing each inverse step, runUndo confirms
 *    the fields the step would OVERWRITE still hold their recorded after-state
 *    (`observed`). A field an out-of-band edit already moved is NOT clobbered —
 *    the step is refused (blocked) and unwinding stops. This is in addition to
 *    the pipeline's own verified read-after-write.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AuditRecord } from "../audit/schema.ts";
import type { AnyTask } from "../model/entities.ts";
import { localToday } from "../model/dates.ts";
import { getField } from "./verify/delta.ts";
import { isRepeatingTemplate, loadTarget } from "./pre-state.ts";
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
    /**
     * A precondition the PLAN already found violated (checklist undos resolve
     * against the CURRENT list at plan time). When present, runUndo refuses
     * this step (blocked/environment) instead of executing — same shape as the
     * runtime `checkStepPrecondition` guard, decided earlier because the check
     * is item-level, not a CLOBBER_FIELD.
     */
    blocked?: { detail: string; remediation: string };
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
  // Compound operations undo as ONE unit: legs are excluded here; their
  // summary record replays every inverse (or, for reorders, issues a single
  // inverse reorder from the recorded pre-ranks).
  return records
    .filter((r) => r.result === "ok" && !r.actor.startsWith("undo:") && r.txn?.role !== "leg")
    .slice(-Math.max(1, last))
    .toReversed();
}

// -------------------------------------------------------------- plan builder

/**
 * Operations with NO validated inverse surface — reported irreversible on
 * sight, before any per-record analysis. The reversibility matrix cross-checks
 * that these keys are EXACTLY the ops classed `irreversible` in
 * `reversibility.ts`, so the two catalogs cannot drift.
 */
export const IRREVERSIBLE: Partial<Record<string, string>> = {
  "area.delete": "areas are deleted permanently — there is nothing to restore (A25)",
  "tag.delete": "tags are deleted permanently — assignments already cascaded (A26)",
  "trash.empty": "emptying the Trash hard-deletes every row — nothing to restore (A27)",
  "heading.create":
    "a created heading can only be removed by deleting it, which has no headless surface " +
    "(heading delete is interactive-only) — archive it in the app instead",
  // NB: todo.clear-dated-reminder is NOT here — it IS reversible. The URL
  // scheme re-SETS a dated reminder (update?id=X&when=<date>@<time>, R17/R18),
  // so its inverse re-attaches the captured reminder to the item's current
  // schedule (see the todo.clear-dated-reminder case below). The old "dead on
  // every surface (scf2 P3a)" reason was false — P3a is only the Shortcuts
  // set-detail SET path; the URL SET path is alive.
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
  op: "todo.update" | "project.update" = "todo.update",
): { steps: UndoStep[]; notes: string[] } {
  const notes: string[] = [];
  const start = preField(record, "start");
  const startDate = preField(record, "startDate");
  const section = preField(record, "todaySection");
  const reminder = preField(record, "reminder");

  // start === "inbox" is a to-do-only pre-state (projects never live in the
  // Inbox), so the move step below stays a todo.move.
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
  return { steps: [{ op, params }], notes };
}

// ------------------------------------------------------- checklist inverses

interface ChecklistSpec {
  title: string;
  completed: boolean;
}

/** The current checklist as ordered {title, completed}. */
function currentChecklistSpecs(current: AnyTask): ChecklistSpec[] {
  if (current.type !== "to-do") return [];
  return (current.checklist ?? []).map((c) => ({
    title: c.title,
    completed: c.status === "completed",
  }));
}

/** Raw ordered statuses (open|completed|canceled) — matches getField/observed. */
function currentChecklistStatuses(current: AnyTask): string[] {
  if (current.type !== "to-do") return [];
  return (current.checklist ?? []).map((c) => c.status);
}

function arraysEqual(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Locate a checklist item by title, using the recorded 1-based `position` to
 * break duplicate-title ties. Returns the index, `-1` when absent, or `-2`
 * when the title is ambiguous and `position` does not disambiguate.
 */
function locateChecklistItem(items: ChecklistSpec[], title: string, position?: number): number {
  const matches = items.map((c, i) => ({ c, i })).filter(({ c }) => c.title === title);
  if (matches.length === 0) return -1;
  if (matches.length === 1) return (matches[0] as { i: number }).i;
  if (position !== undefined) {
    const exact = matches.find(({ i }) => i === position - 1);
    if (exact !== undefined) return exact.i;
  }
  return -2;
}

type ChecklistInverse =
  | { items: ChecklistSpec[] }
  | { conflict: { detail: string; remediation: string } };

const CHECKLIST_REMEDIATION =
  "review the item's current checklist; redo the change by hand if it's still wanted, or " +
  "re-run undo once the targeted item is back to its post-change state";

function conflict(detail: string): ChecklistInverse {
  return { conflict: { detail, remediation: CHECKLIST_REMEDIATION } };
}

/**
 * The TARGETED inverse of a granular checklist edit, applied to the CURRENT
 * list (a 3-way merge): only the item the edit touched is reverted; every
 * other item keeps its current state. Refuses (conflict) when the targeted
 * item itself moved out of band (toggled / renamed / removed) or a duplicate
 * title makes it ambiguous.
 */
function planChecklistItemInverse(record: AuditRecord, current: AnyTask): ChecklistInverse {
  const items = currentChecklistSpecs(current);
  const req = record.requested;
  const action = req["action"];
  const pre = record.pre ?? {};
  const observed = record.observed ?? {};
  const postTitle =
    typeof observed["title"] === "string" ? (observed["title"] as string) : undefined;
  const postPos =
    typeof observed["position"] === "number" ? (observed["position"] as number) : undefined;

  switch (action) {
    case "check":
    case "uncheck": {
      if (postTitle === undefined) return conflict("the audit record did not capture the target");
      const i = locateChecklistItem(items, postTitle, postPos);
      if (i === -1)
        return conflict(`the ${action}ed item "${postTitle}" is no longer in the checklist`);
      if (i === -2)
        return conflict(`"${postTitle}" is now a duplicate title — the target is ambiguous`);
      const wantCompleted = action === "check"; // post-state we expect to still hold
      if ((items[i] as ChecklistSpec).completed !== wantCompleted) {
        return conflict(`"${postTitle}" was changed out of band (no longer ${action}ed)`);
      }
      const next = items.map((c) => ({ ...c }));
      (next[i] as ChecklistSpec).completed = !wantCompleted; // toggle back to the pre-state
      return { items: next };
    }
    case "add": {
      if (postTitle === undefined)
        return conflict("the audit record did not capture the added item");
      const i = locateChecklistItem(items, postTitle, postPos);
      if (i === -1) return conflict(`the added item "${postTitle}" is no longer in the checklist`);
      if (i === -2)
        return conflict(`"${postTitle}" is now a duplicate title — the added item is ambiguous`);
      const next = items.map((c) => ({ ...c }));
      next.splice(i, 1);
      return { items: next };
    }
    case "remove": {
      const title = typeof pre["title"] === "string" ? (pre["title"] as string) : undefined;
      if (title === undefined) return conflict("the removed item's title was not captured");
      const at =
        typeof pre["position"] === "number" ? (pre["position"] as number) : items.length + 1;
      const next = items.map((c) => ({ ...c }));
      next.splice(Math.max(0, Math.min(next.length, at - 1)), 0, {
        title,
        completed: pre["completed"] === true,
      });
      return { items: next };
    }
    case "rename": {
      const oldTitle = typeof pre["title"] === "string" ? (pre["title"] as string) : undefined;
      if (postTitle === undefined || oldTitle === undefined) {
        return conflict("the rename's old/new titles were not captured");
      }
      const i = locateChecklistItem(items, postTitle, postPos);
      if (i === -1) return conflict(`no checklist item bears the new title "${postTitle}" anymore`);
      if (i === -2)
        return conflict(`"${postTitle}" is now a duplicate title — the target is ambiguous`);
      const next = items.map((c) => ({ ...c }));
      (next[i] as ChecklistSpec).title = oldTitle;
      return { items: next };
    }
    case "move": {
      const title = typeof req["title"] === "string" ? (req["title"] as string) : postTitle;
      const oldPos = typeof pre["position"] === "number" ? (pre["position"] as number) : undefined;
      if (title === undefined || oldPos === undefined) {
        return conflict("the move's title/old position were not captured");
      }
      const i = locateChecklistItem(items, title, postPos);
      if (i === -1) return conflict(`the moved item "${title}" is no longer in the checklist`);
      if (i === -2)
        return conflict(`"${title}" is now a duplicate title — the moved item is ambiguous`);
      // oxlint-disable-next-line no-map-spread -- cloning specs before splice, not mutating in place
      const next = items.map((c) => ({ ...c }));
      const [moved] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(next.length, oldPos - 1)), 0, moved as ChecklistSpec);
      return { items: next };
    }
    default:
      return conflict(`unknown checklist action "${String(action)}"`);
  }
}

/**
 * Tier-1 precondition for a WHOLESALE checklist undo: the current list
 * (titles + states, ordered) must still equal the recorded OBSERVED (post)
 * snapshot. ANY out-of-band difference blocks (monolith semantics — unlike the
 * granular path, which tolerates edits to other items). Returns the block
 * payload, or null when it passes / cannot be checked (legacy record).
 */
function wholesaleChecklistConflict(
  record: AuditRecord,
  current: AnyTask,
): { detail: string; remediation: string } | null {
  const obsTitles = record.observed?.["checklistTitles"];
  const obsStates = record.observed?.["checklistStates"];
  if (!Array.isArray(obsTitles) || !Array.isArray(obsStates)) return null; // legacy: can't verify
  const curTitles = currentChecklistSpecs(current).map((c) => c.title);
  const curStates = currentChecklistStatuses(current);
  if (arraysEqual(curTitles, obsTitles) && arraysEqual(curStates, obsStates)) return null;
  return {
    detail:
      "the checklist changed since the recorded replacement — refusing to avoid clobbering an " +
      "out-of-band edit (wholesale undo restores the whole list, so ANY difference blocks)",
    remediation:
      "review the current checklist; redo the change by hand if still wanted, or re-run undo " +
      "once the checklist matches its post-replacement state",
  };
}

/**
 * Build the inverse plan for one audit record. Pure — unit-testable.
 *
 * `current` is the target's CURRENT decoded state (runUndo loads it fresh).
 * Most ops invert from the recorded `pre`/`observed` alone and ignore it; the
 * exception is `todo.clear-dated-reminder`, whose inverse re-attaches the
 * cleared reminder to wherever the item is scheduled RIGHT NOW (not the date
 * it was cleared from), so it must read the live schedule.
 */
export function planUndo(
  record: AuditRecord,
  now: Date,
  allRecords: AuditRecord[] = [],
  current?: AnyTask | null,
): UndoPlan {
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
    case "todo.add-logged":
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
      // when/reminder restore reuses the schedule reconstructor (emitting a
      // project.update); projects never live in the Inbox so that branch is
      // unreachable here.
      if ((record.requested["when"] ?? record.requested["reminder"]) !== undefined) {
        const schedule = scheduleSteps(uuid, record, todayIso, "project.update");
        notes.push(...schedule.notes);
        const scheduleStep = schedule.steps[0];
        if (scheduleStep !== undefined) Object.assign(params, scheduleStep.params);
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

    case "project.set-tags": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const tags = preField(record, "tags");
      if (!Array.isArray(tags)) return irreversible("the pre-op tag set was not captured");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "project.set-tags", params: { uuid, tags } }],
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

    case "todo.backdate": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const patch: Record<string, unknown> = { uuid };
      const stoppedPre = preField(record, "stoppedDate");
      const createdPre = preField(record, "createdDate");
      if (typeof stoppedPre === "string") patch["completionDate"] = stoppedPre;
      if (typeof createdPre === "string") patch["creationDate"] = createdPre;
      if (patch["completionDate"] === undefined && patch["creationDate"] === undefined) {
        return irreversible("the pre-op timestamps were not captured");
      }
      notes.push(
        "timestamps restore at DAY precision (noon local) — the original sub-day time is " +
          "not recoverable",
      );
      return { target, kind: "invertible", steps: [{ op: "todo.backdate", params: patch }], notes };
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
      const titles = preField(record, "checklistTitles");
      if (!Array.isArray(titles)) return irreversible("the pre-op checklist was not captured");
      const states = preField(record, "checklistStates");
      // Restore titles AND per-item completion via the things:///json form
      // (P18) — the "state is unrecoverable (T07)" caveat is retired: T07 only
      // describes the classic `checklist-items=` form, which recreates items
      // open; json honors per-item `completed`. Legacy records without a
      // captured state array fall back to titles-only (all open).
      let items: unknown;
      if (Array.isArray(states) && states.length === titles.length) {
        items = titles.map((t, i) => ({ title: t, completed: states[i] === "completed" }));
        if (states.some((s) => s === "canceled")) {
          notes.push(
            "canceled checklist items are restored as OPEN (the item model has no canceled-create surface)",
          );
        }
      } else {
        items = titles;
        notes.push("only checklist TITLES were captured for this record — states restore as open");
      }
      // Tier-1 precondition: wholesale undo replaces the WHOLE list, so any
      // out-of-band change since the replacement blocks (decided at plan time
      // against the freshly-loaded current state).
      const block =
        current === undefined || current === null
          ? null
          : wholesaleChecklistConflict(record, current);
      return {
        target,
        kind: "invertible",
        steps: [
          {
            op: "todo.replace-checklist",
            params: { uuid, items },
            options: { acknowledgeChecklistReset: true, ...(block !== null && { blocked: block }) },
          },
        ],
        notes,
      };
    }

    case "todo.edit-checklist-item": {
      if (uuid === null) return irreversible("no target uuid recorded");
      if (current === undefined || current === null || current.type !== "to-do") {
        return irreversible(
          "the item no longer exists as a to-do — its checklist can't be restored",
        );
      }
      const resolved = planChecklistItemInverse(record, current);
      notes.push(
        "only the targeted item is inverted; every OTHER checklist item keeps its CURRENT state " +
          "(an out-of-band edit to a different item survives the undo)",
      );
      const items = "items" in resolved ? resolved.items : currentChecklistSpecs(current); // unused: the step is blocked below
      return {
        target,
        kind: "invertible",
        steps: [
          {
            op: "todo.replace-checklist",
            params: { uuid, items },
            options: {
              acknowledgeChecklistReset: true,
              ...("conflict" in resolved && { blocked: resolved.conflict }),
            },
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
      else if (parent === null && record.requested["parent"] !== undefined) {
        // The op nested a previously-root tag: un-nest it back (P29).
        patch["unnest"] = true;
      }
      // A captured pre-shortcut (string) re-binds whether the op changed or
      // cleared it; a null pre-shortcut with the op having SET one inverts to
      // a clear (A4 gave us the clear path).
      if (typeof shortcut === "string") patch["shortcut"] = shortcut;
      else if (shortcut === null && record.requested["shortcut"] !== undefined) {
        patch["clearShortcut"] = true;
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

    case "heading.rename": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const title = preField(record, "title");
      if (typeof title !== "string") return irreversible("the pre-op title was not captured");
      return {
        target,
        kind: "invertible",
        steps: [{ op: "heading.rename", params: { uuid, title } }],
        notes,
      };
    }

    case "heading.archive": {
      if (uuid === null) return irreversible("no target uuid recorded");
      const steps: UndoStep[] = [{ op: "heading.unarchive", params: { uuid } }];
      // Reopen exactly the children the cascade resolved (nested pre map —
      // the project.complete pattern). Reparented children live in leg
      // records; replay their inverses too when this summary heads a txn.
      const pre = record.pre ?? {};
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
      if (record.txn?.role === "summary") {
        const legs = allRecords.filter(
          (r) => r.txn?.id === record.txn?.id && r.txn?.role === "leg" && r.result === "ok",
        );
        const headingTitle = preField(record, "title");
        for (const leg of legs.toReversed()) {
          const project = (leg.requested["project"] as { uuid?: unknown } | undefined)?.uuid;
          if (leg.op === "todo.move" && leg.uuid !== null && typeof project === "string") {
            // Reparent leg: move the child back UNDER the heading (the step-1
            // unarchive precedes this; heading placement targets by NAME).
            steps.push({
              op: "todo.move",
              params: {
                uuid: leg.uuid,
                project: { uuid: project },
                ...(typeof headingTitle === "string" &&
                  headingTitle !== "" && { heading: headingTitle }),
              },
            });
            continue;
          }
          const legPlan = planUndo(leg, now, allRecords);
          if (legPlan.kind === "invertible") steps.push(...legPlan.steps);
          else notes.push(`leg ${leg.op} (${leg.uuid ?? "?"}) is not invertible: skipped`);
        }
        if (legs.length > 0) notes.push(`replays ${legs.length} compound leg(s) in reverse`);
      }
      if (steps.length > 1) {
        notes.push("cascade-resolved children reopen too (someday state survives — P11a)");
      }
      return { target, kind: "invertible", steps, notes };
    }

    case "heading.unarchive": {
      if (uuid === null) return irreversible("no target uuid recorded");
      notes.push(
        "re-archives the heading with children: complete — children reopened by the " +
          "unarchive re-resolve via the cascade",
      );
      return {
        target,
        kind: "invertible",
        steps: [{ op: "heading.archive", params: { uuid, children: "complete" } }],
        notes,
      };
    }

    case "todo.clear-dated-reminder": {
      if (uuid === null) return irreversible("no target uuid recorded");
      // The reminder we must put back is the pre-op reminder time captured by
      // the clear (atomic Shortcuts record OR the URL-bounce summary).
      const preReminder = preField(record, "reminder");
      if (typeof preReminder !== "string") {
        return irreversible("the pre-op reminder time was not captured — cannot restore it");
      }
      if (current === undefined || current === null || current.type !== "to-do") {
        return irreversible(
          "the item no longer exists as a to-do — the reminder can't be restored",
        );
      }
      if (isRepeatingTemplate(current)) {
        return irreversible(
          "the item is now a repeating template — a dated reminder can't be re-set on it",
        );
      }
      // Re-attach to the item's CURRENT schedule, NOT the recorded date: a
      // concrete date restores literally; today/evening restore via keyword
      // (which keeps the reminder-set path open — R17/R18).
      const startDate = current.startDate;
      if (startDate === null) {
        return irreversible(
          "the item is no longer scheduled (someday/anytime/inbox) — a dated reminder has no " +
            "date to attach to; re-schedule it, then re-add the reminder",
        );
      }
      const when =
        startDate === todayIso
          ? current.todaySection === "evening"
            ? "evening"
            : "today"
          : startDate;
      notes.push(
        "the reminder is restored on the item's CURRENT schedule (not moved back to the date it " +
          "was cleared from) — an out-of-band re-schedule is preserved",
      );
      return {
        target,
        kind: "invertible",
        steps: [{ op: "todo.update", params: { uuid, when, reminder: preReminder } }],
        notes,
      };
    }

    default:
      return irreversible(`no inverse is defined for operation "${record.op}"`);
  }
}

// ------------------------------------------------------ precondition guard

/** Content fields an inverse can silently CLOBBER; keyed to observed 1:1. */
const CLOBBER_FIELDS = ["title", "notes", "deadline", "reminder", "tags"] as const;

function fieldsEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

function formatValue(value: unknown): string {
  return value === null || value === undefined ? "none" : JSON.stringify(value);
}

/**
 * Refuse an inverse step that would overwrite a field an out-of-band edit has
 * already moved. For every CLOBBER_FIELD the step writes AND that the audit
 * `observed` (after-state) recorded, the target's CURRENT value must still
 * equal that after-value; a divergence means the world moved underneath us, so
 * we block rather than clobber. Fields absent from `observed` are skipped (we
 * cannot confirm them but must not break ops whose observed legitimately omits
 * them). Returns a blocked result on divergence, else null.
 */
function checkStepPrecondition(
  deps: WriteDeps,
  step: UndoStep,
  observed: Record<string, unknown> | null,
): MutationResult | null {
  if (observed === null) return null;
  const uuid = step.params["uuid"];
  if (typeof uuid !== "string") return null;
  const current = loadTarget(deps.db, uuid);
  if (current === null) return null; // vanished — the inverse's own verify handles it
  for (const field of CLOBBER_FIELDS) {
    if (!(field in step.params) || !(field in observed)) continue;
    const cur = getField(current, field) ?? null;
    const after = observed[field];
    if (!fieldsEqual(cur, after)) {
      return {
        kind: "blocked",
        op: step.op,
        reason: "environment",
        detail:
          `${field} changed since the recorded mutation (expected ${formatValue(after)}, found ` +
          `${formatValue(cur)}) — refusing to avoid clobbering an out-of-band edit`,
        remediation:
          "review the item's current state; redo the change by hand if it's still wanted, or " +
          "re-run undo once the field is back to its post-change value",
      };
    }
  }
  return null;
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
    // Fresh current state for the record's target (drives the clear-reminder
    // targeted restore, and is otherwise ignored by planUndo).
    const current = record.uuid === null ? null : loadTarget(deps.db, record.uuid);
    const plan = planUndo(record, now, records, current);
    let item: UndoItemResult;

    if (plan.kind === "irreversible") {
      item = { plan, results: [], outcome: "irreversible" };
    } else if (options.dryRun === true) {
      item = { plan, results: [], outcome: "dry-run" };
    } else {
      const results: (MutationResult | ReorderResult)[] = [];
      let failed = false;
      for (const step of plan.steps) {
        // Plan-time precondition (checklist undos): the inverse was resolved
        // against the current list and found a conflict — refuse, don't clobber.
        const planBlock = step.options?.blocked;
        if (planBlock !== undefined) {
          results.push({
            kind: "blocked",
            op: step.op,
            reason: "environment",
            detail: planBlock.detail,
            remediation: planBlock.remediation,
          });
          failed = true;
          break;
        }
        // Precondition guard: never clobber a field an out-of-band edit moved.
        const precondition = checkStepPrecondition(deps, step, record.observed);
        if (precondition !== null) {
          results.push(precondition);
          failed = true;
          break;
        }
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
