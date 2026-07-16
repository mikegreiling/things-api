/**
 * The per-view filter contract — the ONE declarative statement of which read
 * filters each view honors, plus the shared predicates that enforce them. Both
 * consumer surfaces (CLI commands, MCP tools) derive their per-view guards from
 * this table instead of hand-coding view lists, so a filter's applicability is
 * stated once and can never drift between surfaces.
 *
 * The table says, per view: whether the `overdue` content scope applies; what
 * tag semantics the view carries (inheritance-inclusive `inherited`, container-
 * direct `direct`, or `rejected` where the view has no per-row tags to filter);
 * the bound model the view truncates under (`flat` row cap, `grouped` per-block
 * caps, or `none`); and whether the view offers the status-widening flags
 * (search's logged/trashed/all) that `overdue` refuses to combine with.
 *
 * The exact usage-error COPY stays surface-owned (consumer voice differs per
 * surface — CLI `--tag`, MCP `tag`; docs/design/surface-copy.md): a surface
 * hands {@link validateViewArgs} its own phrasing via {@link FilterVocab}, and
 * this module owns only the DECISION of which message applies.
 */
import type { ViewFilter } from "./views.ts";

/** Every read view whose filter applicability the contract governs. */
export type ViewName =
  | "today"
  | "inbox"
  | "anytime"
  | "someday"
  | "upcoming"
  | "logbook"
  | "trash"
  | "search"
  | "changes"
  | "projects"
  | "areas"
  | "project-show"
  | "area-show";

/**
 * How a view's tag filter behaves:
 * - `inherited` — FLAT views: a `--tag` matches direct OR container-inherited
 *   membership (plus hierarchy descendants).
 * - `direct` — CONTAINER views (`project show`, `area show`): a `--tag` matches
 *   a tag carried DIRECTLY on the row (the container's own inherited tags are
 *   suppressed, since every child inherits them).
 * - `rejected` — the view has no per-row tag list to filter (an area list row,
 *   a tag list row, the changes feed); tag flags do not apply.
 */
export type TagSemantics = "inherited" | "direct" | "rejected";

/** The truncation model a view bounds under. */
export type BoundModel = "flat" | "grouped" | "none";

/** One row of {@link FILTER_CONTRACT}: a single view's filter applicability. */
export interface ViewFilterSpec {
  /** Whether the `overdue` content scope (open, past-deadline) applies. */
  readonly overdue: boolean;
  /** The view's tag-filter semantics. */
  readonly tag: TagSemantics;
  /** The bound model the view truncates under. */
  readonly bound: BoundModel;
  /**
   * Whether the view offers the status-widening flags (logged/trashed/all).
   * Only `search` does; `overdue` refuses to combine with them there.
   */
  readonly statusWidening: boolean;
}

/**
 * The single source of truth for read-filter applicability, one row per view.
 * Consumed by both surfaces' per-view guards (CLI command actions, MCP tool
 * handlers) so no surface hand-maintains its own view list.
 */
export const FILTER_CONTRACT: Record<ViewName, ViewFilterSpec> = {
  // Current-work flat views: overdue applies, tags are inheritance-inclusive.
  today: { overdue: true, tag: "inherited", bound: "flat", statusWidening: false },
  inbox: { overdue: true, tag: "inherited", bound: "flat", statusWidening: false },
  // Grouped catalogues: overdue applies, per-block caps.
  anytime: { overdue: true, tag: "inherited", bound: "grouped", statusWidening: false },
  someday: { overdue: true, tag: "inherited", bound: "grouped", statusWidening: false },
  // Forward-looking / closed-item flat views: overdue deliberately does NOT apply.
  upcoming: { overdue: false, tag: "inherited", bound: "flat", statusWidening: false },
  logbook: { overdue: false, tag: "inherited", bound: "flat", statusWidening: false },
  trash: { overdue: false, tag: "rejected", bound: "flat", statusWidening: false },
  // Search: overdue applies but refuses the status-widening flags.
  search: { overdue: true, tag: "inherited", bound: "flat", statusWidening: true },
  // Sync feed: neither overdue nor tags apply.
  changes: { overdue: false, tag: "rejected", bound: "flat", statusWidening: false },
  // Projects LIST is a FLAT view — each project row filtered by its own
  // (inheritance-inclusive) tags; overdue keeps past-deadline projects.
  projects: { overdue: true, tag: "inherited", bound: "none", statusWidening: false },
  // Areas LIST rows carry no deadline and no per-row tag filter.
  areas: { overdue: false, tag: "rejected", bound: "none", statusWidening: false },
  // Single-container views: overdue and DIRECT-tag filtering apply to children.
  "project-show": { overdue: true, tag: "direct", bound: "grouped", statusWidening: false },
  "area-show": { overdue: true, tag: "direct", bound: "grouped", statusWidening: false },
};

/**
 * The three universal tag-filter inputs in their canonical (CLI-flag) spelling.
 * The CLI's parsed options match this verbatim; the MCP surface maps its
 * snake_case inputs (`exact_tag`) onto it before calling the shared predicates.
 */
export interface TagPresence {
  tag?: readonly string[] | undefined;
  exactTag?: boolean | undefined;
  untagged?: boolean | undefined;
}

/** True when any tag-PRESENCE flag was passed (a positive filter, not a negation). */
export function hasTagPresence(a: TagPresence): boolean {
  return (a.tag?.length ?? 0) > 0 || a.exactTag === true;
}

/**
 * True when the tag flags are mutually incoherent: the `untagged` negation
 * inverts a tag presence, so it does not combine with a tag-presence flag. A
 * pure predicate — each surface emits its own usage error in its own voice.
 */
export function tagFlagConflict(a: TagPresence): boolean {
  return a.untagged === true && hasTagPresence(a);
}

/** Build the {@link ViewFilter} tag fields from the parsed flags (empty keys omitted). */
export function tagFilterFields(a: TagPresence): ViewFilter {
  return {
    ...(a.tag !== undefined && a.tag.length > 0 && { tags: [...a.tag] }),
    ...(a.exactTag === true && { exactTag: true }),
    ...(a.untagged === true && { untagged: true }),
  };
}

/** The parsed read-filter inputs {@link validateViewArgs} inspects. */
export interface FilterArgs extends TagPresence {
  overdue?: boolean | undefined;
  /** search only: the status-widening flags overdue refuses to combine with. */
  logged?: boolean | undefined;
  trashed?: boolean | undefined;
  all?: boolean | undefined;
}

/**
 * The surface's exact usage-error copy for each conflict {@link validateViewArgs}
 * can detect. Built per call by the surface (it knows the view/kind and its own
 * flag spellings), so the SHARED module decides WHICH message applies while the
 * message text stays consumer-voiced per surface.
 */
export interface FilterVocab {
  /** `untagged` combined with a tag-presence flag. */
  untaggedConflict: string;
  /** `overdue` passed to a view that does not honor it. */
  overdueRejected: string;
  /** `overdue` combined with a status-widening flag (search). */
  overdueStatusWiden: string;
}

/** {@link validateViewArgs} outcome: the built filter, or the usage message to emit. */
export type ViewValidation = { ok: true; filter: ViewFilter } | { ok: false; message: string };

/**
 * Validate a view's filter arguments against {@link FILTER_CONTRACT} and, when
 * coherent, build the {@link ViewFilter} tag+overdue portion. The checks (and
 * their precedence) live here so both surfaces stay in lockstep; the surface
 * supplies its own exact copy via {@link FilterVocab}.
 *
 * Does NOT enforce tag-REJECTION (a view refusing tag flags outright): that
 * lives at the two call sites that currently reject — the areas/projects/tags
 * collection listers — so this stays a pure no-op for the flat/container views
 * that merely ignore tags on a sub-path (e.g. `trash`).
 */
export function validateViewArgs(
  view: ViewName,
  args: FilterArgs,
  vocab: FilterVocab,
): ViewValidation {
  const spec = FILTER_CONTRACT[view];
  if (tagFlagConflict(args)) return { ok: false, message: vocab.untaggedConflict };
  if (args.overdue === true && !spec.overdue) {
    return { ok: false, message: vocab.overdueRejected };
  }
  if (
    args.overdue === true &&
    spec.statusWidening &&
    (args.logged === true || args.trashed === true || args.all === true)
  ) {
    return { ok: false, message: vocab.overdueStatusWiden };
  }
  return {
    ok: true,
    filter: { ...tagFilterFields(args), ...(args.overdue === true && { overdue: true }) },
  };
}
