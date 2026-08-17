/**
 * HINTS1 — contextual remaining-count hints on a completed/canceled to-do.
 *
 * After a `todo.complete` / `todo.cancel` verifies, the result gains a small
 * `context` object so an agent caller can notice an emptied container without a
 * second read: the open-work remaining in the to-do's PROJECT and/or in TODAY.
 * The hint only INFORMS — it never auto-acts (an agent seeing `remainingOpen: 0`
 * on a project can decide to complete the project too, or not).
 *
 * Applicability is detected from the captured PRE-STATE (the pipeline already
 * loads the target), so a to-do that was in neither a project nor Today costs
 * ZERO extra reads. The counts themselves are read AFTER the mutation verifies,
 * from the library's own read paths:
 *  - project: the live open-leaf census (direct SQL, mirroring the reader's
 *    leaf-action law — heading children flatten into their project; heading rows
 *    are not to-dos and never count; templates are excluded);
 *  - today: the established Today view ({@link todayView}) open-member count —
 *    ONE source of truth for Today membership (the deadline-pull / evening /
 *    provisional laws live there, never re-approximated here).
 *
 * Repeating note: the counts reflect whatever the post-mutation DB shows. If
 * completing an instance spawns a successor that materializes into the same
 * project or Today, that successor is honest present state and IS counted.
 */
import type { DatabaseSync } from "node:sqlite";

import type { AnyTask } from "../model/entities.ts";
import { todayView } from "../read/views.ts";

export interface CompletionContext {
  /**
   * Present when the to-do was in a project (directly, or under one of the
   * project's headings). `remainingOpen` is the count of OPEN (incomplete,
   * untrashed, non-template) to-dos left in that project AFTER this mutation,
   * heading-children included — `0` means this mutation emptied the project's
   * open work.
   */
  project?: { uuid: string; title: string; remainingOpen: number };
  /**
   * Present when the to-do was a member of Today at mutation time (any
   * membership arm — a scheduled arrival, an evening item, or a due/overdue
   * deadline pull). `remainingOpen` is the count of OPEN Today members left
   * AFTER this mutation (Today proper + This Evening).
   */
  today?: { remainingOpen: number };
}

/**
 * Compute the completion-context hint for a just-completed/canceled to-do, or
 * `undefined` when neither arm applies (the caller then omits `context`).
 * `target` is the PRE-STATE target (loaded before the mutation); `now`/`zone`
 * are the response clock, so the Today count reads under the same calendar day
 * the rest of the pipeline used.
 */
export function computeCompletionContext(
  db: DatabaseSync,
  target: AnyTask | null,
  now: Date,
  zone?: string,
): CompletionContext | undefined {
  if (target === null || target.type !== "to-do") return undefined;

  const context: CompletionContext = {};

  // Project membership — direct `project`, or resolved through the heading
  // (`headingProject`, which byUuid populates when the to-do is heading-nested).
  const projectRef = target.project ?? target.headingProject ?? null;
  if (projectRef !== null) {
    context.project = {
      uuid: projectRef.uuid,
      title: projectRef.title,
      remainingOpen: openLeafCount(db, projectRef.uuid),
    };
  }

  // Today membership — the pre-state `today` marker is the mapper's faithful
  // two-arm Today membership; when set, read the post-mutation open count from
  // the Today view itself (the just-resolved target is no longer open, so it is
  // excluded from the count).
  if (target.derived.today === true) {
    const view = todayView(db, now, undefined, zone);
    context.today = { remainingOpen: view.counts.dueOrOverdue + view.counts.other };
  }

  return context.project === undefined && context.today === undefined ? undefined : context;
}

/**
 * Count the OPEN (status 0), untrashed, non-template to-dos in a project —
 * direct children AND heading-nested children (heading rows themselves are
 * type 2 and never counted). Mirrors the reader's leaf-action law; a repeating
 * INSTANCE counts (honest state), a hidden TEMPLATE row does not.
 */
function openLeafCount(db: DatabaseSync, projectUuid: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM TMTask
       WHERE type = 0 AND trashed = 0 AND status = 0
         AND rt1_recurrenceRule IS NULL AND repeater IS NULL
         AND (project = ? OR heading IN
           (SELECT uuid FROM TMTask WHERE type = 2 AND project = ?))`,
    )
    .get(projectUuid, projectUuid) as { n: number };
  return row.n;
}
