/**
 * Hazard guards — every one exists because a probe or validation note proved
 * the failure mode is real. Guards run against the pre-read; a blocked
 * result means the app was never touched.
 */
import { isUiDriveOp, type Acknowledgements, type OperationKind } from "./operations.ts";
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
  "H-HEADING-CHILDREN",
  "H-NO-REMINDER",
  "H-UI-DRIVE",
  "H-PROJECT-REPEAT",
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
const REPEAT_SENSITIVE = new Set<OperationKind>([
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
]);

const GUARDS: Record<HazardId, GuardFn> = {
  "H-REPEAT-SCHEDULE": ({ op, params, pre }) => {
    if (!isRepeatingTemplate(pre.target)) return null;
    const touchesSchedule =
      op === "todo.update" && (params["when"] !== undefined || params["deadline"] !== undefined);
    if (!touchesSchedule && !REPEAT_SENSITIVE.has(op)) return null;
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
      // todo.* ops must target actual to-dos. A HEADING uuid is the critical
      // case: URL writes silently no-op on type=2 rows (P10b/c), and an
      // AppleScript `schedule` on one is a SUSPECTED APP CRASH (P10b-b5,
      // connection died -609). Projects have their own commands.
      if (op.startsWith("heading.") && pre.target.type !== "heading") {
        problems.push(`target ${String(params["uuid"])} is a ${pre.target.type}, not a heading`);
      }
      if (op.startsWith("todo.") && op !== "todo.add" && pre.target.type !== "to-do") {
        problems.push(
          `target ${String(params["uuid"])} is a ${pre.target.type}, not a to-do` +
            (pre.target.type === "heading"
              ? " — heading rows only support rename/archive (see docs/lab/heading-research.md); scheduling one can crash Things"
              : " — use the project commands"),
        );
      }
      // Every project.* op (except project.add) must target a PROJECT. A
      // wrong-type uuid resolves cleanly (it is a real TMTask row) and would
      // otherwise compile a `project id` / update-project specifier around a
      // to-do or heading — undefined app behavior, and a heading in a
      // schedule-class specifier CRASHES Things (P11e). Guarded, not probed.
      if (op.startsWith("project.") && op !== "project.add" && pre.target.type !== "project") {
        problems.push(
          `target ${String(params["uuid"])} is a ${pre.target.type}, not a project` +
            (pre.target.type === "to-do"
              ? " — use the `things todo` commands"
              : pre.target.type === "heading"
                ? " — use the `things heading` commands"
                : ""),
        );
      }
      // State preconditions once the target IS a project (E14/E15/E17, P01–P07).
      if (
        op === "project.cancel" &&
        pre.target.type === "project" &&
        pre.target.status !== "open"
      ) {
        // Only open->canceled is probed (P01); re-canceling resolved projects is unvalidated.
        problems.push(
          `target project is already ${pre.target.status} — cancel needs an open project`,
        );
      }
      if (op === "project.reopen" && pre.target.type === "project") {
        if (pre.target.status === "open") {
          problems.push("target project is already open — nothing to reopen");
        }
        if (pre.target.trashed) {
          problems.push(
            "target project is in the Trash — restore it first (things project restore)",
          );
        }
      }
      if (op === "project.restore" && pre.target.type === "project" && !pre.target.trashed) {
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
  "H-HEADING-CHILDREN": ({ op, params, pre }) => {
    if (op !== "heading.archive" || pre.openChildren.length === 0) return null;
    const policy = params["children"];
    if (policy === "complete" || policy === "cancel") return null;
    if (policy === "reparent") {
      // The orchestrator drains children first; open ones remaining here
      // means it was bypassed (direct pipeline call).
      return {
        hazard: "H-HEADING-CHILDREN",
        detail:
          `the heading still has ${pre.openChildren.length} open child(ren) — the reparent ` +
          "policy is served by the heading-archive orchestrator, which moves them to the " +
          "project root first",
        remediation: "use write.archiveHeading / `things heading archive` (not a raw run)",
      };
    }
    return {
      hazard: "H-HEADING-CHILDREN",
      detail:
        `archiving this heading affects ${pre.openChildren.length} open child(ren) — the ` +
        "app cascades their resolution with the heading's",
      remediation:
        "pass children: complete (cascade completes them), cancel (the app's " +
        "cancel-cascade marks them canceled), or reparent (move them to the project root " +
        "first, keeping them open)",
    };
  },
  "H-NO-REMINDER": ({ op, pre }) => {
    if (op !== "todo.clear-dated-reminder") return null;
    const target = pre.target;
    // Type/existence problems are H-UNKNOWN-DESTINATION's job; here we only
    // guard the no-op: clearing a reminder that isn't set would verify
    // trivially (already null) without anything having happened.
    if (target === null || target.type !== "to-do" || target.reminder !== null) return null;
    return {
      hazard: "H-NO-REMINDER",
      detail: "this to-do has no reminder to clear",
      remediation: "target a to-do that has a time-of-day reminder set",
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
        "mixes to-dos and projects in one request — only same-type reorders are validated " +
          "for the area (O05/O10 vs O14) and someday (P8b vs P9e — the two types even " +
          "stack in opposite directions) scopes; issue two requests instead",
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
  "H-PROJECT-REPEAT": ({ op, pre }) => {
    if (op !== "project.make-repeating") return null;
    const tax = pre.projectRepeat;
    if (tax === null) return null; // classified in preRead; absent only for a non-project target (H-UNKNOWN-DESTINATION covers it)
    if (tax.kind === "area" || tax.kind === "someday") return null;
    if (tax.kind === "anytime") {
      // A direct drive can't reach an area-less anytime project's row (it renders
      // as a header, UIC4-d). The orchestrator coerces it to Someday first.
      return {
        hazard: "H-PROJECT-REPEAT",
        detail:
          "this project is an area-less Anytime project — it has no selectable row in the " +
          "Anytime view (it renders as a header, UIC4-d), so the pure-AX drive cannot reach it",
        remediation:
          "use `things project make-repeating` (the client's makeRepeatingProject), which moves " +
          "it to Someday first — a cleanup-free intermediate step — then drives it",
      };
    }
    const remediation =
      tax.refusal === "ambiguous-row"
        ? "rename one of the same-titled projects so the target's row is unambiguous"
        : tax.refusal === "already-repeating"
          ? "the project already repeats — use `things project reschedule-repeat` to change its rule"
          : "target an open, un-trashed project";
    return { hazard: "H-PROJECT-REPEAT", detail: tax.detail, remediation };
  },
  "H-UI-DRIVE": ({ op, acks }) => {
    if (!isUiDriveOp(op) || acks.dangerouslyDriveGui === true) return null;
    return {
      hazard: "H-UI-DRIVE",
      detail:
        "this operation drives the local Things app through the Accessibility API — it may " +
        "briefly interact with the app's UI. On current evidence (AXVM1) menu-path element " +
        "presses do NOT steal window focus and work even under a locked session; the " +
        "repeating-PROJECT ops additionally move the pointer and bring Things to the foreground " +
        "to open its custom repeat menu (NATIVE1), so they need an unlocked session with the " +
        "display awake. It is gated because it drives the real GUI",
      remediation:
        "pass dangerouslyDriveGui (--dangerously-drive-gui) to proceed; the vector also " +
        "requires `things config set ui-enabled true` and Accessibility granted to this " +
        "process (see docs/setup.md)",
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
