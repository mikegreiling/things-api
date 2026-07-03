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
    if (op !== "project.complete") return null;
    if (pre.openChildren.length === 0) return null;
    if (params["children"] === "auto-complete") return null;
    return {
      hazard: "H-PROJECT-COMPLETE-CHILDREN",
      detail:
        `project has ${pre.openChildren.length} open child to-do(s); URL completion would ` +
        "silently auto-complete them (no prompt, unlike the UI — T08/U08)",
      remediation:
        "resolve the children first, or pass children='auto-complete' (--children auto-complete)",
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
