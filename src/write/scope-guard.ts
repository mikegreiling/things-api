/**
 * The universal write scope gate — the per-op-family matrix of the container
 * sandbox (docs/design/container-scope.md §4). Runs in `runMutation` for EVERY
 * op (unlike hazards, which run only when a spec lists them) and BEFORE
 * `evaluateGuards`, so a scope refusal precedes any hazard copy.
 *
 * Target-in-scope parity is enforced earlier, at uuid/ref RESOLUTION (the
 * pipeline threads scope clauses into the resolvers), so an out-of-scope target
 * is byte-indistinguishable from a nonexistent one before we ever reach here.
 * This gate handles the rest: structural refusals (resources at/above the
 * boundary, library-wide side effects), the add-redirect defaulting, and the
 * destination "result-stays-in-scope" check — which nullifies an out-of-scope
 * destination in `pre` so the normal H-UNKNOWN-DESTINATION guard fires exactly
 * as it would for a nonexistent destination (again: no oracle).
 *
 * Default rule for any op NOT explicitly handled below: the target is already
 * scope-checked at resolution and any resolved destination is gated, so it is
 * allowed iff target-in-scope AND result-stays-in-scope — fail closed.
 */
import type { DatabaseSync } from "node:sqlite";

import type {
  MoveHeadingParams,
  OperationKind,
  ProjectMoveParams,
  ReorderParams,
  TodoMoveParams,
} from "./operations.ts";
import type { PreState, ContainerResolution } from "./pre-state.ts";
import { projectStatus, resolveArea, resolveProject } from "./pre-state.ts";
import { isUuidInScope, type ResolvedScope } from "../read/scope.ts";

export type ScopeDecision =
  | { kind: "allow" }
  | { kind: "blocked"; detail: string; remediation: string };

const REFUSE_UNDER_SCOPE = "not permitted under an active container scope";
const REFUSE_UNDER_PROJECT = "not permitted under a project scope";

function blocked(detail: string, remediation = REFUSE_UNDER_SCOPE): ScopeDecision {
  return { kind: "blocked", detail, remediation };
}

/** Is an AREA uuid the scope's own area context? (destArea membership.) */
function areaInScope(scope: ResolvedScope, areaUuid: string): boolean {
  return scope.kind === "area" ? areaUuid === scope.uuid : areaUuid === scope.areaUuid;
}

/** An out-of-scope resolved container, nullified so H-UNKNOWN-DESTINATION fires (parity). */
function nullify(): ContainerResolution {
  return { resolved: null, matches: 0 };
}

export function evaluateScope(
  db: DatabaseSync,
  op: OperationKind,
  params: Record<string, unknown>,
  pre: PreState,
  scope: ResolvedScope,
): ScopeDecision {
  // 1. Structural refusals: resources at/above the container boundary, or with
  //    library-wide side effects. None reference a specific hidden item.
  switch (op) {
    case "area.add":
      return blocked("areas are top-level containers, above any container scope");
    case "area.update":
    case "area.delete":
      return blocked(
        "an area sits at or above the scope boundary — mutating it is a boundary operation",
      );
    case "area.reorder":
      return blocked("the sidebar area order is global, above any container scope");
    case "trash.empty":
      return blocked(
        "emptying the Trash permanently deletes every trashed item library-wide, including ones outside the active scope",
      );
    case "tag.update":
      return blocked(
        "renaming or re-nesting a tag changes shared state visible to every tagged item across the whole library",
      );
    case "tag.delete":
      return blocked(
        "deleting a tag removes it from items outside the active scope and cascades to its descendants library-wide",
      );
    case "todo.restore":
      return blocked("restore returns the item to the Inbox, which is outside the active scope");
    case "todo.add-logged":
      // A logged to-do is created loose in the Logbook with no container — it
      // would land outside the scope and cannot be redirected (the operation
      // has no destination parameter). Fail closed.
      return blocked(
        "a logged to-do is created loose in the Logbook and cannot be placed into the active scope",
      );
    default:
      break;
  }

  // 2. Project-scope refusals — the result would leave the project jail.
  if (scope.kind === "project") {
    switch (op) {
      case "project.add":
        return blocked(
          "a new project would be a sibling in the area, outside the project scope",
          REFUSE_UNDER_PROJECT,
        );
      case "project.move":
        return blocked(
          "moving a project changes its area, which is outside the project scope",
          REFUSE_UNDER_PROJECT,
        );
      case "todo.convert-to-project":
      case "project.promote-heading":
        return blocked(
          "the result is a project, which cannot live inside a project scope",
          REFUSE_UNDER_PROJECT,
        );
      case "project.make-repeating":
      case "project.add-repeating":
        return blocked(
          "making the project repeating replaces it with a new one the scope would no longer recognize",
          REFUSE_UNDER_PROJECT,
        );
      default:
        break;
    }
  }

  // 3. Reorder: container-bound scopes allowed iff the container is in scope;
  //    global-view scopes reorder a cross-container list — refuse.
  if (op === "reorder") {
    return evaluateReorderScope(db, params as unknown as ReorderParams, scope);
  }

  // Heading reorder: allowed iff the headings' project is in scope.
  if (op === "project.move-heading") {
    const r = resolveProject(db, (params as unknown as MoveHeadingParams).project);
    if (r.resolved === null) return { kind: "allow" }; // unknown project — normal error path
    return isUuidInScope(db, r.resolved.uuid, scope)
      ? { kind: "allow" }
      : blocked("the heading's project is outside the active scope");
  }

  // 4. Moves that strip the container or target the Inbox leave scope.
  if (op === "todo.move") {
    const p = params as unknown as TodoMoveParams;
    if (p.inbox === true) return blocked("moving to the Inbox leaves the active scope");
    if (p.loose === true)
      return blocked("--loose strips the item's container, leaving the active scope");
    // --no-heading keeps the to-do in its current project (in scope by
    // construction) — allowed; falls through to the default gate.
  }
  if (op === "project.move") {
    // Only an AREA scope reaches here (project scope refused above). --no-area
    // strips the area; moving to the scope area itself is idempotent (allowed
    // via the destination gate). Any other destination area is nullified below.
    const p = params as unknown as ProjectMoveParams;
    if (p.noArea === true)
      return blocked("--no-area strips a project's area, leaving the active scope");
  }

  // 5. Creates with no explicit destination → redirect into the container.
  if (op === "todo.add" || op === "project.add") {
    applyAddRedirect(db, pre, scope);
  }

  // 6. Universal destination gate: nullify any resolved destination that is out
  //    of scope so the normal H-UNKNOWN-DESTINATION guard fires — byte-identical
  //    to a nonexistent destination (no oracle).
  if (pre.destProject !== null && pre.destProject.resolved !== null) {
    if (!isUuidInScope(db, pre.destProject.resolved.uuid, scope)) pre.destProject = nullify();
  }
  if (pre.destHeading !== null && pre.destHeading.resolved !== null) {
    if (!isUuidInScope(db, pre.destHeading.resolved.uuid, scope)) pre.destHeading = nullify();
  }
  if (pre.destArea !== null && pre.destArea.resolved !== null) {
    if (!areaInScope(scope, pre.destArea.resolved.uuid)) pre.destArea = nullify();
  }

  // 7. Default: target scope-checked at resolution, destinations gated — allow.
  return { kind: "allow" };
}

/**
 * Bare create → inject the scope container as the destination so the compile
 * places it in-scope and the delta asserts the placement. A create that names a
 * destination falls through to the destination gate instead.
 */
function applyAddRedirect(db: DatabaseSync, pre: PreState, scope: ResolvedScope): void {
  const hasDest =
    (pre.destProject !== null && pre.destProject.resolved !== null) ||
    (pre.destArea !== null && pre.destArea.resolved !== null);
  if (hasDest) return;
  if (scope.kind === "area") {
    pre.destArea = { resolved: { uuid: scope.uuid, title: scope.title }, matches: 1 };
    return;
  }
  // project scope: todo.add lands in the project (project.add is refused above).
  pre.destProject = { resolved: { uuid: scope.uuid, title: scope.title }, matches: 1 };
  pre.destProjectStatus = projectStatus(db, scope.uuid);
}

/**
 * Reorder scope gate: `today`/`evening`/`inbox`/`someday`/`projects` reorder a
 * cross-container list (the anchor-stack/bounce wire protocols cannot be
 * container-filtered) — refuse. `project`/`area` are allowed when the named
 * container is in scope.
 */
function evaluateReorderScope(
  db: DatabaseSync,
  params: ReorderParams,
  scope: ResolvedScope,
): ScopeDecision {
  const GLOBAL = new Set(["today", "evening", "inbox", "someday", "projects"]);
  if (GLOBAL.has(params.scope)) {
    return blocked(
      `reordering the ${params.scope} list spans containers and cannot be limited to the active scope`,
    );
  }
  const container = params.container;
  if (container === undefined) return { kind: "allow" }; // reorder's own validation errors
  if (params.scope === "area") {
    const r = resolveArea(db, container);
    if (r.resolved === null) return { kind: "allow" }; // unknown container — normal error path
    return areaInScope(scope, r.resolved.uuid)
      ? { kind: "allow" }
      : blocked("the reorder container is outside the active scope");
  }
  // project scope: the container is a project.
  const r = resolveProject(db, container);
  if (r.resolved === null) return { kind: "allow" };
  return isUuidInScope(db, r.resolved.uuid, scope)
    ? { kind: "allow" }
    : blocked("the reorder container is outside the active scope");
}
