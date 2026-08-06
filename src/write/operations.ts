/**
 * Operation catalog: every mutation the write layer can express, plus the
 * typed parameter shapes. Vector support for each operation lives in the
 * per-vector matrices (data, produced by the lab), not here.
 */
import type { IsoDate, ReminderTime } from "../model/dates.ts";

export const OPERATION_KINDS = [
  "todo.add",
  "todo.update",
  "todo.complete",
  "todo.cancel",
  "todo.reopen",
  "todo.move",
  "todo.set-tags",
  "todo.replace-checklist",
  "todo.edit-checklist-item",
  "todo.delete",
  "project.add",
  "project.update",
  "project.complete",
  "project.delete",
  "area.add",
  "area.delete",
  "tag.add",
  "tag.delete",
  "trash.empty",
  "reorder",
  "todo.duplicate",
  "area.update",
  "tag.update",
  "project.move",
  "todo.restore",
  "project.duplicate",
  "project.cancel",
  "project.reopen",
  "project.restore",
  "project.set-tags",
  "todo.set-dates",
  "project.set-dates",
  "project.add-heading",
  "project.rename-heading",
  "project.archive-heading",
  "project.unarchive-heading",
  "project.promote-heading",
  "project.move-heading",
  "project.move-heading-to-project",
  "project.dissolve-heading",
  "todo.clear-dated-reminder",
  "todo.make-repeating",
  "todo.reschedule-repeat",
  "todo.pause-repeat",
  "todo.resume-repeat",
  "todo.convert-to-project",
  "project.reschedule-repeat",
  "project.pause-repeat",
  "project.resume-repeat",
  "area.reorder",
  "project.make-repeating",
  "project.add-repeating",
  "log-now",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Operations delivered EXCLUSIVELY through the Accessibility GUI ("ui")
 * vector — GUI-only transforms with no headless spelling. Each drives the
 * local Things app, so all are two-key gated: the `ui.enabled` config plus a
 * per-call `dangerouslyDriveGui` acknowledgement (H-UI-DRIVE). Kept as data so
 * the guard and the pipeline agree on the set.
 */
export const UI_DRIVE_OPS: readonly OperationKind[] = [
  "todo.make-repeating",
  "todo.reschedule-repeat",
  "todo.pause-repeat",
  "todo.resume-repeat",
  "todo.convert-to-project",
  "project.promote-heading",
  "project.reschedule-repeat",
  "project.pause-repeat",
  "project.resume-repeat",
  "area.reorder",
  // Pure-AX (UIC4): the project is selected as a content-table ROW via a
  // settable AXSelectedRows, then Items ▸ Repeat… drives the same dialog. The
  // area-less-anytime taxonomy needs a Someday coercion first, orchestrated by
  // runMakeRepeatingProject — but the drive itself is a ui-vector op.
  "project.make-repeating",
  // HEADXPROJ: the heading row's `…` ellipsis → Move… menu → keyboard-driven
  // project picker (HID-click the title-carrying "More. <title>" button, then
  // Move…, type the destination, Return). GUI-only — no headless spelling on any
  // vector (AS move → project 301, URL list-id no-op, Shortcuts ⛔).
  "project.move-heading-to-project",
  // DISS1: the same `…` ellipsis popover's Delete — dissolves the heading (the
  // row is hard-deleted) while its children become DIRECT project children
  // (heading→NULL, project→parent, index preserved, NOT trashed). No confirm
  // sheet. GUI-only. Contrast the Shortcuts delete cascade (P12), which TRASHES
  // the children.
  "project.dissolve-heading",
] as const;

export function isUiDriveOp(op: OperationKind): boolean {
  return UI_DRIVE_OPS.includes(op);
}

/**
 * The project-scoped heading verbs (spec §2). Every one addresses a heading
 * inside a project; none is a plain `project.*` op even though it shares the
 * `project.` namespace, so guards/resolvers that key off the namespace must
 * special-case them.
 */
export const HEADING_OPS: readonly OperationKind[] = [
  "project.add-heading",
  "project.rename-heading",
  "project.archive-heading",
  "project.unarchive-heading",
  "project.promote-heading",
  "project.move-heading",
  "project.move-heading-to-project",
  "project.dissolve-heading",
] as const;

export function isHeadingOp(op: OperationKind): boolean {
  return HEADING_OPS.includes(op);
}

/**
 * Heading verbs whose `uuid` param addresses a HEADING row (not a project) —
 * the pipeline resolves their target as a heading, and H-UNKNOWN-DESTINATION
 * requires the target BE a heading. add-heading (project + title) and
 * move-heading (project + heading list) carry no single heading `uuid`.
 */
export const HEADING_TARGET_OPS: readonly OperationKind[] = [
  "project.rename-heading",
  "project.archive-heading",
  "project.unarchive-heading",
  "project.promote-heading",
  "project.dissolve-heading",
] as const;

export function isHeadingTargetOp(op: OperationKind): boolean {
  return HEADING_TARGET_OPS.includes(op);
}

/**
 * Placement of a heading among its project's headings (spec §2). Anchors are
 * resolved heading uuids (the consumer resolves the `--before-heading` /
 * `--after-heading` selector before the op runs).
 */
export type HeadingPlacement =
  | { position: "first" | "last" }
  | { before: string }
  | { after: string };

/** Recurrence frequency the minimal v1 GUI rule vocabulary supports. */
export type RepeatFrequency = "daily" | "weekly" | "monthly" | "yearly";

/** `when` scheduling value: list keyword or a concrete date. */
export type WhenValue = "today" | "evening" | "anytime" | "someday" | IsoDate;

/** Container reference by uuid or (unique, case-insensitive) title. */
export interface ContainerRef {
  uuid?: string;
  title?: string;
}

export interface TodoAddParams {
  title: string;
  notes?: string;
  when?: WhenValue;
  /**
   * Time-of-day reminder, `HH:mm` 24h. Requires a schedulable `when`
   * (today, evening, or a date) in the same call.
   */
  reminder?: ReminderTime;
  deadline?: IsoDate;
  tags?: string[];
  checklistItems?: string[];
  project?: ContainerRef;
  area?: ContainerRef;
  /** Existing heading inside the target project (placement only). */
  heading?: string;
  /**
   * Born-backdated creation timestamp (ISO date or datetime). Compiles the add
   * through `things:///json` (the only at-creation backdating surface, P4d) —
   * a date-only value normalizes to noon in the effective zone (§5).
   */
  createdAt?: string;
  /**
   * Born RESOLVED: the created to-do lands completed with this completion
   * timestamp, straight to the Logbook (P4d). ISO date or datetime; date-only
   * normalizes to noon in the effective zone (§5). Compiles through
   * `things:///json`.
   */
  completedAt?: string;
}

export interface TodoUpdateParams {
  uuid: string;
  title?: string;
  notes?: string;
  /** Append to the existing notes (newline-joined). Exclusive with notes/prependNotes. */
  appendNotes?: string;
  /** Prepend to the existing notes (newline-joined). Exclusive with notes/appendNotes. */
  prependNotes?: string;
  when?: WhenValue;
  /**
   * `HH:mm` sets a reminder (requires when: today|evening in the same call);
   * null clears it (today/evening only — a dated reminder can only be
   * changed, not cleared). When re-scheduling with this OMITTED, an existing
   * reminder is auto-preserved.
   */
  reminder?: ReminderTime | null;
  deadline?: IsoDate | null;
}

export interface UuidParams {
  uuid: string;
}

export interface HeadingAddParams {
  /** Existing project to create the heading in (uuid or unique, case-insensitive title). */
  project: ContainerRef;
  title: string;
}

/**
 * project.move-heading — reposition one or more of a project's headings as an
 * ordered block (spec §2/§4). `headings` are resolved heading uuids in the
 * order they should land (selection order = resulting order); their children
 * follow. Anchors in `placement` are resolved heading uuids too.
 */
export interface MoveHeadingParams {
  project: ContainerRef;
  headings: string[];
  placement: HeadingPlacement;
}

export interface HeadingRenameParams {
  uuid: string;
  title: string;
}

/**
 * project.move-heading-to-project — relocate ONE heading (with its children) to a
 * DIFFERENT project (spec §2 cross-project move; HEADXPROJ recipe). GUI-only: the
 * heading row's `…` ellipsis → Move… → keyboard-driven project picker. `heading`
 * is a selector (exact title or uuid) WITHIN `project`; `toProject` is the
 * destination. Distinct from `project.move-heading` (a pure within-project
 * reorder) — this is the cross-container relocation, kept a separate verb so the
 * destructive-ish container change is never conflated with an in-project shuffle.
 */
export interface MoveHeadingToProjectParams {
  /** The source project the heading currently lives in. */
  project: ContainerRef;
  /** The heading to move: exact title or uuid, within `project`. */
  heading: string;
  /** The destination project the heading (and its children) relocate to. */
  toProject: ContainerRef;
}

export interface HeadingArchiveParams {
  uuid: string;
  /**
   * What happens to the heading's OPEN children (required when any exist):
   * - "complete": the archive cascade completes them (app behavior);
   * - "cancel":   the app's cancel-cascade marks them canceled (the heading
   *               itself still stores as completed — the app has no canceled
   *               heading state);
   * - "reparent": children move to the project root first (each a verified
   *               mutation), then the empty heading is archived.
   * Children already completed/canceled are never touched.
   */
  children?: "complete" | "cancel" | "reparent";
}

export interface HeadingUnarchiveParams {
  uuid: string;
  /**
   * Also reopen children the archive cascade resolved (identified by the
   * <2s stopDate window; someday state survives the round-trip). Children
   * resolved at other times are never touched.
   */
  restoreChildren?: boolean;
}

/**
 * Rewrite the completion and/or creation timestamp of an EXISTING resolved row
 * via the AppleScript `set completion date` / `set creation date` property
 * writes (the only surface that moves these fields on an existing item —
 * BACKDT/#404). Kind-agnostic: the same op shape addresses a to-do
 * (`todo.set-dates`, `to do id`) or a project (`project.set-dates`,
 * `project id`).
 *
 * Values are an ISO date (`2025-01-15`) OR a datetime (`2025-01-15T09:30`);
 * a date-only value normalizes to NOON in the effective zone (§5 of the
 * resolution-timestamp plan). The completion-date leg fires EXCLUSIVELY against
 * a verified-completed row (the generalized WG-7 / H-BACKDATE-OPEN law), so the
 * multi-leg orchestrators flip a canceled item to completed before applying it
 * and back afterward.
 */
export interface SetDatesParams {
  uuid: string;
  /** New completion timestamp (ISO date or datetime); requires a completed row. */
  completedAt?: string;
  /** New creation timestamp (ISO date or datetime); status-safe on any row. */
  createdAt?: string;
}

export interface TodoMoveParams {
  uuid: string;
  project?: ContainerRef;
  area?: ContainerRef;
  /** Existing heading inside the destination project. */
  heading?: string;
  /** Move back to the Inbox — removes any schedule. Exclusive with the others. */
  inbox?: boolean;
  /**
   * `--no-heading` (spec §5): leave the heading but STAY in the current
   * project — the to-do lands in the project's unheaded block. Exclusive with
   * the others. Wire: re-assert the current project as the container with no
   * heading param.
   */
  noHeading?: boolean;
  /**
   * `--loose` (spec §5): the total sever — leave heading, project, AND area,
   * keeping the schedule. Exclusive with the others. (This is what the removed
   * `--detach` did; the detach family renames it.)
   */
  loose?: boolean;
}

export interface TodoSetTagsParams {
  uuid: string;
  /** Full replacement set (an empty list clears all tags). */
  tags: string[];
}

/** One checklist item in a stateful replacement. */
export interface ChecklistItemSpec {
  title: string;
  /** Recreate the item pre-checked. */
  completed?: boolean;
}

export interface TodoReplaceChecklistParams {
  uuid: string;
  /**
   * Full replacement list. Plain strings recreate items unchecked; object
   * entries can recreate items pre-checked. Item uuids are NOT stable
   * across a rewrite.
   */
  items: (string | ChecklistItemSpec)[];
}

/** One granular checklist action (audited as INTENT, not a full snapshot). */
export type ChecklistItemAction = "add" | "remove" | "check" | "uncheck" | "rename" | "move";

/**
 * ONE granular checklist edit. Delivered as a full `todo.replace-checklist`
 * rewrite (the only surface Things offers) but audited as the intent + the
 * targeted item's pre-state, so undo can apply a TARGETED inverse against the
 * current list instead of clobbering it. Orchestrated by `runEditChecklist`;
 * never dispatched directly through the pipeline (no atomic surface exists).
 */
export interface TodoEditChecklistItemParams {
  uuid: string;
  action: ChecklistItemAction;
  /** Targeted item title (add: the new item's title). */
  title?: string;
  /** 1-based target index; exact, overrides `title`. */
  index?: number;
  /** add: 1-based insert position (default: append). */
  at?: number;
  /** move: 1-based destination position. */
  to?: number;
  /** rename: the new title. */
  newTitle?: string;
}

export interface ProjectAddParams {
  title: string;
  notes?: string;
  area?: ContainerRef;
  when?: WhenValue;
  deadline?: IsoDate;
  todos?: string[];
  /**
   * Born-backdated creation timestamp (ISO date or datetime). Compiles through
   * `things:///json`; date-only normalizes to noon in the effective zone (§5).
   */
  createdAt?: string;
  /**
   * Born RESOLVED: the created project lands completed with this completion
   * timestamp, straight to the Logbook (B-PROJ-JSON). Refused when the project
   * carries any OPEN child spec — a completed-project json import silently
   * reverts to open unless every child is resolved (§5b). ISO date or datetime;
   * date-only normalizes to noon in the effective zone (§5).
   */
  completedAt?: string;
}

export interface ProjectUpdateParams {
  uuid: string;
  title?: string;
  notes?: string;
  /** Append to the existing notes (newline-joined). Exclusive with notes/prependNotes. */
  appendNotes?: string;
  /** Prepend to the existing notes (newline-joined). Exclusive with notes/appendNotes. */
  prependNotes?: string;
  when?: WhenValue;
  /**
   * `HH:mm` sets a reminder (requires when: today|evening|YYYY-MM-DD in the
   * same call); null clears it (today/evening only — a dated reminder can
   * only be changed, not cleared). Same semantics as to-do reminders.
   */
  reminder?: ReminderTime | null;
  deadline?: IsoDate | null;
}

export interface ProjectSetTagsParams {
  uuid: string;
  /** Full replacement set (an empty list clears all tags). */
  tags: string[];
}

export interface ProjectMoveParams {
  uuid: string;
  /** Destination area (uuid or unique name). */
  area?: ContainerRef;
  /**
   * `--no-area` (spec §5): leave the current area — a project's complete
   * (single-level) detach. Exclusive with area. (Replaces the removed
   * `--detach`.)
   */
  noArea?: boolean;
}

export interface ProjectCompleteParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default: completing a project also
   * completes its open children.
   */
  children: "require-resolved" | "auto-complete";
}

export interface ProjectCancelParams {
  uuid: string;
  /**
   * Open-children policy — REQUIRED, no default: canceling a project also
   * cancels its open children; completed children are untouched.
   */
  children: "require-resolved" | "auto-cancel";
}

export interface AreaAddParams {
  title: string;
  tags?: string[];
}

export interface TagAddParams {
  title: string;
  /** Existing parent tag title to nest under. */
  parent?: string;
}

export interface NameOrUuidParams {
  /** uuid or unique case-insensitive title. */
  target: string;
}

export interface AreaUpdateParams {
  /** uuid or unique case-insensitive title. */
  target: string;
  title?: string;
  /** Full replacement set of EXISTING tag titles. */
  tags?: string[];
}

export interface TagUpdateParams {
  /** uuid or unique case-insensitive title. */
  target: string;
  title?: string;
  /** Existing tag to nest under. Exclusive with unnest. */
  parent?: string;
  /** Un-nest the tag to the root of the hierarchy. Exclusive with parent. */
  unnest?: boolean;
  /** Single character to bind. Exclusive with clearShortcut. */
  shortcut?: string;
  /** Remove the tag's keyboard shortcut. Exclusive with shortcut. */
  clearShortcut?: boolean;
}

export type ReorderScope =
  | "today"
  | "evening"
  | "project"
  | "area"
  | "inbox"
  | "someday"
  | "projects"
  // Phase A.1 wired protocols (reordgaps-results.md REORDGAPS + BOUNCE2):
  // - heading: a heading's anytime children, forward-order bounce (BOUNCE2-h)
  // - area-someday: an area's someday members, reverse-order bounce (SOMEBNC-area)
  // - anytime: area-less loose anytime to-dos, reverse-order bounce (ANYBNC)
  // - container-day: a container's same-day scheduled children, native todayIndex
  //   re-rank, date-preserving (DAYORD-b). KEPT for the single-project-container,
  //   unheaded degenerate case (one atomic native call — cheaper than the bounce).
  // SIT4 DAYBNC — the DATED BOUNCE (lab/sit4-daybounce-eveord-axdrag4.md):
  // - day: an ARBITRARY future day-group across ALL containers — loose, project-
  //   child, headed-child, and area-direct to-dos AND area-less scheduled PROJECT
  //   rows sharing ONE future Upcoming day, ranked on todayIndex. A cross-date re-
  //   when round-trip (away = the neighbour day D+1, back = the day D; to-dos via
  //   todo.update, projects via update-project — per row TYPE) FRONT-inserts each
  //   row at the day-D GLOBAL todayIndex minimum across containers, so a reverse-
  //   target-order bounce lands the exact cross-container order. Non-destructive:
  //   reminderTime, deadline, and the heading FK all survive the round-trip (§2e /
  //   R21 — the decisive contrast with the evening bounce, whose when=evening leg
  //   strips a reminder). Bounce-only — NO native surface reaches an arbitrary day
  //   (the private reorder is not needed); gated by bounce-enabled + bounce-max-
  //   items like every bounce. Sequential URL legs only (the things:///json when=
  //   reindex is unproven for dated placement — §9i tested anytime only). Refuses a
  //   repeating TEMPLATE movee/anchor (§9e/§1 — a dated when= leg CRASHES a
  //   template). SUPERSEDES the scratch-park compounds (loose-day / area-day /
  //   upcoming-day) and the heading-day unhead→re-head round-trip — the dated
  //   bounce serves their whole population plus area-less project rows, with no
  //   scratch project and no experimental gate. Planner-selected only (never a CLI
  //   flag; the day is read off a movee).
  // ORDFIN2 TOMORROWLIST — the one-call TOMORROW fast path (ordfin2-followups.md):
  // - tomorrow: a whole next-day (== tomorrow, relative to the response clock)
  //   day-group across ALL containers, ranked on todayIndex. `list "Tomorrow"` is
  //   a CLEAN one-call native day-sort surface — it re-ranks the full group in ONE
  //   `_private_experimental_ reorder to dos in list "Tomorrow"` call, ACCEPTS a
  //   scheduled PROJECT row inline (O12 analog — projects pass the `ids` filter),
  //   and preserves startDate/start/startBucket/area+project FKs (no §9g re-date,
  //   unlike `list "Upcoming"`). The cheapest day surface — KEPT for the tomorrow
  //   case (one call vs the dated bounce's 2N legs). Gated like container-day
  //   (allow-experimental + sdef canary). Planner-selected only (day read off a
  //   movee).
  // HEADSUB1 within-heading sub-bucket protocol (lab/headsub1-heading-subbuckets.md):
  // - heading-someday: a heading's SOMEDAY children, ranked on "index". Re-headed
  //   in FORWARD target order (each a single `todo.move` list-id+heading leg) —
  //   the move-to-heading BACK-INSERT is deterministic (Arm B-someday / Arm C),
  //   so re-heading the block in target order IS the sort. Compiles exactly like
  //   the `heading` anytime scope (back-insert suffix, co-touch disclosure), but
  //   the per-item leg is one re-head, not a when= bounce. No experimental/bounce
  //   gate (pure URL move legs). Planner-selected only.
  | "heading"
  | "area-someday"
  | "anytime"
  | "container-day"
  | "day"
  | "heading-someday"
  | "tomorrow"
  // TMPLSORT/PTMPL template day-block wiring — an INTERNAL leg scope, never a user
  // scope and never routed through the strategy resolver / planner. The `day` bounce
  // dispatches one per repeating TO-DO template in the group: a single-id
  // `_private_experimental_ reorder to dos in list "Upcoming" with ids "<template>"`
  // NATIVE front-insert (TMPLSORT-1 — the template's todayIndex front-inserts below
  // the block min, umd-silent, no reparent, no crash), interleaved into the reverse-
  // target dispatch on the SAME shared block min-space as the when=/deadline families
  // (TMPLSORT-2). Compiles the `list "Upcoming"` specifier with the sent id only (no
  // wire extension); gated by allow-experimental + the sdef canary like every native
  // reorder. NEVER a full-block sort — the day dispatch owns block ordering.
  | "upcoming";
export type ReorderStrategy = "native" | "bounce";

export interface ReorderParams {
  scope: ReorderScope;
  /**
   * Required for the project/area scopes; must be omitted for
   * today/evening/inbox/someday/projects.
   */
  container?: ContainerRef;
  /**
   * Desired order, top-first. May be a SUBSET of the scope's members: the
   * requested uuids are placed at the top in this order and every remaining
   * member keeps its current relative order below them. For an ANCHORED bounce
   * placement (--before/--after) the planner passes the FULL target order here
   * with the block spliced at the anchor.
   */
  uuids: string[];
  /**
   * The explicitly-NAMED movees, a subset of {@link uuids}. Distinguishes the
   * user's block from members that only ride along a bounce anchor placement
   * (co-bounced siblings — disclosed in the result). Defaults to all of `uuids`
   * when omitted (every uuid is a named movee). Only the bounce path reads it.
   */
  named?: string[];
  /**
   * Omit for the default per scope: native for today/project/area/inbox/
   * someday (requires allowExperimental), bounce for evening and
   * projects. Today accepts an explicit "bounce" fallback; evening is
   * bounce-only; "projects" (top-level sidebar order) is bounce-only — each
   * project takes a when=someday -> when=anytime round-trip, which
   * front-inserts it (P8e).
   */
  strategy?: ReorderStrategy;
}

export type EmptyParams = Record<string, never>;

/**
 * Move an area to a new position in the canonical area order. Area order has
 * no headless spelling at all (P6/O13) — this is delivered by the ui vector's
 * drag driver. Exactly ONE of before / after / position is required.
 */
export interface AreaReorderParams {
  /** The area to move: uuid or unique case-insensitive title. */
  target: string;
  /** Place it immediately ABOVE this area (uuid or unique title). */
  before?: string;
  /** Place it immediately BELOW this area (uuid or unique title). */
  after?: string;
  /** Move it to the first or last area slot. Exclusive with before/after. */
  position?: "first" | "last";
}

/** Weekday name (weekly day-of-week set; monthly/yearly nth-weekday anchor). */
export type Weekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export const WEEKDAYS: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** The ordinal a monthly/yearly nth-weekday anchor selects (1st..5th, or last). */
export type WeekdayOrdinal = 1 | 2 | 3 | 4 | 5 | "last";

/**
 * A monthly (or yearly) day anchor — the mutually-exclusive forms the Repeat
 * dialog's month row offers (UIC1 field map). Exactly one shape:
 *  - `{ day }`     — a day-of-month (1..31, or "last" = the month's last day);
 *  - `{ weekday, ordinal }` — the nth (or last) weekday of the month.
 */
export type MonthlyAnchor =
  | { day: number | "last" }
  | { weekday: Weekday; ordinal: WeekdayOrdinal };

/** A yearly anchor: a month (1..12) plus the monthly-style day anchor. */
export type YearlyAnchor = { month: number } & MonthlyAnchor;

/**
 * The Repeat dialog's "Ends" bound (single-choice pop-up, UIC1). Omit for the
 * dialog default (`never`). `on-date` is the date picker; `after` the count
 * field (the ORIGINAL number of occurrences, not the remaining tally).
 */
export type RepeatEnds =
  | { kind: "never" }
  | { kind: "on-date"; date: IsoDate }
  | { kind: "after"; count: number };

/**
 * Set (make-repeating) or edit (reschedule-repeat) a to-do's or project's
 * recurrence rule through the GUI's Repeat dialog. The BASE vocabulary is
 * `frequency` + `interval`; every other field is OPTIONAL and defaults to the
 * dialog's own default, so a `{ uuid, frequency, interval }` call is unchanged.
 *
 * The optional fields cover the full UIC1 dialog field map. Combinations are
 * validated (assertRepeatRule): a per-frequency field on the wrong frequency is
 * refused, and the modal month anchor is a discriminated shape (day-of-month OR
 * nth-weekday, never a contradictory bag).
 */
export interface RepeatRuleParams {
  uuid: string;
  /** The recurrence unit (also the "after completion" cadence when afterCompletion). */
  frequency: RepeatFrequency;
  /** "every N units", 1–99. */
  interval: number;
  /**
   * After-COMPLETION cadence instead of a fixed schedule (rule type tp=1): the
   * next occurrence is N units after the prior instance RESOLVES. Mutually
   * exclusive with the calendar anchors (weekdays/monthly/yearly) — an
   * after-completion rule has no calendar day.
   */
  afterCompletion?: boolean;
  /**
   * WEEKLY only: the set of weekdays the rule fires on (dialog day-of-week
   * toggles + "+"). Omit for the single anchor weekday the dialog defaults to.
   */
  weekdays?: Weekday[];
  /** MONTHLY only: the day-of-month or nth-weekday anchor (dialog month row). */
  monthly?: MonthlyAnchor;
  /** YEARLY only: the month + day anchor (dialog year row). */
  yearly?: YearlyAnchor;
  /** The "Ends" bound (dialog default: never). */
  ends?: RepeatEnds;
  /** "Add reminders" time-of-day (`HH:mm`, 24h) on the spawned instances. */
  reminder?: ReminderTime;
  /** "Add deadlines": the template deadlines its instances. */
  deadline?: boolean;
  /**
   * With deadline: start the instance N days BEFORE its deadline (the dialog's
   * "start N days earlier" field, revealed by "Add deadlines"). Integer ≥ 0;
   * implies `deadline` (a start offset only exists on a deadlined template).
   */
  startDaysEarlier?: number;
}

/**
 * Create a project and, in the same call, promote it to a repeating series
 * (the two-step composite of UIC4-f). The create seeds a pure-AX taxonomy —
 * an `area` lands the project as a selectable AREA-view row; otherwise it is
 * created in Someday — so the promote never needs a coercion. The two legs are
 * NOT atomic: the created project persists even if the promote refuses.
 */
export interface ProjectAddRepeatingParams {
  title: string;
  notes?: string;
  /** Destination area (uuid or unique name); when omitted the project is created in Someday. */
  area?: ContainerRef;
  deadline?: IsoDate;
  todos?: string[];
  frequency: RepeatFrequency;
  /** "every N units", 1–99. */
  interval: number;
}

export interface OperationParamsMap {
  "todo.add": TodoAddParams;
  "todo.update": TodoUpdateParams;
  "todo.complete": UuidParams;
  "todo.cancel": UuidParams;
  "todo.reopen": UuidParams;
  "todo.move": TodoMoveParams;
  "todo.set-tags": TodoSetTagsParams;
  "todo.replace-checklist": TodoReplaceChecklistParams;
  "todo.edit-checklist-item": TodoEditChecklistItemParams;
  "todo.delete": UuidParams;
  "project.add": ProjectAddParams;
  "project.update": ProjectUpdateParams;
  "project.complete": ProjectCompleteParams;
  "project.delete": UuidParams;
  "area.add": AreaAddParams;
  "area.delete": NameOrUuidParams;
  "tag.add": TagAddParams;
  "tag.delete": NameOrUuidParams;
  "trash.empty": EmptyParams;
  reorder: ReorderParams;
  "todo.duplicate": UuidParams;
  "area.update": AreaUpdateParams;
  "tag.update": TagUpdateParams;
  "project.move": ProjectMoveParams;
  "todo.restore": UuidParams;
  "project.duplicate": UuidParams;
  "project.cancel": ProjectCancelParams;
  "project.reopen": UuidParams;
  "project.restore": UuidParams;
  "project.set-tags": ProjectSetTagsParams;
  "todo.set-dates": SetDatesParams;
  "project.set-dates": SetDatesParams;
  "project.add-heading": HeadingAddParams;
  "project.rename-heading": HeadingRenameParams;
  "project.archive-heading": HeadingArchiveParams;
  "project.unarchive-heading": HeadingUnarchiveParams;
  "project.promote-heading": UuidParams;
  "project.move-heading": MoveHeadingParams;
  "project.move-heading-to-project": MoveHeadingToProjectParams;
  "project.dissolve-heading": UuidParams;
  "todo.clear-dated-reminder": UuidParams;
  "todo.make-repeating": RepeatRuleParams;
  "todo.reschedule-repeat": RepeatRuleParams;
  "todo.pause-repeat": UuidParams;
  "todo.resume-repeat": UuidParams;
  "todo.convert-to-project": UuidParams;
  "project.reschedule-repeat": RepeatRuleParams;
  "project.pause-repeat": UuidParams;
  "project.resume-repeat": UuidParams;
  "area.reorder": AreaReorderParams;
  "project.make-repeating": RepeatRuleParams;
  "project.add-repeating": ProjectAddRepeatingParams;
  "log-now": EmptyParams;
}

/** Explicit confirmations for operations with cascading or permanent effects (never defaulted). */
export interface Acknowledgements {
  /** Confirm a wholesale checklist replacement that discards existing items and their checked states. */
  acknowledgeChecklistReset?: boolean;
  /** Confirm adding/moving an open item into a completed/canceled project (this reopens the project). */
  acknowledgeProjectReopen?: boolean;
  /** Confirm a permanent deletion: area/tag delete and empty-trash skip the Trash entirely. */
  dangerouslyPermanent?: boolean;
  /** Confirm that deleting a parent tag permanently deletes ALL of its descendant tags. */
  acknowledgeTagSubtree?: boolean;
  /**
   * Confirm deleting a NON-EMPTY area. Deleting an area sends its contained
   * to-dos AND projects (with their children) to the Trash and permanently
   * destroys the area itself; by default the delete refuses when the area still
   * holds any project or to-do, so nothing is trashed by surprise.
   */
  allowNonEmptyArea?: boolean;
  /**
   * Confirm a GUI-driven ("ui" vector) operation: it drives the LOCAL Things
   * app through the Accessibility API, may foreground Things and briefly take
   * over UI focus on this machine, and requires an unlocked session. The
   * second of the two keys (the first is the `ui.enabled` config).
   */
  dangerouslyDriveGui?: boolean;
}
