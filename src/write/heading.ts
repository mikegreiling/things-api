/**
 * heading.archive / heading.unarchive orchestrators.
 *
 * Archive with children: "complete" | "cancel" is ONE mutation — the app's
 * own cascades do the work (P10b-b1 complete, P11c cancel; pre-resolved
 * children untouched, P11d). "reparent" is a compound: each open child moves
 * to the project root (a verified todo.move leg — clears the heading link,
 * P9f), then the empty heading archives. Legs and summary share a txn id so
 * `things undo` reverses the WHOLE sequence as one unit.
 *
 * Unarchive optionally restores cascade-resolved children via the P03-style
 * <2s stopDate window (someday state survives the round-trip — P11a).
 */
import { resolveTaskUuidPrefix } from "../read/queries.ts";
import { runMutation, type MutationResult, type WriteDeps, type WriteOptions } from "./pipeline.ts";
import type { HeadingArchiveParams, HeadingUnarchiveParams } from "./operations.ts";
import { CASCADE_WINDOW_SECONDS } from "./reopen.ts";

export interface HeadingArchiveResult {
  heading: MutationResult;
  /** Verified reparent legs (children: "reparent" only). */
  reparented: { uuid: string; title: string; result: MutationResult }[];
}

export interface HeadingUnarchiveResult {
  heading: MutationResult;
  /** Per-child verified reopen results (restoreChildren only). */
  children: { uuid: string; title: string; result: MutationResult }[];
}

function openChildren(deps: WriteDeps, headingUuid: string): { uuid: string; title: string }[] {
  return deps.db
    .prepare(
      `SELECT uuid, title FROM TMTask
       WHERE type = 0 AND trashed = 0 AND status = 0 AND heading = ?`,
    )
    .all(headingUuid) as { uuid: string; title: string }[];
}

function headingProject(deps: WriteDeps, headingUuid: string): string | null {
  const row = deps.db.prepare("SELECT project FROM TMTask WHERE uuid = ?").get(headingUuid) as
    | { project: string | null }
    | undefined;
  return row?.project ?? null;
}

export async function runHeadingArchive(
  deps: WriteDeps,
  params: HeadingArchiveParams,
  options: WriteOptions = {},
): Promise<HeadingArchiveResult> {
  params = { ...params, uuid: resolveTaskUuidPrefix(deps.db, params.uuid) };
  const reparented: HeadingArchiveResult["reparented"] = [];
  if (params.children !== "reparent") {
    // Single-mutation path: the app's cascade is the policy.
    return { heading: await runMutation(deps, "heading.archive", params, options), reparented };
  }

  const txnId = `txn-${(deps.now?.() ?? new Date()).getTime().toString(36)}-${process.pid.toString(36)}`;
  const project = headingProject(deps, params.uuid);
  const legOptions: WriteOptions = { ...options, txn: { id: txnId, role: "leg" } };
  for (const child of openChildren(deps, params.uuid)) {
    if (options.dryRun === true) break; // the atomic dry-run plan carries the summary
    const result = await runMutation(
      deps,
      "todo.move",
      { uuid: child.uuid, project: { uuid: project ?? "" } },
      legOptions,
    );
    reparented.push({ uuid: child.uuid, title: child.title, result });
    if (result.kind !== "ok") {
      return {
        heading: {
          kind: "blocked",
          op: "heading.archive",
          reason: "hazard",
          hazard: "H-HEADING-CHILDREN",
          detail:
            `reparent leg failed for ${child.title} (${child.uuid}) — the heading was NOT ` +
            "archived; already-moved children stay at the project root",
          remediation: "fix the failing child (see its result), then re-run",
        },
        reparented,
      };
    }
  }
  const heading = await runMutation(deps, "heading.archive", params, {
    ...options,
    txn: { id: txnId, role: "summary" },
  });
  return { heading, reparented };
}

export async function runHeadingUnarchive(
  deps: WriteDeps,
  params: HeadingUnarchiveParams,
  options: WriteOptions = {},
): Promise<HeadingUnarchiveResult> {
  params = { ...params, uuid: resolveTaskUuidPrefix(deps.db, params.uuid) };
  const { restoreChildren, ...rest } = params as HeadingUnarchiveParams & Record<string, unknown>;
  void rest;
  // Candidates BEFORE the unarchive clears the heading's stopDate.
  const candidates =
    restoreChildren === true
      ? (deps.db
          .prepare(
            `SELECT c.uuid, c.title FROM TMTask c
             JOIN TMTask h ON h.uuid = ?
             WHERE c.trashed = 0 AND c.type = 0 AND c.status != 0 AND c.heading = h.uuid
               AND c.stopDate IS NOT NULL AND h.stopDate IS NOT NULL
               AND abs(c.stopDate - h.stopDate) < ?`,
          )
          .all(params.uuid, CASCADE_WINDOW_SECONDS) as { uuid: string; title: string }[])
      : [];

  const txnId = `txn-${(deps.now?.() ?? new Date()).getTime().toString(36)}-${process.pid.toString(36)}`;
  const heading = await runMutation(
    deps,
    "heading.unarchive",
    { uuid: params.uuid },
    candidates.length > 0 ? { ...options, txn: { id: txnId, role: "summary" } } : options,
  );
  const children: HeadingUnarchiveResult["children"] = [];
  if (heading.kind === "ok") {
    for (const child of candidates) {
      const result = await runMutation(
        deps,
        "todo.reopen",
        { uuid: child.uuid },
        { ...options, txn: { id: txnId, role: "leg" } },
      );
      children.push({ uuid: child.uuid, title: child.title, result });
      if (result.kind !== "ok") break;
    }
  }
  return { heading, children };
}
