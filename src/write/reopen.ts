/**
 * project.reopen orchestrator. The bare op reopens ONLY the project row
 * (P02/P05 — the app leaves cascade-resolved children resolved). With
 * restoreChildren, children that were resolved BY THE CASCADE are reopened
 * too, identified by the P03-validated timing window: same resolved status
 * as the project and a stopDate within CASCADE_WINDOW_SECONDS of the
 * project's. Each child reopen is a full verified mutation.
 */
import { resolveProjectWriteTarget } from "../read/queries.ts";
import { runMutation, type MutationResult, type WriteDeps, type WriteOptions } from "./pipeline.ts";

/** P03: cascade writes stamp children within <2s of the project row. */
export const CASCADE_WINDOW_SECONDS = 2;

export interface ProjectReopenResult {
  project: MutationResult;
  /** Per-child verified reopen results (restoreChildren only). */
  children: { uuid: string; title: string; result: MutationResult }[];
}

export interface ProjectReopenOptions extends WriteOptions {
  /**
   * Also reopen children the completion/cancellation cascade resolved —
   * detected via the stopDate window. Children resolved at other times
   * (e.g. finished days earlier) are never touched (P04 semantics).
   */
  restoreChildren?: boolean;
}

interface CascadeCandidate {
  uuid: string;
  title: string;
}

function cascadeCandidates(deps: WriteDeps, projectUuid: string): CascadeCandidate[] {
  return deps.db
    .prepare(
      `SELECT c.uuid, c.title FROM TMTask c
       JOIN TMTask p ON p.uuid = ?
       WHERE c.trashed = 0 AND c.type = 0 AND c.status = p.status AND c.status != 0
         AND c.stopDate IS NOT NULL AND p.stopDate IS NOT NULL
         AND abs(c.stopDate - p.stopDate) < ?
         AND (c.project = p.uuid OR c.heading IN
              (SELECT uuid FROM TMTask WHERE type = 2 AND project = p.uuid))`,
    )
    .all(projectUuid, CASCADE_WINDOW_SECONDS) as unknown as CascadeCandidate[];
}

export async function runProjectReopen(
  deps: WriteDeps,
  uuid: string,
  options: ProjectReopenOptions = {},
): Promise<ProjectReopenResult> {
  uuid = resolveProjectWriteTarget(deps.db, uuid);
  const { restoreChildren, ...writeOptions } = options;
  // Candidates must be computed BEFORE the reopen clears the project's
  // stopDate (the window is relative to it).
  const candidates = restoreChildren === true ? cascadeCandidates(deps, uuid) : [];

  const project = await runMutation(deps, "project.reopen", { uuid }, writeOptions);
  const children: ProjectReopenResult["children"] = [];
  if (project.kind === "ok" || project.kind === "dry-run") {
    for (const child of candidates) {
      if (project.kind === "dry-run") {
        children.push({
          uuid: child.uuid,
          title: child.title,
          result: {
            kind: "dry-run",
            op: "todo.reopen",
            plan: {
              op: "todo.reopen",
              vector: "applescript",
              tier: 0,
              invocation: `(cascade restore) reopen ${child.title}`,
              expectedDelta: {
                mode: "state",
                uuid: child.uuid,
                assert: [{ field: "status", equals: "open" }],
              },
              hazardsChecked: [],
            },
          },
        });
        continue;
      }
      // child reopens must land one at a time (mutation lock + create-probe verification must never race); an early failure also needs to stop the remaining legs
      const result = await runMutation(deps, "todo.reopen", { uuid: child.uuid }, writeOptions);
      children.push({ uuid: child.uuid, title: child.title, result });
      if (result.kind !== "ok") break; // stop compounding on a failed leg
    }
  }
  return { project, children };
}
