/**
 * Hazard guards — every one exists because a probe or validation note proved
 * the failure mode is real. Guards run against the pre-read; a blocked
 * result means the app was never touched.
 */
import type { Acknowledgements, OperationKind } from "./operations.ts";
import { isRepeatingTemplate, type PreState } from "./pre-state.ts";

export const HAZARD_IDS = [
  "H-REPEAT-SCHEDULE",
  "H-PROJECT-COMPLETE-CHILDREN",
  "H-CHECKLIST-REPLACE",
  "H-REOPEN-RESOLVED-PROJECT",
  "H-UNKNOWN-TAG",
  "H-UNKNOWN-DESTINATION",
  "H-AMBIGUOUS-HEADING",
  "H-PERMANENT-DELETE",
  "H-REORDER-SCOPE",
  "H-REMINDER-SCOPE",
  "H-TAG-SUBTREE-DELETE",
  "H-BACKDATE-OPEN",
] as const;

export type HazardId = (typeof HAZARD_IDS)[number];

export interface GuardBlock {
  hazard: HazardId;
  detail: string;
  remediation: string;
}

export interface GuardInput {
  op: OperationKind;
  params: Record<string, unknown>;
  pre: PreState;
  acks: Acknowledgements;
}

type GuardFn = (input: GuardInput) => GuardBlock | null;

/** Ops where a schedule/status-class write on a repeating template is destructive. */
const REPEAT_SENSITIVE: OperationKind[] = [
  "todo.complete",
  "todo.cancel",
  "todo.reopen",
  "todo.move",
  "todo.delete",
  "todo.duplicate", // unvalidated on templates (E07 probed a plain to-do)
  "todo.restore", // unvalidated on templates (E15 probed a plain to-do)
  "project.move", // unvalidated on repeating projects (E14 probed a plain project)
  "project.duplicate", // unvalidated on repeating projects (E17 probed a plain project)
  "project.cancel", // unvalidated on repeating projects (P01 probed a plain project)
  "project.reopen", // unvalidated on repeating projects (P02/P05 probed plain projects)
  "project.restore", // unvalidated on repeating projects (P06 probed a plain project)
];

const GUARDS: Record<HazardId, GuardFn> = {
  "H-REPEAT-SCHEDULE": ({ op, params, pre }) => {
    if (!isRepeatingTemplate(pre.target)) return null;
    const touchesSchedule =
      op === "todo.update" && (params["when"] !== undefined || params["deadline"] !== undefined);
    if (!touchesSchedule && !REPEAT_SENSITIVE.includes(op)) return null;
    return {
      hazard: "H-REPEAT-SCHEDULE",
      detail:
        "target is a repeating template: URL scheduling writes crash Things (T12/U12); " +
        "status/move/delete on templates are unvalidated",
      remediation:
        "edit the repeat rule in the Things app; title/notes updates and checklist " +
        "replacement remain allowed on templates",
    };
  },
  "H-PROJECT-COMPLETE-CHILDREN": ({ op, params, pre }) => {
    if (op !== "project.complete" && op !== "project.cancel") return null;
    if (pre.openChildren.length === 0) return null;
    const auto = op === "project.complete" ? "auto-complete" : "auto-cancel";
    if (params["children"] === auto) return null;
    return {
      hazard: "H-PROJECT-COMPLETE-CHILDREN",
      detail:
        `project has ${pre.openChildren.length} open child to-do(s); the URL write would ` +
        `silently ${op === "project.complete" ? "auto-complete" : "auto-cancel"} them ` +
        "(no prompt, unlike the UI — T08/U08, P01)",
      remediation: `resolve the children first, or pass children='${auto}' (--children ${auto})`,
    };
  },
  "H-CHECKLIST-REPLACE": ({ op, pre, acks }) => {
    if (op !== "todo.replace-checklist") return null;
    if (pre.checklistCount === 0 || acks.acknowledgeChecklistReset === true) return null;
    return {
      hazard: "H-CHECKLIST-REPLACE",
      detail:
        `target has ${pre.checklistCount} existing checklist item(s); replacement is wholesale ` +
        "and destroys per-item completion state (T07/U07)",
      remediation: "pass acknowledgeChecklistReset (--acknowledge-checklist-reset)",
    };
  },
  "H-REOPEN-RESOLVED-PROJECT": ({ op, pre, acks }) => {
    if (op !== "todo.add" && op !== "todo.move") return null;
    const dest = pre.destProject?.resolved;
    if (dest === undefined || dest === null) return null;
    const status = pre.destProjectStatus;
    if (status === null || status === "open") return null;
    if (acks.acknowledgeProjectReopen === true) return null;
    return {
      hazard: "H-REOPEN-RESOLVED-PROJECT",
      detail: `destination project "${dest.title}" is ${status}; adding an open child reopens it (T19/U19)`,
      remediation: "pass acknowledgeProjectReopen (--acknowledge-project-reopen)",
    };
  },
  "H-UNKNOWN-TAG": ({ pre }) => {
    if (pre.missingTags.length === 0) return null;
    return {
      hazard: "H-UNKNOWN-TAG",
      detail:
        `tag(s) not found: ${pre.missingTags.join(", ")} — the app silently ignores unknown ` +
        "tags (T03/U03), so this would be a partial write",
      remediation: "create the tag first (things tag add) or fix the spelling",
    };
  },
  "H-UNKNOWN-DESTINATION": ({ op, params, pre }) => {
    const problems: string[] = [];
    if (pre.destProject !== null && pre.destProject.resolved === null) {
      problems.push(
        pre.destProject.matches > 1 ? "project reference is ambiguous" : "project not found",
      );
    }
    if (pre.destArea !== null && pre.destArea.resolved === null) {
      problems.push(pre.destArea.matches > 1 ? "area reference is ambiguous" : "area not found");
    }
    if (pre.entityTarget !== null && pre.entityTarget.resolved === null) {
      problems.push(
        pre.entityTarget.matches > 1 ? "target reference is ambiguous" : "target not found",
      );
    }
    const needsTarget =
      typeof params["uuid"] === "string" &&
      op !== "todo.add" &&
      op !== "project.add" &&
      pre.target === null;
    if (needsTarget) problems.push(`no record with uuid ${String(params["uuid"])}`);
    if (pre.target !== null) {
      // Type/state preconditions for the Tier-2 ops: the probed commands
      // address `project id` / trashed `to do id` specifically (E14/E15/E17).
      if ((op === "project.move" || op === "project.duplicate") && pre.target.type !== "project") {
        problems.push(`target ${String(params["uuid"])} is a ${pre.target.type}, not a project`);
      }
      if (
        (op === "project.cancel" || op === "project.reopen" || op === "project.restore") &&
        pre.target.type !== "project"
      ) {
        problems.push(`target ${String(params["uuid"])} is a ${pre.target.type}, not a project`);
      } else if (op === "project.cancel" && pre.target.type === "project") {
        // Only open->canceled is probed (P01); re-canceling resolved
        // projects is unvalidated.
        if (pre.target.status !== "open") {
          problems.push(
            `target project is already ${pre.target.status} — cancel needs an open project`,
          );
        }
      } else if (op === "project.reopen" && pre.target.type === "project") {
        if (pre.target.status === "open") {
          problems.push("target project is already open — nothing to reopen");
        }
        if (pre.target.trashed) {
          problems.push(
            "target project is in the Trash — restore it first (things project restore)",
          );
        }
      } else if (op === "project.restore" && pre.target.type === "project" && !pre.target.trashed) {
        problems.push(
          `target ${String(params["uuid"])} is not in the Trash — restore only applies to ` +
            "trashed projects",
        );
      }
      if (op === "todo.restore") {
        if (pre.target.type !== "to-do") {
          problems.push(
            `target ${String(params["uuid"])} is a ${pre.target.type} — restore is only ` +
              "validated for to-dos (E15); restore a trashed project via the app",
          );
        } else if (!pre.target.trashed) {
          problems.push(
            `target ${String(params["uuid"])} is not in the Trash — restore only applies to ` +
              "trashed to-dos (a live item would just be de-scheduled into the Inbox)",
          );
        }
      }
    }
    if (problems.length === 0) return null;
    return {
      hazard: "H-UNKNOWN-DESTINATION",
      detail: `${problems.join("; ")} — unknown destinations are silent no-ops in the app (T06/U06)`,
      remediation: "verify the uuid/name with `things search` or `things areas`/`things projects`",
    };
  },
  "H-AMBIGUOUS-HEADING": ({ pre }) => {
    if (pre.destHeading === null) return null;
    if (pre.destHeading.resolved !== null) return null;
    return {
      hazard: "H-AMBIGUOUS-HEADING",
      detail:
        pre.destHeading.matches > 1
          ? "multiple headings with that name exist in the destination project"
          : "heading not found in the destination project (the heading param never creates one — T09/U09)",
      remediation: "rename the duplicate headings, or omit --heading",
    };
  },
  "H-REMINDER-SCOPE": ({ op, params }) => {
    if (op !== "todo.add" && op !== "todo.update" && op !== "project.update") return null;
    if (!("reminder" in params) || params["reminder"] === undefined) return null;
    const when = params["when"];
    const isDate = typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when);
    if (params["reminder"] === null) {
      // The clear IS a bare when= write — but only today/evening honor it;
      // dated reminders are STICKY (persist through same-date AND re-dated
      // bare when=, R20/R21). No URL clear path exists for them.
      if (when === "today" || when === "evening") return null;
      return {
        hazard: "H-REMINDER-SCOPE",
        detail: isDate
          ? "dated reminders cannot be cleared via the URL scheme — they persist through " +
            "bare when= re-schedules (R20/R21)"
          : "clearing a reminder IS a bare when= write (R07) — when: today|evening must be " +
            "re-stated in the same call",
        remediation: isDate
          ? "re-schedule with `--when today --clear-reminder` first (then re-date), or clear " +
            "it in the app"
          : "pass when today|evening together with --clear-reminder",
      };
    }
    if (when === "today" || when === "evening" || isDate) return null;
    return {
      hazard: "H-REMINDER-SCOPE",
      detail:
        "reminders require a scheduled when: today|evening|YYYY-MM-DD (R-suite; " +
        "anytime/someday carry no date for the reminder to attach to)",
      remediation: "pass when today|evening|YYYY-MM-DD together with the reminder",
    };
  },
  "H-BACKDATE-OPEN": ({ op, params, pre }) => {
    if (op !== "todo.backdate" || params["completionDate"] === undefined) return null;
    const status = pre.target?.type === "to-do" ? pre.target.status : null;
    if (status === "completed" || status === "canceled") return null;
    return {
      hazard: "H-BACKDATE-OPEN",
      detail:
        "completionDate can only be rewritten on a completed or canceled to-do — this one " +
        `is ${status ?? "not a to-do / not found"}`,
      remediation: "complete it first (todo.complete), then backdate",
    };
  },
  "H-REORDER-SCOPE": ({ op, params, pre }) => {
    if (op !== "reorder" || pre.reorder === null) return null;
    const problems: string[] = [];
    // The `reorder` operation IS the native private command. Evening must
    // never reach it: a native reorder normalizes startBucket to the Today
    // list, silently de-evening-ing members (O03). The evening scope is
    // served by the bounce orchestrator in reorder.ts instead.
    if (params["scope"] === "evening") {
      return {
        hazard: "H-REORDER-SCOPE",
        detail:
          "evening reorder is bounce-only: the native command would silently clear " +
          "startBucket on every listed item (O03)",
        remediation: "use write.reorder / `things reorder --scope evening` (bounce strategy)",
      };
    }
    if (
      (params["scope"] === "today" ||
        params["scope"] === "evening" ||
        params["scope"] === "inbox" ||
        params["scope"] === "someday" ||
        params["scope"] === "projects") &&
      params["container"] !== undefined
    ) {
      problems.push("container is only valid for project/area/headings scopes");
    }
    const uuids = params["uuids"];
    if (!Array.isArray(uuids) || uuids.length === 0) {
      problems.push("no uuids given");
    }
    if (pre.reorder.duplicates.length > 0) {
      problems.push(`duplicated uuid(s): ${pre.reorder.duplicates.join(", ")}`);
    }
    if (pre.reorder.mixedTypes) {
      problems.push(
        "mixes to-dos and projects in one area reorder — only same-type area reorders are " +
          "validated (O05/O10 to-dos, O14 projects); issue two requests instead",
      );
    }
    for (const r of pre.reorder.rejected) {
      problems.push(`${r.uuid} ${r.reason}`);
    }
    if (problems.length === 0) return null;
    return {
      hazard: "H-REORDER-SCOPE",
      detail:
        `reorder request rejected — every uuid must be an eligible member of the scope, ` +
        `exactly once: ${problems.join("; ")}`,
      remediation:
        "read the scope first (things today / things project-view / things area) and pass " +
        "only its eligible members in the desired order",
    };
  },
  "H-TAG-SUBTREE-DELETE": ({ op, pre, acks }) => {
    if (op !== "tag.delete") return null;
    if (pre.childTags.length === 0 || acks.acknowledgeTagSubtree === true) return null;
    return {
      hazard: "H-TAG-SUBTREE-DELETE",
      detail:
        `deleting this tag CASCADE-DELETES its ${pre.childTags.length} descendant tag(s) ` +
        `permanently (P16): ${pre.childTags.join(", ")}`,
      remediation:
        "re-parent the children first (things tag update <child> --parent <new>), or pass " +
        "acknowledgeTagSubtree (--acknowledge-subtree) to delete the whole subtree",
    };
  },
  "H-PERMANENT-DELETE": ({ op, acks }) => {
    if (op !== "area.delete" && op !== "tag.delete" && op !== "trash.empty") return null;
    if (acks.dangerouslyPermanent === true) return null;
    const what =
      op === "trash.empty"
        ? "empty-trash hard-deletes every trashed row"
        : `${op === "area.delete" ? "areas" : "tags"} are deleted PERMANENTLY (no Trash, A25/A26)`;
    return {
      hazard: "H-PERMANENT-DELETE",
      detail: `${what}; no tombstones are written while sync is off`,
      remediation: "pass dangerouslyPermanent (--dangerously-permanent) to proceed",
    };
  },
};

export function evaluateGuards(hazards: HazardId[], input: GuardInput): GuardBlock | null {
  for (const id of hazards) {
    const guard = GUARDS[id];
    const block = guard(input);
    if (block !== null) return block;
  }
  return null;
}
