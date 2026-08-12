/**
 * Public entity types. Enum encodings per docs/atlas/schema-v26.md
 * (verified live against schema v26).
 */
import type { IsoDate, ReminderTime } from "./dates.ts";
import type { RepeatRule } from "./recurrence.ts";

export type TaskStatus = "open" | "canceled" | "completed"; // status 0 | 2 | 3
export type StartState = "inbox" | "active" | "someday"; // start 0 | 1 | 2
export type TaskType = "to-do" | "project" | "heading"; // type 0 | 1 | 2

/** Lightweight reference to another entity. */
export interface Ref {
  uuid: string;
  title: string;
  /**
   * Set (and only ever `true`) when this ref points at a repeating-template
   * PROJECT — the blueprint row whose `rt1_recurrenceRule`/`repeater` is
   * non-null (probe-verified: the template's CHILDREN are plain rows, so the
   * fact lives on the parent project). Only container/project refs ever carry
   * it — area and heading refs never do — so a consumer reads its absence as
   * "not a template". It disambiguates the two identical-looking same-title
   * copies a project conversion leaves behind (the template blueprint vs. its
   * spawned instance; see RepeatingInfo). Omitted when false (never `false`).
   */
  isRepeatingTemplate?: true;
}

/**
 * A surfaced tag: its NAME only. Tag uuids are a fully internal implementation
 * detail (like checklist item ids) — names are app-enforced-unique (TAGW1-c),
 * so a name is a sufficient reference, and no surface emits or accepts a tag
 * uuid. Nested-tag context, where it matters, is conveyed by the tag listing's
 * `parent` field, not here on the pill.
 */
export interface TagRef {
  title: string;
}

export interface RepeatingInfo {
  /** This row is a repeating template (rt1_recurrenceRule / repeater present). Invisible in normal lists. */
  isTemplate: boolean;
  /** This row was generated from a template. */
  isInstance: boolean;
  templateUuid: string | null;
  /** Templates: the app-materialized next occurrence date (null for after-completion rules until spawned). */
  nextOccurrence?: IsoDate | null;
  /** Templates: instance creation paused in the app UI. */
  paused?: boolean;
  /**
   * Templates: whether the repeat deadlines its spawned instances ("Add
   * deadlines" was ticked in the repeat editor). The discriminator is the
   * template row's own `deadline` column — a non-null far-future sentinel
   * (4001-01-01) when deadlined, NULL when deadline-less. It is NOT derivable
   * from the recurrence rule alone: a deadlined ts=0 rule is byte-identical to
   * a deadline-less one. VM-probed 2026-07-12 (UI1, oddities §8a).
   */
  deadlined?: boolean;
  /** Templates, detail reads only: the decoded repeat rule (read-only; undecodable rules are omitted). */
  rule?: RepeatRule;
  /**
   * Templates, detail reads only: the uuid of this template's LATEST spawned
   * instance — the GUI "Show Latest" pick, `max(creationDate)` among the
   * template's instances (SL1, docs/lab/sl1-show-latest.md). Populated by the
   * detail read (src/read/detail.ts); the shaping transform emits it NESTED
   * inside the wire `repeating` object (the complete series state), the backward
   * pointer symmetric to the forward `nextOccurrence`. Omitted when the template
   * has no instances. Never on a list/card row (token economy).
   */
  latestInstance?: string;
  /**
   * INSTANCES, detail reads only: the repeat CONTEXT this instance inherits from
   * its template — the GUI's lower-corner "Repeats on Aug 19" / "Repeats 1 day
   * after completion" caption. Populated by the detail read's mirror join
   * (src/read/detail.ts) by resolving `templateUuid` back to the template row and
   * decoding its rule; the shaping transform emits it as the wire `repeats`
   * sibling of `instanceOf`. Absent when the template row is missing/unresolvable
   * (dangling FK), or carries no surfaceable context. Only on an instance; never
   * on a template (which carries `rule`/`nextOccurrence` directly) or a list row.
   */
  repeats?: RepeatContext;
}

/**
 * The repeat CONTEXT surfaced on a repeating INSTANCE'S detail card — the join
 * of its template's series state onto the instance, so the card can render the
 * GUI's lower-corner repeat caption without re-fetching the template. Byte-
 * consistent with the template card's own emission for the same template: `rule`
 * is the SAME {@link RepeatRule} `decodeRecurrenceRule` produces for the template.
 */
export interface RepeatContext {
  /**
   * The template's decoded repeat rule — the SAME shape a template card emits
   * under `repeating.rule`. Omitted when the template's rule is absent or
   * undecodable (a future Things build), mirroring the template card.
   */
  rule?: RepeatRule;
  /**
   * FIXED mode only: the template's already-computed next-occurrence projection
   * (the "Aug 19" in the GUI). ABSENT for after-completion mode — no successor
   * date exists until the current instance completes, so absence is the honest
   * expression (the mode stays readable from `rule.type`).
   */
  next?: IsoDate;
  /** The template's paused flag — surfaced so the card can render honestly (`(paused)`). Omitted when false. */
  paused?: boolean;
}

/**
 * The internal DERIVATION SUBSTRATE bag — the entity fields that feed the
 * emission-time derivations (`stage` / `when` / `provisional`) and the human
 * render / write-verify paths, but never ride the JSON wire. Segregated into
 * this nested bag (one-vocabulary audit, Batch 2, Option B) so that everything
 * OUTSIDE `derived` is consumer vocabulary and everything INSIDE never reaches
 * the wire: `src/read/shape.ts` drops the whole substrate in ONE `delete
 * o.derived`, and the wire-key-inventory lock test guarantees a new substrate
 * field cannot leak. A programmatic consumer wanting the wire words should reach
 * for the exported {@link entityStage}/{@link entityWhen}/{@link
 * entityProvisional} helpers (a clock-derived read) rather than these raw fields.
 */
export interface DerivedSubstrate {
  /**
   * Raw start-state (inbox | active | someday). Feeds `stage`/`when`; cannot be
   * renamed to `stage` (raw vs the clock-derived taxonomy).
   */
  start: StartState;
  /**
   * In the GUI's Logbook. Completion and logged are SEPARATE states: a
   * closed item stays checked in its original list until the app's
   * log-move sweep passes it (TMSettings.logInterval / manualLogDate).
   */
  logged: boolean;
  trashed: boolean;
  /**
   * Presence-keyed Today-view marker (`true` or absent) — derived with the Today
   * view's own two-arm membership (a scheduled `startDate <= today`, OR an
   * undated due/overdue deadline that is not suppressed; see
   * src/read/stage.ts and views.ts todayView). It is a SEPARATE axis from
   * {@link stage-taxonomy}: an item can be `anytime`/`someday`/`inbox`/`upcoming`
   * and still be in Today. Set only when true (never `false`).
   */
  today?: true;
  /**
   * Presence-keyed This-Evening marker (`true` or absent) — the evening
   * sub-section of Today (`startBucket=1` AND `startDate` exactly today). Implies
   * {@link DerivedSubstrate.today}. Set only when true.
   */
  evening?: true;
  /**
   * The RAW stored reminder byte (`HH:mm`), possibly STALE — null when the row
   * carries no reminder at all. This is the substrate the write engine reads for
   * its pre-state/delta predictions; the honest, live-gated value a consumer sees
   * is the top-level {@link TaskCommon.reminder} (which this feeds).
   *
   * §9n: the app keeps the reminder byte in the DB forever, even once the row's
   * `startDate` goes strictly past — at that point the GUI hides the bell
   * (presentation-dead) but the byte is NOT gone: RE-SCHEDULING the item to
   * today/future REVIVES the reminder. The write engine therefore must predict
   * and verify against this raw byte, never the live-gated top-level value (a
   * past-dated `add --reminder` stores the byte; a `clear-dated-reminder` must
   * verify the byte itself is gone, not merely that the live view reads empty).
   * Computed at materialize (mappers) with no clock gating.
   */
  reminder: ReminderTime | null;
}

interface TaskCommon {
  uuid: string;
  title: string;
  notes: string;
  status: TaskStatus;
  /** The "When" date (packed int in DB), null when unscheduled. */
  startDate: IsoDate | null;
  deadline: IsoDate | null;
  /**
   * Time-of-day reminder (`HH:mm`, 24h) — the LIVE value only: it is null once the
   * reminder is presentation-dead (its row's `startDate` gone strictly past, §9n),
   * exactly what a consumer/renderer should honor. Live-gated at the mapper under
   * the response clock (the {@link reminderIsLive} predicate). The RAW stored byte
   * (which survives a stale schedule and is revived by re-scheduling) lives in the
   * substrate as {@link DerivedSubstrate.reminder}; the write engine reads THAT.
   */
  reminder: ReminderTime | null;
  area: Ref | null;
  /** Direct tags only, by name — mirrors DB truth (inherited tags are computed; see inheritedTags). */
  tags: TagRef[];
  /**
   * Tags inherited from an ancestor project/area, by NAME — a plain list
   * parallel to {@link tags} (native UI tag filtering includes these — T18).
   * Populated on the detail/card reads (`todo show`, `project show`) as an
   * array (empty when there are none); the emit-time omit-empty transform (#163)
   * drops it from JSON when empty, and it is absent (undefined) on list rows,
   * which surface direct tags only. Never merged into {@link tags}.
   */
  inheritedTags?: TagRef[];
  repeating: RepeatingInfo;
  created: Date;
  modified: Date;
  stopped: Date | null;
  /**
   * The internal derivation substrate (raw lifecycle + Today/reminder markers) —
   * NEVER on the JSON wire. See {@link DerivedSubstrate}.
   */
  derived: DerivedSubstrate;
}

export interface Todo extends TaskCommon {
  type: "to-do";
  project: Ref | null;
  /** When set, project is reached via the heading (DB invariant: project column is NULL). */
  heading: Ref | null;
  /**
   * Owning project resolved THROUGH the heading (`project` itself stays
   * null — DB truth). Computed opt-in: list views populate it so consumers
   * get the GUI's container label without a second lookup.
   */
  headingProject?: Ref;
  checklist?: ChecklistItem[];
  checklistItemsCount: number;
  openChecklistItemsCount: number;
}

export interface Project extends TaskCommon {
  type: "project";
  untrashedLeafActionsCount: number;
  openUntrashedLeafActionsCount: number;
}

export interface Heading {
  uuid: string;
  type: "heading";
  title: string;
  /**
   * Internal archive-state axis: "completed" = archived, "open" = live. A
   * heading has no canceled state (oddity §169: the GUI + our verb vocabulary
   * for a heading is archive/unarchive, never complete/cancel — the archive
   * byte IS the stopDate). The read wire does NOT surface this word for a
   * heading GROUP node; it emits the presence-keyed {@link Heading.stopped} as
   * `archived` instead (see src/read/shape.ts). Retained here for the write
   * archive/unarchive result checks and the heading detail render.
   */
  status: TaskStatus;
  /** The archive timestamp (the stopDate) — null while the heading is open. */
  stopped: Date | null;
  /** The owning project. */
  project: Ref | null;
}

export interface Area {
  uuid: string;
  title: string;
  visible: boolean;
  tags: TagRef[];
}

/**
 * A tag in the `things tags` taxonomy listing. Uuid-free (an internal detail):
 * the tree is conveyed by `parent` — the parent tag's NAME (null for a root) —
 * so a consumer can reconstruct the hierarchy, and by indentation in the human
 * render. Names are globally unique (TAGW1-c), so the leaf name alone is a
 * usable tag reference.
 */
export interface Tag {
  title: string;
  shortcut: string | null;
  /** Parent tag's NAME, or null for a root tag. */
  parent: string | null;
}

/**
 * A checklist item as the API surfaces it: title + status only. The DB uuid
 * is deliberately omitted — it is regenerated on every checklist rewrite and
 * is never a valid mutation target (address items by title or 1-based
 * position; see docs/design/reference-resolution.md). `status` is open |
 * completed | canceled (canceled exists in real data); items have no
 * trashed/logged state — they live and move with their parent to-do.
 */
export interface ChecklistItem {
  title: string;
  status: TaskStatus;
}

export type AnyTask = Todo | Project | Heading;

/** Items grouped under one ISO date (Upcoming days, project "later" groups). */
export interface IsoDateGroup<T> {
  /**
   * The ISO day the group sits under — named `when` to speak the same time-axis
   * word the read wire and the `--in <when>` reorder token use (one name per
   * concept; the render/view builders never translate it).
   */
  when: string;
  items: T[];
}

// Raw-value mapping tables (DB integer -> public union), used by mappers.
export const TASK_TYPE_FROM_DB: Record<number, TaskType> = {
  0: "to-do",
  1: "project",
  2: "heading",
};
export const TASK_STATUS_FROM_DB: Record<number, TaskStatus> = {
  0: "open",
  2: "canceled",
  3: "completed",
};
export const START_STATE_FROM_DB: Record<number, StartState> = {
  0: "inbox",
  1: "active",
  2: "someday",
};
