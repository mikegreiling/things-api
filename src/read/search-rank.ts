/**
 * The deterministic composite ranking for `things search` (docs/design/
 * cli-grammar.md → search doctrine), replacing plain recency. A pure
 * comparator so it is unit-testable in isolation and cannot drift from the
 * documented order. Ranking runs BEFORE any row cap.
 *
 * Order (first differing key wins):
 *   1. match field — title > notes > heading-via-project > checklist
 *   2. type        — projects/areas above to-dos
 *   3. status      — active above someday; logged/trashed last
 *   4. tiebreak    — most-recently-modified
 *
 * Consequence (deliberate): a someday TITLE match outranks an active NOTES
 * match — field trumps status.
 */
import type { ListItem } from "./views.ts";

/** Which text carried the match. `heading` = a heading title, credited to its parent project. */
export type MatchField = "title" | "notes" | "heading" | "checklist";

export interface SearchMatch {
  item: ListItem;
  field: MatchField;
  /** Present when `field === "heading"`: the heading whose title matched. */
  matchedVia?: { kind: "heading"; title: string };
}

const FIELD_ORDER: Record<MatchField, number> = { title: 0, notes: 1, heading: 2, checklist: 3 };

export function fieldRank(field: MatchField): number {
  return FIELD_ORDER[field];
}

/** Containers (projects, areas) sort above to-dos. */
export function typeRank(type: ListItem["type"] | "area"): number {
  return type === "to-do" ? 1 : 0;
}

export type MatchStatus = "active" | "someday" | "logged" | "trashed";

/** Derive the ranking status bucket from an item's own state. */
export function matchStatus(item: ListItem): MatchStatus {
  if (item.trashed) return "trashed";
  if (item.status !== "open") return "logged";
  if (item.start === "someday") return "someday";
  return "active";
}

const STATUS_ORDER: Record<MatchStatus, number> = { active: 0, someday: 1, logged: 2, trashed: 3 };

export function statusRank(status: MatchStatus): number {
  return STATUS_ORDER[status];
}

/** The composite comparator. Stable and total: ties fall through to the uuid. */
export function compareSearchMatches(a: SearchMatch, b: SearchMatch): number {
  return (
    fieldRank(a.field) - fieldRank(b.field) ||
    typeRank(a.item.type) - typeRank(b.item.type) ||
    statusRank(matchStatus(a.item)) - statusRank(matchStatus(b.item)) ||
    b.item.modified.getTime() - a.item.modified.getTime() ||
    a.item.uuid.localeCompare(b.item.uuid)
  );
}
