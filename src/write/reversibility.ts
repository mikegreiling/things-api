/**
 * Reversibility matrix — the source-of-truth classification of every write
 * operation by how faithfully `things undo` can invert it. This is the
 * reversibility analog of `docs/capability-matrix.md`: one TOTAL record over
 * `OperationKind`, so a new op is a COMPILE error until it is classified here
 * (and the matrix test suite refuses to pass until it is also round-tripped).
 *
 * The classes are DERIVED FROM `undo.ts` reality (planUndo), not aspiration —
 * see `test/unit/reversibility-matrix.test.ts`, which proves each entry with a
 * do/undo round-trip, an anti-clobber precondition probe, and (for the
 * conditional/irreversible rows) both branches.
 *
 * This table is shaped for later surfacing (a `things capabilities`
 * reversibility column / a generated docs table) but is deliberately NOT wired
 * into any consumer yet — that is parked (see docs/roadmap.md).
 */
import type { OperationKind } from "./operations.ts";

export type ReversibilityClass =
  /** Undo restores the pre-op state exactly (identity on the touched fields). */
  | "reversible"
  /** Undo restores the intent, but a documented dimension is unrecoverable. */
  | "reversible-with-loss"
  /** Reversibility depends on captured/current state — has a real irreversible branch. */
  | "conditional"
  /** No validated inverse surface — planUndo reports it irreversible on sight. */
  | "irreversible";

export interface ReversibilityEntry {
  class: ReversibilityClass;
  /** One-line honest summary of the inverse and its limits. */
  note: string;
  /**
   * Acknowledgement the inverse itself demands:
   *  - "permanent"      — the inverse is a PERMANENT delete (area/tag add),
   *                       gated behind --dangerously-permanent.
   *  - "checklist-reset" — the inverse rewrites the whole checklist and needs
   *                       acknowledgeChecklistReset.
   */
  ack?: "permanent" | "checklist-reset";
}

/**
 * TOTAL over OperationKind — adding a kind to OPERATION_KINDS without a row
 * here is a compile error. Keep the notes honest to planUndo's actual behavior.
 */
export const REVERSIBILITY: Record<OperationKind, ReversibilityEntry> = {
  // ---- creations: inverse is a delete -------------------------------------
  "todo.add": {
    class: "reversible",
    note: "inverse sends the created to-do to the Trash (restorable); irreversible only if the created uuid was never discovered",
  },
  "todo.duplicate": {
    class: "reversible",
    note: "inverse deletes the copy to the Trash; irreversible only if the copy's uuid was never discovered",
  },
  "project.add": {
    class: "reversible",
    note: "inverse deletes the project (and any children it carried) to the Trash",
  },
  "project.duplicate": {
    class: "reversible",
    note: "inverse deletes the duplicated project to the Trash",
  },
  "todo.clone": {
    class: "reversible",
    note: "inverse trashes the minted clone to-do (single leg); irreversible only if the clone's uuid was never discovered",
  },
  "project.clone": {
    class: "reversible",
    note: "inverse trashes the minted clone project (and the children it carried) to the Trash; irreversible only if the clone's uuid was never discovered",
  },
  "area.add": {
    class: "reversible",
    ack: "permanent",
    note: "inverse deletes the area PERMANENTLY (areas skip the Trash, A25) — requires --dangerously-permanent",
  },
  "tag.add": {
    class: "reversible",
    ack: "permanent",
    note: "inverse deletes the tag PERMANENTLY (tags skip the Trash, A26) — requires --dangerously-permanent",
  },

  // ---- status flips -------------------------------------------------------
  "todo.complete": {
    class: "reversible",
    note: "inverse reopens the to-do (only when it was open pre-op — otherwise nothing to restore)",
  },
  "todo.cancel": {
    class: "reversible",
    note: "inverse reopens the to-do (only when it was open pre-op)",
  },
  "todo.reopen": {
    class: "reversible",
    note: "inverse re-completes or re-cancels per the captured pre-op status",
  },
  "project.complete": {
    class: "reversible",
    note: "inverse reopens the project and re-opens exactly the children the completion cascade resolved",
  },
  "project.cancel": {
    class: "reversible",
    note: "inverse reopens the project and re-opens exactly the children the cancel cascade resolved",
  },
  "project.reopen": {
    class: "reversible",
    note: "inverse re-completes/re-cancels (require-resolved) per the captured pre-op status; blocks if children were reopened since",
  },

  // ---- delete / restore ---------------------------------------------------
  "todo.delete": {
    class: "reversible-with-loss",
    note: "inverse restores from the Trash but lands in the Inbox DE-SCHEDULED (E15) — the prior list/schedule was not captured by the delete. EXCEPTION: deleting a repeating TEMPLATE is IRREVERSIBLE headlessly (the app forbids restoring a template out to a list, AS 301) — no undo token is emitted and the result discloses Trash ▸ Put Back as the only revival (SERDEL S2/S3, ruling 2026-08-13)",
  },
  "todo.restore": { class: "reversible", note: "inverse re-deletes the to-do to the Trash" },
  "project.delete": {
    class: "reversible",
    note: "inverse restores the project IN PLACE (P06) — schedule/area/children keep their state. EXCEPTION: deleting a repeating project TEMPLATE is IRREVERSIBLE headlessly (Put Back only) — no undo token, disclosed in the result (ruling 2026-08-13)",
  },
  "project.restore": { class: "reversible", note: "inverse re-deletes the project to the Trash" },

  // ---- field updates ------------------------------------------------------
  "todo.update": {
    class: "reversible-with-loss",
    note: "restores title/notes/deadline/schedule from pre-values; a STALE evening bucket cannot be restored (today-only) and a dated reminder the op SET cannot be cleared (sticky, R20/R21)",
  },
  "project.update": {
    class: "reversible-with-loss",
    note: "restores title/notes/deadline/schedule from pre-values; a dated reminder the op SET cannot be cleared on undo (sticky)",
  },
  "todo.set-tags": { class: "reversible", note: "inverse restores the captured pre-op tag set" },
  "project.set-tags": {
    class: "reversible",
    note: "inverse restores the captured pre-op tag set",
  },
  "area.update": {
    class: "reversible",
    note: "inverse restores the captured pre-op title/tags",
  },
  "tag.update": {
    class: "reversible",
    note: "inverse restores the captured pre-op title/parent/shortcut (irreversible only if none were captured)",
  },
  "project.rename-heading": {
    class: "reversible",
    note: "inverse renames the heading back to the captured pre-op title",
  },
  "todo.set-dates": {
    class: "reversible-with-loss",
    note: "inverse restores the completion/creation timestamps at DAY precision (noon local) — the original sub-day time is not recoverable",
  },
  "project.set-dates": {
    class: "reversible-with-loss",
    note: "inverse restores the completion/creation timestamps at DAY precision (noon local) — the original sub-day time is not recoverable",
  },

  // ---- moves (prior container may be uncaptured) --------------------------
  "todo.move": {
    class: "conditional",
    note: "invertible when the pre-op container was captured (project/area moves, detach, inbox-with-schedule); irreversible when only the destination-kind field was audited; heading placement is never restored",
  },
  "project.move": {
    class: "conditional",
    note: "invertible when the pre-op area was captured (or none-before → detach, P24); irreversible when the pre-op area was not captured",
  },

  // ---- checklists ---------------------------------------------------------
  "todo.replace-checklist": {
    class: "reversible-with-loss",
    ack: "checklist-reset",
    note: "restores titles AND per-item completion via the json form (P18); canceled items round-trip as OPEN (no canceled-create surface); wholesale precondition refuses on ANY out-of-band checklist difference",
  },
  "todo.edit-checklist-item": {
    class: "conditional",
    ack: "checklist-reset",
    note: "targeted 3-way-merge inverse against the live list (an edit to a DIFFERENT item survives); refuses (blocked) when the targeted item itself moved out of band or a duplicate title makes it ambiguous, or when the to-do no longer exists",
  },

  // ---- reorder ------------------------------------------------------------
  reorder: {
    class: "conditional",
    note: "invertible when pre-ranks were captured (native reorders + bounce summaries that recorded pre-ranks); irreversible for bounce summaries with no recorded pre-ranks",
  },
  "area.reorder": {
    class: "conditional",
    note: "invertible when the pre-move area order was fully determined (the full ordered area list is captured; the inverse drags the area back before its old successor — order is the invariant that round-trips, index values are not, AXDRAG1-f); irreversible when areas were still unranked (all-zero index) before the move",
  },

  // ---- headings -----------------------------------------------------------
  "project.archive-heading": {
    class: "reversible-with-loss",
    note: "inverse unarchives and reopens exactly the cascade-resolved children (someday survives, P11a); reparented children return matched BY heading name, and their in-heading order is not guaranteed",
  },
  "project.unarchive-heading": {
    class: "reversible",
    note: "inverse re-archives (children: complete) — children the unarchive reopened re-resolve via the cascade",
  },
  "project.move-heading": {
    class: "conditional",
    note: "invertible when pre-move heading ranks were captured — the inverse restores the prior heading order (children follow); irreversible when the project's headings were still unranked before the move",
  },

  // ---- clear dated reminder (orchestrated) --------------------------------
  "todo.clear-dated-reminder": {
    class: "conditional",
    note: "invertible by re-setting the captured reminder on the item's CURRENT schedule (URL when=<date>@<time>, R17/R18); irreversible once the item is de-scheduled (someday/anytime/inbox), is now a repeating template, or its reminder was never captured",
  },

  // ---- irreversible (no validated inverse surface) ------------------------
  "area.delete": {
    class: "irreversible",
    note: "areas are deleted permanently — there is nothing to restore (A25)",
  },
  "tag.delete": {
    class: "irreversible",
    note: "tags are deleted permanently — assignments already cascaded (A26)",
  },
  "trash.empty": {
    class: "irreversible",
    note: "emptying the Trash hard-deletes every row — nothing to restore (A27)",
  },
  "project.add-heading": {
    class: "irreversible",
    note: "a created heading has no headless delete surface (heading delete is interactive-only) — archive it in the app instead",
  },
  "todo.convert-to-project": {
    class: "irreversible",
    note: "converting a to-do to a project is an identity REPLACEMENT (UI2-d): the to-do uuid is destroyed and a new project uuid is born (notes preserved); the app offers no convert-back",
  },
  "project.promote-heading": {
    class: "irreversible",
    note: "promoting a heading to a project is an identity REPLACEMENT (UI2-d): the heading uuid is destroyed, a new project is promoted into the parent's area and children reparent; no convert-back",
  },
  "project.move-heading-to-project": {
    class: "irreversible",
    note: "moving a heading to another project (HEADXPROJ ellipsis Move…) is a single heading-row project-FK rewrite (children follow via their intact heading FK) and is APP-reversible — move it back — but NO automated inverse is wired: the GUI drive is not re-driven on undo. Move it back manually with `project move-heading-to-project`, origin and destination swapped",
  },
  "project.dissolve-heading": {
    class: "irreversible",
    note: "dissolving a heading (DISS1 ellipsis Delete) HARD-DELETES the heading row while its children become direct project children (heading→NULL, project→parent, index preserved, NOT trashed — contrast the Shortcuts delete cascade P12, which trashes them). No automated inverse: the compound restore (re-create the heading + move the ex-children back in order) spans surfaces and is not wired. Nothing is lost — the children survive; re-create + re-home in the app to reverse",
  },
  "todo.reschedule-repeat": {
    class: "conditional",
    note: "the rule mutates in place (identity preserved, UI2-b); the FULL rule vocabulary re-drives reschedule with the captured prior rule (weekday set, monthly/yearly anchor, ends bound, deadline/start-offset all restored) — invertible whenever the prior rule was captured, decodable, and within the Repeat dialog's vocabulary; irreversible for a rule the dialog itself cannot produce (two end bounds, a multi-anchor month/year rule, or an after-completion rule with a calendar day). A per-instance reminder time is not part of the captured rule and is not restored",
  },
  "project.reschedule-repeat": {
    class: "conditional",
    note: "the project's rule mutates in place (identity preserved, UIC2-a); re-drives reschedule with the captured prior rule (same faithfulness boundary as todo.reschedule-repeat) — invertible when the prior rule was captured, decodable, and dialog-expressible; irreversible otherwise. A per-instance reminder time is not restored",
  },

  // ---- promote-via-clone (make/add-repeating) → undo is trash-both (+restore) --
  "todo.make-repeating": {
    class: "reversible-with-loss",
    note: "promote-via-clone: the minted template + its current instance are the inverse's target — undo TRASHES BOTH (the SERDEL trash-both) and restores the original to-do from the Trash (it lands in the Inbox DE-SCHEDULED, E15). The trashed template leaves no tombstone and its own un-delete is GUI-only (Trash ▸ Put Back), so this undo cannot itself be undone headlessly",
  },
  "project.make-repeating": {
    class: "reversible-with-loss",
    note: "promote-via-clone: undo TRASHES the minted template + its current instance (trash-both) and restores the original project IN PLACE (P06). The trashed template leaves no tombstone and its own un-delete is GUI-only (Put Back), so this undo cannot itself be undone headlessly",
  },
  "todo.add-repeating": {
    class: "reversible",
    note: "the composite creates a to-do then promotes it; undo TRASHES the minted template + its current instance (SERDEL trash-both) — the whole created series moves to the Trash. Re-creating the series is GUI-only (the template leaves no tombstone; use Trash ▸ Put Back), so this undo is not itself headlessly undoable",
  },
  "project.add-repeating": {
    class: "reversible",
    note: "the composite creates a project then promotes it; undo TRASHES the minted template + its current instance (SERDEL trash-both) — the whole created series moves to the Trash. Re-creating the series is GUI-only, so this undo is not itself headlessly undoable",
  },

  // ---- ui-vector reversible pairs -----------------------------------------
  "todo.create-next-copy": {
    class: "irreversible",
    note: "materializing the pending occurrence cannot be undone headlessly (CNC1 §7): the minted row would have to be HARD-deleted (trashing it leaves a Trash row the series still counts) and BOTH template cursor columns rewound — rt1_nextInstanceStartDate and rt1_instanceCreationStartDate — neither of which any write surface reaches. The app's own ⌘Z is a complete inverse (REPX3 §4.1) and ours structurally cannot be",
  },
  "todo.pause-repeat": {
    class: "reversible",
    note: "inverse resumes the repeat (UI2-c): pause sets instance-creation paused, keeping the template and rule; resume clears it",
  },
  "todo.resume-repeat": {
    class: "reversible",
    note: "inverse pauses the repeat (UI2-c): the reversible cessation toggle — resume clears the paused flag, pause re-sets it",
  },
  "project.pause-repeat": {
    class: "reversible",
    note: "inverse resumes the project's repeat (UIC2-a): pause sets instance-creation paused, keeping the template and rule; resume clears it",
  },
  "project.resume-repeat": {
    class: "reversible",
    note: "inverse pauses the project's repeat (UIC2-a): resume clears the paused flag, pause re-sets it",
  },

  // ---- irreversible: the log-move boundary only advances ------------------
  "log-now": {
    class: "irreversible",
    note: "logging moves completed items into the Logbook by advancing the log-move boundary (TMSettings.manualLogDate); no official surface can rewind it (TIMEZ/settings-stamp laws), so there is no inverse. Nothing is deleted — the items simply become logged",
  },
};

/** The ops whose class is `irreversible` — must equal undo.ts's IRREVERSIBLE keys. */
export function irreversibleOps(): OperationKind[] {
  return (Object.keys(REVERSIBILITY) as OperationKind[]).filter(
    (op) => REVERSIBILITY[op].class === "irreversible",
  );
}
