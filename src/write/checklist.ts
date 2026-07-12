/**
 * Checklist edit primitives, shared by the client, the write-layer
 * orchestrator (`edit-checklist.ts`), and undo (`undo.ts`).
 *
 * Things exposes NO item-level checklist write surface: every change is a
 * wholesale rewrite (`todo.replace-checklist`), and item uuids regenerate on
 * each rewrite (docs/design/reference-resolution.md). A granular edit is
 * therefore expressed as ONE action against the CURRENT list, applied here in
 * memory, and delivered as a full rewrite that preserves every other item's
 * state. These helpers live in the write layer (not client.ts) so the
 * orchestrator can reuse them without importing back through the client.
 */
import type { ChecklistItemAction, ChecklistItemSpec } from "./operations.ts";

export type { ChecklistItemAction };

/**
 * Target for an existing checklist item: by `item` (title) or `index`
 * (1-based). Provide exactly one. Title matching is best-effort on duplicates
 * (docs/design/reference-resolution.md); index is exact.
 */
export interface ChecklistTarget {
  item?: string;
  /** 1-based position; overrides `item` when both are given. */
  index?: number;
}

export type ChecklistEdit =
  | { action: "add"; title: string; /** 1-based insert position (default: append). */ at?: number }
  | ({ action: "remove" } & ChecklistTarget)
  | ({ action: "check" } & ChecklistTarget)
  | ({ action: "uncheck" } & ChecklistTarget)
  | ({ action: "rename"; title: string } & ChecklistTarget)
  | ({ action: "move"; /** 1-based target position. */ to: number } & ChecklistTarget);

/**
 * Resolve a checklist target to an array index. `index` (1-based) is exact.
 * A title resolves best-effort: unique → that item; duplicates → the first on
 * which the action is meaningful (check → first unchecked, uncheck → first
 * checked, others → first match). Loud only when nothing matches / index is
 * out of range.
 */
export function checklistTarget(
  items: ChecklistItemSpec[],
  edit: ChecklistEdit & ChecklistTarget,
): number {
  if (edit.index !== undefined) {
    const i = edit.index - 1;
    if (i < 0 || i >= items.length) {
      throw new RangeError(`checklist index ${edit.index} is out of range (1..${items.length})`);
    }
    return i;
  }
  const ref = edit.item;
  if (ref === undefined) throw new RangeError("give a checklist item title or 1-based index");
  const matches = items.map((c, i) => ({ c, i })).filter(({ c }) => c.title === ref);
  if (matches.length === 0) throw new RangeError(`no checklist item titled "${ref}"`);
  if (matches.length === 1) return (matches[0] as { i: number }).i;
  const meaningful =
    edit.action === "check"
      ? matches.find(({ c }) => !c.completed)
      : edit.action === "uncheck"
        ? matches.find(({ c }) => c.completed)
        : undefined;
  return (meaningful ?? matches[0] ?? { i: 0 }).i;
}

export function applyChecklistEdit(
  items: ChecklistItemSpec[],
  edit: ChecklistEdit,
): ChecklistItemSpec[] {
  const next = items.map((c) => ({ ...c }));
  switch (edit.action) {
    case "add": {
      const at =
        edit.at === undefined ? next.length : Math.max(0, Math.min(next.length, edit.at - 1));
      next.splice(at, 0, { title: edit.title, completed: false });
      return next;
    }
    case "remove":
      next.splice(checklistTarget(next, edit), 1);
      return next;
    case "check":
    case "uncheck": {
      const target = next[checklistTarget(next, edit)] as ChecklistItemSpec;
      target.completed = edit.action === "check";
      return next;
    }
    case "rename": {
      const target = next[checklistTarget(next, edit)] as ChecklistItemSpec;
      target.title = edit.title;
      return next;
    }
    case "move": {
      const from = checklistTarget(next, edit);
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(next.length, edit.to - 1)), 0, moved as ChecklistItemSpec);
      return next;
    }
  }
}
