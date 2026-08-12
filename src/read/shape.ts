/**
 * The read-payload SHAPING transform: the token-economy rules R6 and R7, the
 * universal item-DTO reshapes (R9), and the R10 lifecycle taxonomy — applied at
 * the JSON emit boundary of the read surfaces (the CLI `--json` read envelope,
 * src/cli/read-driver.ts, and the MCP read tool results, src/mcp/server.ts), the
 * same boundaries omit-empty runs at. Shaping runs BEFORE omit-empty. The
 * human-render path keeps the full, unshaped entities, so this is JSON-only.
 *
 * Both R6/R7 are deterministic BY VIEW KIND / SECTION — the emitter knows whether
 * it is inside a single-container view, a lifecycle bucket, or a mixed list —
 * never a per-item heuristic.
 *
 * ## R10 — the `stage` lifecycle taxonomy (every tier, every kind incl. detail)
 * The three former wire fields `start` / `logged` / `trashed` are DELETED from
 * every item and replaced by ONE derived `stage` ∈ `inbox | upcoming | anytime |
 * someday | logbook | trash` (src/read/stage.ts `deriveStage`, the single pure
 * derivation reused by the card bucketing so `stage` can never disagree with the
 * bucket a view puts an item in). Today/evening membership is a SEPARATE
 * presence-keyed axis — `today: true` / `evening: true` (evening implies today) —
 * derived in the mapper with the Today view's own two-arm predicate.
 * - `stage` is DROPPED only where the enclosing node PROVABLY states it — the R6
 *   rule (drop only what the node provably says). That is the stage-PURE flat
 *   views (inbox, `anytime`, someday, logbook, trash) and the stage-named card
 *   sub-buckets (anytime/upcoming/someday/logbook/trash, which the bucketer splits
 *   BY stage). The `anytime` catalogue is stage-PURE (R10.2): every member is an
 *   Anytime-view row (ANYTIME_SELF) — undated-active, arrived-active, or arrived
 *   someday-scheduled — and an ARRIVED dated row derives `anytime` (Upcoming is
 *   STRICTLY FUTURE, UPC1), so the field is redundant there.
 *   `stage` is KEPT on the stage-MIXED or derived surfaces: the `upcoming` view
 *   carries deadline-forecast stage-`anytime`/`someday` rows alongside its
 *   future-dated stage-`upcoming` ones — dropping `stage` there would delete
 *   non-redundant information — plus `today` (mixes upcoming + anytime-deadline
 *   rows), search, changes, the projects/areas listings, the card NODE, and
 *   detail.
 * - the former `todaySection` field is DELETED from the entity model entirely:
 *   it merely duplicated the presence-keyed `today`/`evening` markers
 *   (`todaySection: "evening"` ⇔ `evening: true`; `"today"` ⇔ `today && !evening`),
 *   which every consumer now reads directly (the human render, the write-verify
 *   delta, the today-view evening split).
 *
 * ## R12 — `when`, the derived TIME-AXIS position (replaces startDate + markers)
 * Today/evening membership and the scheduled/projected date collapse onto ONE
 * derived, presence-keyed field `when` (src/read/stage.ts `deriveWhen`): `"today"`
 * / `"evening"` (Today-view membership, from the SAME `today`/`evening` markers the
 * mapper stamps — never re-derived, so `when` can never disagree with the star), a
 * FUTURE ISO date (a strictly-future scheduled row, or a template's projected next
 * occurrence), or absent (unscheduled + not in Today; also an unprojected template
 * and every logged/trashed row). The doctrine line: **`stage` enumerates the
 * sidebar BUCKETS an item lives in; `when` enumerates its TIME POSITIONS (today |
 * evening | a future date).** Someday is deliberately NOT a `when` value (it is a
 * bucket → stage). Tier/drop rules:
 * - the former `today`/`evening` marker KEYS are DELETED from the wire on EVERY
 *   tier — `when` carries the fact; the markers stay internal (they feed `when`).
 * - the raw `startDate` is DELETED in COMPACT (a list needs the position, not the
 *   substrate) and KEPT in FULL/DETAIL beside `when` — different facts: `startDate`
 *   = what is stored, `when` = where it sits.
 * - a template's `repeating.nextOccurrence` is GONE from the wire — `when` replaces
 *   it (same fact, one word); the resting-templates `{date: null}` group is
 *   unchanged (an unprojected template has no `when`).
 * - `when` is DROPPED inside the `today` view's two `children` bucket records (the
 *   bucket key `today`/`evening` states it) and inside any card/heading `upcoming`
 *   DATE-GROUP for a member whose `when` equals the group's date (the group states
 *   it). KEPT everywhere
 *   else it is present — including the flat `upcoming`/`anytime`/`inbox`/`someday`
 *   catalogues, search, changes (a deadline-pulled row reads `when: "today"` in the
 *   mixed search/changes surfaces, informatively; note R13 re-files it to stage
 *   `anytime` and the flat inbox/someday views now EXCLUDE it — it appears in the
 *   `anytime` catalogue instead, `when: "today"` kept, stage dropped as pure).
 *
 * ## R13 — provisional Today members + GUI-faithful pulled-row membership
 * BANNER1 / BANNER1b (docs/lab/banner1-research.md). Two coupled facts:
 * - **`provisional: true`** — a presence-keyed marker on every Today member the GUI
 *   pips / counts in the "You have N new to-dos" banner: a Today member NOT yet
 *   materialized (`start != active OR startDate IS NULL`, BANNER1 L1). Derived from
 *   the SAME today/evening markers + fields the stage/`when` axes use (never
 *   re-derived). Emitted on EVERY tier, NEVER dropped (the banner is not a section,
 *   so no node implies it). Absent on non-Today rows and on materialized ones.
 *   Read-only: the app clears it by materializing the row on banner-OK, a GUI-only
 *   side effect our read cannot perform (watchers beware).
 * - **stage `anytime` for a deadline pull** — a due-deadline pull re-files an undated
 *   Inbox/Someday row into Anytime (deriveStage step 2½, L-A). So EVERY Today member
 *   derives stage `anytime`, and the `today` view's two `children` buckets become
 *   stage-PURE → `stage` is DROPPED there (TODAY_SECTION_DROP), alongside the
 *   key-implied `when`. The flat someday/inbox views EXCLUDE pulled rows and the anytime view
 *   INCLUDES them (src/read/views.ts + predicates.ts DEADLINE_PULLED) — GUI fidelity.
 *
 * ## Universal item-DTO reshapes (R9 — EVERY tier, EVERY read kind incl. detail)
 * - **checklist nesting** — flat counts → presence-keyed `checklist: {open,total}`.
 * - **todos counts** — a project's flat leaf-action counts → presence-keyed
 *   `todos: {open, total}` (omit when total 0).
 * - **repeating template/instance split (R11)** — the wire drops the
 *   `isTemplate`/`isInstance` discriminators; key presence carries the fact. A
 *   TEMPLATE keeps a nested `repeating: {paused?, deadlined?, rule?,
 *   latestInstance?}` — the series object (rule config + backward pointer +
 *   state flags); presence MEANS template. The forward pointer `nextOccurrence`
 *   moved to the top-level `when` (R12 — a template's projected date IS its time
 *   position); `latestInstance` is detail-only (SL1). An INSTANCE keeps a flat
 *   `instanceOf: <templateUuid>` and no `repeating`; on a DETAIL read it also
 *   gains a sibling `repeats: {rule?, next?, paused?}` — its template's repeat
 *   context (the GUI's lower-corner caption), `rule` byte-consistent with the
 *   template card's `repeating.rule` and `next` the fixed-mode next occurrence. A
 *   plain row keeps neither. See {@link reshapeRepeatingWire}.
 * - **string tags** — `tags`/`inheritedTags` become plain arrays of names.
 * - **one project key** — a headed item's owning project (formerly
 *   `headingProject`) is merged into `project`; `headingProject` never appears.
 *
 * ## R6 — no-redundant-ancestry (both tiers)
 * project-view children drop `project`+`area` (heading-group members also drop
 * `heading`); area-view children/project-cards drop `area`; anytime/someday
 * section items drop `area`. Mixed lists keep every ref. (In the COMPACT tier the
 * `heading` ref is additionally dropped everywhere — R7.)
 *
 * ## R7 — named detail tiers (compact | full)
 * List contexts default to COMPACT; `detail`/`show` and `--full` / `full:true`
 * use FULL. Compact drops `created`/`modified`, the full `notes` string (a
 * presence-keyed `hasNotes: true` marks a row with notes), and the `heading` ref;
 * `status` is omitted when `open`. FULL keeps them but still applies R6, the
 * universal reshapes, and R10.
 */
import { deriveStage, deriveWhen, whenIsProvisional, type Stage, type When } from "./stage.ts";
import type { StartState } from "../model/entities.ts";
import type { AreaBucketTotals, SectionTotals, UpcomingBlockTotals } from "./truncation.ts";

type Obj = Record<string, unknown>;

/** The container-ref kinds whose bare title is round-trip-tested for uuid promotion. */
export type RefKind = "area" | "project" | "heading";

/**
 * The emit-side promotion oracle: does a container ref's bare TITLE round-trip
 * through its own resolver, in its own scope, back to THIS entity? Built by
 * {@link makeRefPromoter} (src/read/queries.ts) over the live DB — it runs the
 * REAL resolution path for the kind (areas = all areas; projects = the live+open
 * write-target pool, uuid-prefix tier first; headings = within `projectUuid`)
 * and returns true only when the sole resolution is this uuid; not-found or
 * ambiguous is false. Memoized per (kind, title, scope) within one response
 * emission. When a promoter is absent (a DB-less unit shaping), the default
 * assumes every title round-trips — bare titles, no uuid siblings.
 */
export interface RefPromoter {
  roundTrips(kind: RefKind, title: string, entityUuid: string, projectUuid?: string): boolean;
}

/** The DB-less default: assume every title round-trips (bare title, no uuid sibling). */
const ALWAYS_ROUND_TRIPS: RefPromoter = { roundTrips: () => true };

/** The uuid of a `{uuid,title}` container Ref, or undefined for a non-object / string. */
function refUuid(v: unknown): string | undefined {
  if (v !== null && typeof v === "object" && typeof (v as Obj)["uuid"] === "string") {
    return (v as Obj)["uuid"] as string;
  }
  return undefined;
}

/**
 * Whether a still-unflattened container Ref carries the repeating-TEMPLATE mark.
 * Only project/container refs ever set it (area/heading refs never do — see
 * entities.Ref), so this reads true only for a template PROJECT container.
 */
function refIsTemplate(v: unknown): boolean {
  return v !== null && typeof v === "object" && (v as Obj)["isRepeatingTemplate"] === true;
}

/**
 * Flatten ONE container ref `o[key]` from a `{uuid,title}` object to its bare
 * TITLE string, adding a flat sibling `o[uuidKey]` = the full uuid ONLY when the
 * round-trip law demands it: `forceUuid` (the FULL/detail tier — uuid siblings
 * unconditional) OR the bare title does not resolve back to this exact entity
 * (`!promoter.roundTrips`). A null/absent ref, or one already flattened to a
 * string, is left untouched. The container's `isRepeatingTemplate` marker (a
 * TTY-render disambiguator on the internal entity) does not survive the flatten
 * — the human render reads the unshaped entity. {@link shapeItem} re-emits that
 * fact for the JSON container PROJECT as the flat presence-keyed sibling
 * `projectIsTemplate: true` BEFORE this flatten runs.
 */
function flattenRef(
  o: Obj,
  key: string,
  uuidKey: string,
  kind: RefKind,
  forceUuid: boolean,
  promoter: RefPromoter,
  projectUuid?: string,
): void {
  const ref = o[key];
  if (ref === null || typeof ref !== "object") return; // absent, or already a bare string
  const r = ref as Obj;
  const uuid = typeof r["uuid"] === "string" ? (r["uuid"] as string) : "";
  const title = typeof r["title"] === "string" ? (r["title"] as string) : "";
  o[key] = title;
  if (forceUuid || !promoter.roundTrips(kind, title, uuid, projectUuid)) o[uuidKey] = uuid;
}

/** What a given view context drops from an item: redundant ancestry + R10 bucket/marker implications. */
interface ItemDrop {
  project?: boolean;
  area?: boolean;
  heading?: boolean;
  /**
   * KEEP + flatten the `heading` ref even in the COMPACT tier (which otherwise
   * drops it everywhere). Set for the project-view LOGBOOK rows, whose GUI hint
   * IS the heading (a swept child of an OPEN heading labels its heading, the
   * two-view asymmetry — the global Logbook labels the PROJECT instead).
   */
  keepHeading?: boolean;
  /** Drop the `stage` field — the enclosing view/section states it. */
  stage?: boolean;
  /** Drop the derived `when` field — the today view's section key states it (R12). */
  when?: boolean;
}

/**
 * Fold the flat `tags` / `inheritedTags` arrays of `{title}` objects into plain
 * arrays of tag NAMES (universal across tiers and kinds). Tag uuids were never
 * on the wire; the title is the identity. A missing key is left missing; an
 * empty array stays `[]` (omit-empty prunes it later).
 */
function flattenTags(o: Obj): void {
  for (const key of ["tags", "inheritedTags"]) {
    const v = o[key];
    if (!Array.isArray(v)) continue;
    o[key] = v.map((t) =>
      t !== null && typeof t === "object" && "title" in (t as Obj) ? (t as Obj)["title"] : t,
    );
  }
}

/**
 * Reshape the flat checklist counts (and, on a `detail` read, the items array)
 * into ONE presence-keyed `checklist` object — universal across tiers and kinds.
 * No checklist → the `checklist` key is absent entirely; otherwise
 * `{open, total}`, plus `items` when the source carried them (detail reads).
 */
function reshapeChecklist(o: Obj): void {
  const total =
    typeof o["checklistItemsCount"] === "number" ? (o["checklistItemsCount"] as number) : 0;
  const open =
    typeof o["openChecklistItemsCount"] === "number" ? (o["openChecklistItemsCount"] as number) : 0;
  const items = o["checklist"]; // ChecklistItem[] on a detail read; absent on list rows
  delete o["checklistItemsCount"];
  delete o["openChecklistItemsCount"];
  delete o["checklist"];
  const hasItems = Array.isArray(items) && items.length > 0;
  if (total === 0 && !hasItems) return; // no checklist → omit the key
  const cl: Obj = { open, total };
  if (Array.isArray(items)) cl["items"] = items;
  o["checklist"] = cl;
}

/**
 * Reshape a project's flat leaf-action counts into ONE presence-keyed `todos`
 * object — universal across tiers and kinds, mirroring {@link reshapeChecklist}.
 * The source columns are the app-maintained materialized child counts
 * (`untrashedLeafActionsCount` / `openUntrashedLeafActionsCount`), which count
 * to-do children only (headings and checklist items excluded by construction).
 * No to-do children (total 0) → the `todos` key is absent entirely; otherwise
 * `{open, total}`. A no-op on to-dos (they carry no such columns).
 */
function reshapeTodos(o: Obj): void {
  const total =
    typeof o["untrashedLeafActionsCount"] === "number"
      ? (o["untrashedLeafActionsCount"] as number)
      : 0;
  const open =
    typeof o["openUntrashedLeafActionsCount"] === "number"
      ? (o["openUntrashedLeafActionsCount"] as number)
      : 0;
  delete o["untrashedLeafActionsCount"];
  delete o["openUntrashedLeafActionsCount"];
  if (total === 0) return; // presence-keyed: no to-do children → omit the key
  o["todos"] = { open, total };
}

/**
 * R11 — rewrite the internal `repeating` block into the wire's template/instance
 * split, mutating `o` in place. The internal entity carries the full
 * RepeatingInfo (`isTemplate`/`isInstance`/`templateUuid`/…); the wire loses the
 * `isTemplate`/`isInstance` discriminators entirely and instead lets KEY
 * PRESENCE carry the fact:
 *
 * - **Template** (`isTemplate`) → a nested `repeating` object — the series state
 *   `{paused?, deadlined?, rule?, latestInstance?}`. Presence of `repeating` MEANS
 *   template (an unadorned template emits `repeating: {}` — a bare `{}` is NOT
 *   pruned by omit-empty, so the presence signal survives). The inner false
 *   booleans are default-pruned (presence-keyed). The forward pointer
 *   `nextOccurrence` moved OUT to the top-level `when` (R12 — a template's
 *   projected date IS its time position); `rule` and `latestInstance` stay
 *   detail-only (populated by src/read/detail.ts on `entity.repeating`);
 *   `latestInstance` is the backward pointer symmetric to `when`.
 * - **Instance** (`isInstance`) → a flat presence-keyed `instanceOf:
 *   <templateUuid>` (the instance marker + the write handle) and, on a DETAIL
 *   read, a sibling `repeats` object — the template's repeat CONTEXT joined onto
 *   the instance (`{rule?, next?, paused?}`), the GUI's lower-corner "Repeats on
 *   Aug 19" / "Repeats 1 day after completion" caption. `rule` is the SAME decoded
 *   shape a template card emits under `repeating.rule` (one recurrence vocabulary
 *   on the wire); `next` is the template's projected next occurrence, FIXED mode
 *   ONLY (absent for after-completion — no successor date exists yet); `paused`
 *   surfaces the template's paused flag. Populated by src/read/detail.ts's mirror
 *   join; absent when the template is unresolvable (dangling FK) or carries no
 *   caption. NO `repeating` object on an instance.
 * - **Plain** (neither) → neither key.
 */
function reshapeRepeatingWire(o: Obj): void {
  const rep = o["repeating"];
  delete o["repeating"];
  if (rep === null || typeof rep !== "object") return;
  const r = rep as Obj;
  if (r["isTemplate"] === true) {
    const out: Obj = {}; // presence MEANS template — a bare {} survives omit-empty
    if (r["paused"] === true) out["paused"] = true;
    if (r["deadlined"] === true) out["deadlined"] = true;
    if (r["rule"] != null) out["rule"] = r["rule"]; // detail read only
    // The SL1 "Show Latest" pick — detail-only; the backward pointer symmetric to
    // the top-level `when` (the forward pointer, R12).
    if (typeof r["latestInstance"] === "string") out["latestInstance"] = r["latestInstance"];
    o["repeating"] = out;
  } else if (r["isInstance"] === true) {
    if (typeof r["templateUuid"] === "string") o["instanceOf"] = r["templateUuid"];
    // The instance's TEMPLATE context (detail-only mirror join). Presence-keyed:
    // the whole `repeats` object is omitted unless it carries at least one fact.
    const ctx = r["repeats"];
    if (ctx !== null && typeof ctx === "object") {
      const c = ctx as Obj;
      const out: Obj = {};
      if (c["rule"] != null) out["rule"] = c["rule"]; // same shape as a template card's `repeating.rule`
      if (typeof c["next"] === "string") out["next"] = c["next"]; // FIXED mode only
      if (c["paused"] === true) out["paused"] = true;
      if (Object.keys(out).length > 0) o["repeats"] = out;
    }
  }
}

/** The R10 stage input read straight off a materialized task entity's `derived` bag. */
function stageOf(s: Obj): ReturnType<typeof deriveStage> {
  const repeating = s["repeating"];
  const isTemplate =
    repeating !== null &&
    typeof repeating === "object" &&
    (repeating as Obj)["isTemplate"] === true;
  const d = (s["derived"] ?? {}) as Obj;
  return deriveStage({
    trashed: d["trashed"] === true,
    logged: d["logged"] === true,
    start: d["start"] as "inbox" | "active" | "someday",
    startDate: (s["startDate"] as string | null) ?? null,
    repeating: { isTemplate },
    // The presence-keyed Today marker (stamped at materialize with the response
    // clock) discriminates an ARRIVED dated row (→ anytime) from a strictly-
    // future one (→ upcoming). Read from the `derived` substrate bag.
    today: d["today"] === true,
  });
}

/** The R12 `when` input read straight off a materialized task entity (given its stage). */
function whenOf(s: Obj, stage: Stage): ReturnType<typeof deriveWhen> {
  const repeating = s["repeating"];
  const isTemplate =
    repeating !== null &&
    typeof repeating === "object" &&
    (repeating as Obj)["isTemplate"] === true;
  const nextOccurrence =
    isTemplate && typeof (repeating as Obj)["nextOccurrence"] === "string"
      ? ((repeating as Obj)["nextOccurrence"] as string)
      : null;
  const d = (s["derived"] ?? {}) as Obj;
  return deriveWhen({
    stage,
    // The SAME presence-keyed markers stageOf reads — never re-derived, so a
    // `when` of today/evening can never disagree with Today-view membership.
    today: d["today"] === true,
    evening: d["evening"] === true,
    startDate: (s["startDate"] as string | null) ?? null,
    repeating: { isTemplate, nextOccurrence },
  });
}

/**
 * Shape ONE task entity (to-do or project): the universal reshapes, the R10/R12
 * stage/`when` rewrite, then the R6 ancestry drops, then — when `compact` — the
 * R7 default-pruning. A shallow copy is taken so unknown sibling keys
 * (`changeKind` on a changes row, `match` on a search hit) pass through
 * untouched. Non-task values (areas, tags, refs, headings) are returned as-is.
 */
function shapeItem(src: unknown, drop: ItemDrop, compact: boolean, promoter: RefPromoter): unknown {
  if (src === null || typeof src !== "object") return src;
  const s = src as Obj;
  const type = s["type"];
  if (type !== "to-do" && type !== "project") return src; // not a shaped entity
  const stage = stageOf(s); // from the ORIGINAL fields, before any reshape
  const when = whenOf(s, stage); // R12 — derived from the same fields + markers
  // R13 (BANNER1 law L-B): a Today member is PROVISIONAL — the GUI pips it and
  // counts it in the "You have N new to-dos" banner — until the app MATERIALIZES
  // it (start:=1, startDate:=today). Presence-keyed marker, derived from the SAME
  // inputs as the stage/`when` axes (never an independent re-derivation): the row
  // is a Today member (via the today/evening markers `whenOf` reuses — so it can
  // never disagree with the star) AND not yet materialized (BANNER1 L1:
  // `start != active OR startDate IS NULL`). Templates are never Today members,
  // so they never mark. NEVER dropped by any view/section — the banner is not a
  // section, so no enclosing node implies it. The app rewrites start/startDate
  // when the user acknowledges the banner; that is a GUI-only side effect our
  // read cannot clear (watchers beware — see contract.md `provisional`).
  const provisional = whenIsProvisional(
    when,
    ((s["derived"] ?? {}) as Obj)["start"] as StartState,
    (s["startDate"] as string | null) ?? null,
  );
  const o: Obj = { ...s };

  // R9 universal reshapes (every tier, every kind incl. detail).
  reshapeChecklist(o);
  reshapeTodos(o);
  flattenTags(o);
  reshapeRepeatingWire(o);
  if (o["project"] == null && o["headingProject"] != null) o["project"] = o["headingProject"];
  delete o["headingProject"];

  // The ENTIRE internal derivation substrate leaves the wire in ONE structural
  // drop (one-vocabulary Batch 2, Option B): `start`/`logged`/`trashed` (R10 —
  // replaced by `stage`), `today`/`evening` (R12 — replaced by `when`), and the
  // raw `reminder` byte all live in the nested `o.derived` bag. §9n: the
  // top-level consumer `reminder` is ALREADY the live-gated value (null once the
  // byte is presentation-dead — its `startDate` gone strictly past), gated at the
  // mapper; a null key is pruned by omit-empty, so a stale reminder never reaches
  // the wire without any drop here. `stage`/`when`/`provisional` are then stamped
  // from the derivations above.
  delete o["derived"];
  if (drop.stage !== true) o["stage"] = stage;
  // R12 — `when` is emitted unless the enclosing context provably states the
  // position (the today view's sections; a card date-group in rebucketChildren).
  if (drop.when !== true && when !== undefined) o["when"] = when;
  // R13 — the provisional banner marker (never dropped; presence-keyed).
  if (provisional) o["provisional"] = true;

  // The owning project's uuid scopes the heading round-trip (headings resolve
  // within their project). Captured BEFORE the R6 project-drop so a project-view
  // LOGBOOK row — whose `project` is dropped as redundant, yet which KEEPS its
  // heading ref (drop.keepHeading) — can still promote its `headingUuid` in the
  // project's scope.
  const projectUuid = refUuid(o["project"]);

  // R6 — drop redundant ancestry (both tiers).
  if (drop.project === true) delete o["project"];
  if (drop.area === true) delete o["area"];
  if (drop.heading === true) delete o["heading"];

  // Absent `type` = to-do — omit it on to-do rows (project/heading keep theirs).
  if (o["type"] === "to-do") delete o["type"];

  // Flatten the surviving container refs to bare TITLE strings, adding a flat
  // `*Uuid` sibling per the round-trip law (FULL tier: unconditional; compact:
  // only when the title would not resolve back to this entity). The `heading`
  // ref is compact-dropped below (except drop.keepHeading), so it is flattened
  // on the FULL tier OR when a logbook row explicitly keeps it.
  const forceUuid = !compact;
  // The container PROJECT's repeating-TEMPLATE fact — the JSON twin of the TTY ↻
  // glyph (src/cli/render.ts). flattenRef discards the internal ref's
  // `isRepeatingTemplate` marker, so re-emit it here as a flat presence-keyed
  // sibling of the `project` ref (never `false`), riding wherever `project`
  // rides. A heading-nested row already merged its owning project into `project`
  // above, so direct AND headed template children mark; the R6 project-drop
  // above already removed `project` where the view implies it, so a project-view
  // child carries no orphaned marker. Both tiers — it is a correctness signal,
  // not detail. Only project refs ever carry the flag (area/heading never do).
  if (refIsTemplate(o["project"])) o["projectIsTemplate"] = true;
  flattenRef(o, "project", "projectUuid", "project", forceUuid, promoter);
  flattenRef(o, "area", "areaUuid", "area", forceUuid, promoter);
  if (!compact || drop.keepHeading === true)
    flattenRef(o, "heading", "headingUuid", "heading", forceUuid, promoter, projectUuid);

  // R12 — FULL/DETAIL keep the raw `startDate` beside `when` as the SUBSTRATE
  // (`startDate` = what is stored, `when` = where it sits). COMPACT drops it below
  // (the position `when` carries is what a list needs).
  if (!compact) return o;

  // R7 compact — default-pruning (absence = the default).
  delete o["startDate"]; // R12 — position lives in `when`; substrate is full-tier only
  if (o["status"] === "open") delete o["status"];
  delete o["created"];
  delete o["modified"];
  const notes = typeof o["notes"] === "string" ? (o["notes"] as string) : "";
  delete o["notes"];
  if (notes !== "") o["hasNotes"] = true;
  // The heading ref is compact-dropped everywhere (the GUI shows the project,
  // never the heading, outside a project view). Full tier / detail keep it; a
  // project-view logbook row (drop.keepHeading) keeps it too — flattened above.
  if (drop.keepHeading !== true) delete o["heading"];
  return o;
}

/** Map a plain array of items with the item shaper. */
function shapeList(
  items: unknown,
  drop: ItemDrop,
  compact: boolean,
  promoter: RefPromoter,
): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((i) => shapeItem(i, drop, compact, promoter));
}

/** Copy `base` and overwrite `items` with the shaped list (avoids spread-in-map). */
function withShapedItems(base: Obj, drop: ItemDrop, compact: boolean, promoter: RefPromoter): Obj {
  const out: Obj = { ...base };
  out["items"] = shapeList(base["items"], drop, compact, promoter);
  return out;
}

/** A child entity carrying the fields the R10 re-bucketer needs. */
interface Child extends Obj {
  startDate?: string | null;
  todayIndex?: number;
}

/** An IsoDate group on the wire — `when` is a real string, or `null` for the resting-templates group. */
interface WireDateGroup {
  when: string | null;
  items: unknown[];
}

/**
 * Re-bucket a project's / area's / heading's live (non-logbook/trash) children
 * into the R10 card shape by their derived {@link deriveStage} — so the bucket an
 * item lands in ALWAYS equals its `stage`:
 * - `anytime` — stage anytime, in encounter order;
 * - `upcoming` — stage upcoming, day-grouped `[{when, items}]` (a dated row under
 *   its `startDate`, a template under its `nextOccurrence`), date ASC; date-LESS
 *   templates (after-completion / paused) form a trailing `{when: null, items}`
 *   group (explicit null per the `area: null` section precedent);
 * - `someday` — stage someday.
 * Items are already in view order (index / date+todayIndex) from the read layer,
 * so encounter order within a date group preserves that ordering. Each item is
 * then run through {@link shapeItem} with the section drop (ancestry + `stage`,
 * since the bucket states it).
 */
function rebucketChildren(
  children: unknown[],
  drop: ItemDrop,
  compact: boolean,
  promoter: RefPromoter,
): { anytime: unknown[]; upcoming: WireDateGroup[]; someday: unknown[] } {
  const anytime: unknown[] = [];
  const someday: unknown[] = [];
  const datedByKey = new Map<string, unknown[]>();
  const datedOrder: string[] = [];
  const restingTemplates: unknown[] = [];
  const shape = (c: unknown) => shapeItem(c, drop, compact, promoter);
  for (const raw of children) {
    if (raw === null || typeof raw !== "object") continue;
    const c = raw as Child;
    const stage = stageOf(c);
    if (stage === "anytime") {
      anytime.push(shape(c));
    } else if (stage === "someday") {
      someday.push(shape(c));
    } else if (stage === "upcoming") {
      const repeating = c["repeating"] as Obj | undefined;
      const nextOcc =
        repeating != null && typeof repeating === "object"
          ? ((repeating["nextOccurrence"] as string | null | undefined) ?? null)
          : null;
      const date = (c.startDate ?? null) !== null ? c.startDate! : nextOcc;
      if (date === null) {
        restingTemplates.push(shape(c));
      } else {
        if (!datedByKey.has(date)) {
          datedByKey.set(date, []);
          datedOrder.push(date);
        }
        // R12 — inside a date-group the group states the date, so a member whose
        // `when` equals it drops it (every scheduled row and every projected
        // template does — that IS the group key).
        const shaped = shape(c);
        if (shaped !== null && typeof shaped === "object" && (shaped as Obj)["when"] === date) {
          delete (shaped as Obj)["when"];
        }
        datedByKey.get(date)!.push(shaped);
      }
    } else {
      // inbox / logbook / trash should not appear among a card's live children;
      // route defensively to anytime rather than drop the row.
      anytime.push(shape(c));
    }
  }
  const upcoming: WireDateGroup[] = datedOrder
    .toSorted((a, b) => a.localeCompare(b))
    .map((date) => ({ when: date, items: datedByKey.get(date)! }));
  if (restingTemplates.length > 0) upcoming.push({ when: null, items: restingTemplates });
  return { anytime, upcoming, someday };
}

/** Flatten an internal IsoDateGroup[] (`[{when, items}]`) to its items, in order. */
function flattenGroups(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    if (g !== null && typeof g === "object" && Array.isArray((g as Obj)["items"])) {
      out.push(...((g as Obj)["items"] as unknown[]));
    }
  }
  return out;
}

/** Coerce an unknown value to an array (empty when absent). */
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The R6 ref drop for the un-headed BODY's four `children` bucket records (v2):
 * every body child drops project/area (the card states them), the bucket-implied
 * stage (each of `anytime`/`upcoming`/`someday`/`logbook` is stage-pure), and the
 * heading ref — a body child is by construction un-headed (its `heading` is null),
 * and a project view surfaces no bare `heading: null` (drop it explicitly rather
 * than leaning on omit-empty).
 */
const PROJECT_CHILD_DROP: ItemDrop = { project: true, area: true, heading: true, stage: true };
/**
 * The R6 ref drop for a HEADING's four `children` bucket records (v2): a headed
 * child drops project/area (the card states them), the heading ref (its position
 * UNDER `headings[].children` states membership — structural, #362 / task item 6),
 * and the bucket-implied stage. Applied uniformly to the heading's live buckets
 * AND its `logbook` — the logbook is stage-pure (all logged), so stage drops too.
 */
const HEADING_MEMBER_DROP: ItemDrop = { project: true, area: true, heading: true, stage: true };
/** Area-view child-item buckets drop their area (the card states it) + the bucket-implied stage. */
const AREA_CHILD_DROP: ItemDrop = { area: true, stage: true };
/** Area-view PROJECTS list: a mixed listing of the area's project rows — keep `stage`, drop area. */
const AREA_PROJECTS_DROP: ItemDrop = { area: true };
/**
 * Anytime sidebar-section items: stage-PURE → drop area + the section-implied
 * stage (R10.2). Every Anytime-view member derives `anytime`: ANYTIME_SELF
 * (undated-active, arrived-active, arrived someday-scheduled) — an ARRIVED dated
 * row is Anytime, not Upcoming (Upcoming is STRICTLY FUTURE, UPC1) — AND, since
 * R13, the DEADLINE-PULLED undated Inbox/Someday rows the view now includes
 * (BANNER1b), which derive `anytime` too (deriveStage step 2½: a Today-marked
 * undated row is a pull → anytime). Repeating templates are excluded from the
 * view (NOT_TEMPLATE), so no stage-`upcoming` row can appear here — still pure.
 */
const ANYTIME_SECTION_DROP: ItemDrop = { area: true, stage: true };
/** Someday sidebar-section items: stage-PURE → drop area + the bucket-implied stage. */
const SOMEDAY_SECTION_DROP: ItemDrop = { area: true, stage: true };
/** The card NODE / detail / mixed lists: keep every ref, `stage`, and `when`. */
const NO_DROP: ItemDrop = {};
/**
 * The today view's two `children` bucket records: drop the key-implied `when`
 * (R12 — the `today`/`evening` bucket key states it) AND the bucket-implied
 * `stage` (R13). Every Today member now derives stage `anytime` by construction —
 * an ARRIVED `startDate` (step 5) or a DEADLINE PULL (step 2½) both derive
 * `anytime`, and there are no future-dated or undated-someday Today members — so
 * both buckets are provably stage-PURE `anytime` and the field is redundant there
 * (verified strict by the today purity property test in test/unit/stage.test.ts).
 * `provisional` is NOT a drop — the banner is not a bucket, so nothing implies it.
 */
const TODAY_SECTION_DROP: ItemDrop = { when: true, stage: true };

/**
 * Shape a heading GROUP node (the `headings[].heading` / `loggedHeadings[].heading`
 * keyed sub-object). The type is triply implied by position, and a heading has no
 * open/canceled/completed vocabulary the reader needs — so:
 * - DROP `type` (positional: this slot is always a heading; the "absent type =
 *   to-do" convention is scoped to ROWS/candidates, never this keyed sub-object);
 * - DROP `project` (the card states it);
 * - REPLACE `status` with the presence-keyed `archived` (the stopDate, an ISO
 *   date-time following the `stopped`/logged-row convention) — emitted ONLY when
 *   the heading is archived (status "completed"), OMITTED when open. Region
 *   membership (live `headings` vs the logged region) expresses sweep state; the
 *   node carries only whether-and-when it was archived.
 */
function shapeHeadingNode(src: unknown): unknown {
  if (src === null || typeof src !== "object") return src;
  const h = { ...(src as Obj) };
  delete h["project"];
  delete h["type"];
  const isArchived = h["status"] !== undefined && h["status"] !== "open";
  const stopped = h["stopped"];
  delete h["status"];
  delete h["stopped"];
  // Presence-keyed `archived` — the ISO archive timestamp (past-participle twin of
  // `stopped`/`created`/`modified`), full-datetime serialization like `stopped`.
  if (isArchived && stopped != null) h["archived"] = stopped;
  return h;
}

/** A bucket record `{items, total?}` (v2 R1): `total` present IFF the bucket was capped. */
export function bucketRecord(items: unknown[], total?: number): Obj {
  return total !== undefined && items.length < total ? { items, total } : { items };
}

/** The `stopped` epoch of an internal entity (a Date pre-shaping), or 0 — for logbook DESC ordering. */
function stoppedMs(o: Obj): number {
  const s = o["stopped"];
  return s instanceof Date ? s.getTime() : 0;
}

/**
 * Build ONE container's four v2 `children` bucket records (PR 2) from its flat
 * child set (live AND logged alike). Every child is routed by DERIVED STAGE, so
 * one entity lands in exactly one place (R5/#V12):
 * - `logbook: {items, total?}` — the swept/resolved children (`logged` flag),
 *   most-recently-completed first (`stopped` DESC — the certified HEADARC3/logbook
 *   ordering), stage-pure so `stage` drops;
 * - `anytime` / `someday: {items, total?}` — stage-pure records;
 * - `upcoming: [{when, items, total?} …]` — the day-block ARRAY (R3): dated blocks
 *   chronological, then a single trailing `{when: null, items}` resting block for
 *   date-less recurring templates (#V8). An open child stranded under an archived
 *   heading (HEADARC2-C anomaly) is NOT logged, so it rides `anytime` here — its
 *   presence in a live bucket under an `archived` heading node is self-evident.
 * `drop` carries the container's ancestry drops (body vs heading); the day-block
 * key is `when` end-to-end (`rebucketChildren` builds it — no rename) — `null` for
 * the resting block. No bucket is capped in the project view today, so every
 * `total` is absent (R1: an untruncated bucket never restates its length); the
 * `total?` argument keeps the record + day-block shape ready for PR 5's sweep and
 * is exercised by the unit tests.
 */
function shapeContainerChildren(
  children: unknown,
  drop: ItemDrop,
  compact: boolean,
  promoter: RefPromoter,
): Obj {
  const live: unknown[] = [];
  const logged: Obj[] = [];
  for (const c of asArray(children)) {
    // The logbook-boundary flag lives on the internal `derived` substrate bag.
    const isLogged =
      c !== null &&
      typeof c === "object" &&
      ((c as Obj)["derived"] as Obj | undefined)?.["logged"] === true;
    if (isLogged) logged.push(c as Obj);
    else live.push(c);
  }
  const { anytime, upcoming, someday } = rebucketChildren(live, drop, compact, promoter);
  const loggedSorted = logged.toSorted((a, b) => stoppedMs(b) - stoppedMs(a));
  const logbook = shapeList(loggedSorted, drop, compact, promoter) as unknown[];
  return {
    anytime: bucketRecord(anytime),
    // The day-block ARRAY (`{when, items}`, `when: null` the resting block #V8);
    // `rebucketChildren` already keys each block by `when`.
    upcoming,
    someday: bucketRecord(someday),
    logbook: bucketRecord(logbook),
  };
}

/**
 * Shape a project view into the read-shape v2 wire (PR 2):
 * `{ project, children, headings[] }` — NOTHING else at this level. `children` is
 * the un-headed BODY's four stage-keyed bucket records; `headings[]` is EVERY
 * heading (index order, all lifecycle classes — R5) as `{uuid, title, archived?,
 * children}` with the SAME recursive `children` shape. The per-container `logbook`
 * lives inside each `children` (R6, no root logbook); the v1-era `logbookHeadings`
 * and BOTH advisory keys (`openChildrenWhileResolved` /
 * `openChildrenUnderArchivedHeading`) are DELETED (#V12) — anomalous open children
 * seat in the normal recursive buckets, the heading's `archived` mark making the
 * anomaly self-evident. The card node keeps everything (children derive their
 * container from it). `out` is built fresh, so no render-only field leaks.
 */
function shapeProjectView(view: Obj, compact: boolean, promoter: RefPromoter): Obj {
  const headingContainers = asArray(view["headingContainers"]).map((c) => {
    const grp = (c ?? {}) as Obj;
    // The heading NODE (`{uuid, title, archived?}`) gains the recursive `children`
    // (last key, so it reads after the identity). Object.assign mutates the fresh
    // node copy shapeHeadingNode already returns — no spread-in-map.
    const node = shapeHeadingNode(grp["heading"]) as Obj;
    return Object.assign(node, {
      children: shapeContainerChildren(grp["children"], HEADING_MEMBER_DROP, compact, promoter),
    });
  });
  return {
    // The card NODE keeps everything but is still an item DTO (universal + R10 reshapes).
    project: shapeItem(view["project"], NO_DROP, false, promoter),
    children: shapeContainerChildren(view["bodyChildren"], PROJECT_CHILD_DROP, compact, promoter),
    headings: headingContainers,
  };
}

/**
 * Build an area's THREE v2 `children` bucket records (PR 3) from its flat direct
 * to-do set (live only — an area has NO logged-children region, so no `logbook`
 * key; the area logbook is the bounded query `things logbook --area <ref>`, #346).
 * The same stage-derived bucketing as {@link shapeContainerChildren} minus the
 * logbook split: `anytime`/`someday` are `{items, total?}` records, `upcoming` is
 * the day-block ARRAY (R3, keyed by `when`) with the trailing `{when: null, items}`
 * resting block for date-less recurring templates (#V8). Inline `total` is stamped
 * downstream by {@link withAreaBucketTotals} (only `anytime` can be capped — the
 * `--area-limit` scope; the scheduled/someday direct to-dos always survive).
 */
function shapeAreaChildren(
  members: unknown[],
  drop: ItemDrop,
  compact: boolean,
  promoter: RefPromoter,
): Obj {
  const { anytime, upcoming, someday } = rebucketChildren(members, drop, compact, promoter);
  return {
    anytime: bucketRecord(anytime),
    // The day-block ARRAY (`{when, items}`, `when: null` the resting block #V8);
    // `rebucketChildren` already keys each block by `when`.
    upcoming,
    someday: bucketRecord(someday),
  };
}

/**
 * Shape an area view into the read-shape v2 wire (PR 3):
 * `{ area | null, children, projects }` — NOTHING else at this level. `children`
 * is the area's direct to-dos as three stage-keyed bucket records (`anytime`,
 * `upcoming[]`, `someday` — NO `logbook`, #346); `projects` is the child-project
 * sidebar-rank scope as a bucket record `{items, total?}` — a mixed-stage listing
 * that KEEPS `stage`/`when` (the someday-projects / active split is TTY-only). The
 * loose pseudo-area keeps `area: null`. The area node keeps its identity (tags
 * folded to names); each direct-to-do row drops `area` (the node states it) + the
 * bucket-implied `stage`. Inline `total` (present iff a scope was capped, R1) is
 * injected downstream by {@link withAreaBucketTotals}, where the pre-cap sizes are
 * known. `out` is built fresh, so no render-only field leaks.
 */
function shapeAreaView(view: Obj, compact: boolean, promoter: RefPromoter): Obj {
  const looseMembers = [
    ...asArray(view["active"]),
    ...flattenGroups(view["scheduled"]),
    ...asArray(view["someday"]),
    ...asArray(view["repeating"]),
  ];
  return {
    // The area NODE, or `null` for the loose pseudo-area (shapeArea passes null).
    area: shapeArea(view["area"]),
    children: shapeAreaChildren(looseMembers, AREA_CHILD_DROP, compact, promoter),
    // The projects list is a mixed listing of the area's project rows — keep stage.
    projects: bucketRecord(
      shapeList(view["projects"], AREA_PROJECTS_DROP, compact, promoter) as unknown[],
    ),
  };
}

/**
 * Inject the area view's inline scope `total`s (read-shape v2 R1, PR 3): present
 * iff the scope was capped (`items.length < total`), absent otherwise — no
 * `meta.truncation.blocks[]` sidecar. `children.anytime` carries the direct-to-dos
 * (`--area-limit`) total; `projects` carries the project-rows (`--project-limit`)
 * total. The scheduled/someday direct-to-do blocks and the scheduled/someday
 * project rows are never capped, so they never gain a `total`. Both the CLI `view`
 * wrapper and the MCP data block run the shaped view through this so completeness
 * is answerable locally. Returns the view unchanged when it is not the expected
 * shape.
 */
export function withAreaBucketTotals(view: unknown, totals: AreaBucketTotals): unknown {
  if (view === null || typeof view !== "object") return view;
  const v = view as Obj;
  const children = v["children"];
  const withChildTotals =
    children !== null && typeof children === "object"
      ? {
          ...(children as Obj),
          anytime: withBucketTotal((children as Obj)["anytime"], totals.anytime),
        }
      : children;
  // Spread-then-override keeps the `area` / `children` / `projects` key order.
  return {
    ...v,
    children: withChildTotals,
    projects: withBucketTotal(v["projects"], totals.projects),
  };
}

/**
 * The global `upcoming` view's DAY-BLOCK key for one raw item (read-shape v2 PR 4):
 * its `startDate` when scheduled; else, for a NON-template, its `deadline` (a
 * deadline-forecast row appears at its due day — cohort 2, UPC1); else `null` —
 * a date-LESS recurring template rides the trailing resting block (#V8). This is
 * the emit-boundary twin of the renderer's `groupDate` (src/cli/render.ts) and of
 * {@link upcomingBlockTotals} (the pre-cap sizer), so the wire's day blocks match
 * the TTY grouping row-for-row and each block's inline `total` lines up with its
 * scope. The library keeps its own day grouping; only the wire reshapes here.
 */
function upcomingBlockKey(o: Obj): string | null {
  const startDate = (o["startDate"] as string | null) ?? null;
  if (startDate !== null) return startDate;
  const repeating = o["repeating"];
  const isTemplate =
    repeating !== null &&
    typeof repeating === "object" &&
    (repeating as Obj)["isTemplate"] === true;
  if (isTemplate) return null; // a date-less template → the resting block (#V8)
  return (o["deadline"] as string | null) ?? null; // a forecast row appears at its deadline
}

/**
 * Reshape the global `upcoming` view into the read-shape v2 day-block sections
 * (PR 4): `[{ when, items, total? } …]` — chronological dated blocks keyed by
 * {@link upcomingBlockKey} (each the COMPLETE global day scope, its `when` doubling
 * as the `--in <when>` reorder token), then ONE trailing `{ when: null, items }`
 * block holding the date-less resting recurring templates (#V8) when any exist.
 * The incoming stream is already day-ordered (COALESCE(startDate, deadline) ASC,
 * then the UI's within-day drag order), so encounter order preserves both the
 * block chronology and the within-block order — no re-sort, matching the renderer.
 * Rows KEEP `stage` (the view is projection-side stage-MIXED, R7: future-dated
 * `upcoming` rows beside deadline-forecast `anytime`/`someday` ones) and drop
 * `when` only when it equals the block's date (the block states it — the same rule
 * {@link rebucketChildren} applies to a container day block); a forecast row's
 * `when` is absent already, and a divergent projected `when` (horizon > 1) is kept.
 * Every row keeps its container refs (a global mixed view — NO_DROP). Inline
 * `total` is stamped downstream by {@link withUpcomingBlockTotals}.
 */
function shapeUpcomingView(items: unknown[], compact: boolean, promoter: RefPromoter): Obj[] {
  const datedByKey = new Map<string, unknown[]>();
  const datedOrder: string[] = [];
  const resting: unknown[] = [];
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue;
    const key = upcomingBlockKey(raw as Obj);
    const shaped = shapeItem(raw, NO_DROP, compact, promoter);
    if (key === null) {
      resting.push(shaped);
      continue;
    }
    if (!datedByKey.has(key)) {
      datedByKey.set(key, []);
      datedOrder.push(key);
    }
    // R12 — inside a dated block the block states the date, so a member whose
    // `when` equals it drops it (a scheduled row's when IS the key). A forecast
    // row has no `when`; a horizon-projected row whose `when` diverges keeps it.
    if (shaped !== null && typeof shaped === "object" && (shaped as Obj)["when"] === key) {
      delete (shaped as Obj)["when"];
    }
    datedByKey.get(key)!.push(shaped);
  }
  const sections: Obj[] = datedOrder.map((when) => ({ when, items: datedByKey.get(when)! }));
  if (resting.length > 0) sections.push({ when: null, items: resting });
  return sections;
}

/**
 * Inject each global-`upcoming` day block's inline `total` (read-shape v2 R1,
 * PR 4): present iff that day's scope was capped by the flat row limit
 * (`items.length < total`), absent otherwise — no `meta.truncation.blocks[]`
 * sidecar (the whole-view `{shown,total,limit,truncated}` rollup still rides
 * `meta.truncation` for the row hint). The flat cut across the day-ordered stream
 * leaves at most ONE straddling block partial (its pre-cap size looked up by
 * `when` from `totals`); blocks fully before the cut are complete (no `total`),
 * and blocks fully past it never appear. The resting block keys on `null`. Both
 * the CLI `sections` wrapper and the MCP data block run the shaped sections
 * through this so completeness is answerable locally. Returns the input unchanged
 * when it is not the expected sections array.
 */
export function withUpcomingBlockTotals(sections: unknown, totals: UpcomingBlockTotals): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((s) => {
    if (s === null || typeof s !== "object") return s;
    const sec = s as Obj;
    const when = (sec["when"] ?? null) as string | null;
    const total = totals.get(when);
    const items = sec["items"];
    const shown = Array.isArray(items) ? items.length : 0;
    // Spread-then-add keeps the `when` / `items` / `total` key order.
    return total !== undefined && shown < total ? { ...sec, total } : sec;
  });
}

/**
 * Inject each global anytime/someday section's inline `total` (read-shape v2 R1,
 * PR 5): present iff that section's `items` were capped (`items.length < total`),
 * absent otherwise — an untruncated section never restates its own length, and
 * the pre-v2 `meta.truncation.blocks[]` descriptor-join sidecar is RETIRED. The
 * pre-cap section sizes come from {@link previewSections}/{@link
 * previewSomedaySections} keyed by area uuid (`null` for the loose section); the
 * per-block "… N more" render detail is carried separately (internal
 * {@link GroupBlock}[]), never on the wire. Both the CLI `sections` wrapper and
 * the MCP data block run the shaped sections through this so completeness is
 * answerable locally. Returns the input unchanged when it is not the expected
 * sections array.
 */
export function withSectionTotals(sections: unknown, totals: SectionTotals): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((s) => {
    if (s === null || typeof s !== "object") return s;
    const sec = s as Obj;
    const area = sec["area"];
    const key =
      area !== null && typeof area === "object" ? ((area as Obj)["uuid"] as string) : null;
    const total = totals.get(key);
    const items = sec["items"];
    const shown = Array.isArray(items) ? items.length : 0;
    // Spread-then-add keeps the `area` / `items` / `total` key order.
    return total !== undefined && shown < total ? { ...sec, total } : sec;
  });
}

/** Fold an area entity's tags to string names in place (returns a shallow copy). */
function shapeArea(src: unknown): unknown {
  if (src === null || typeof src !== "object") return src;
  const o: Obj = { ...(src as Obj) };
  flattenTags(o);
  return o;
}

/**
 * Shape the today view into its two `children` bucket records (read-shape v2 R1):
 * `{ today: { items }, evening: { items } }`, each a stage/`when`-pure list (the
 * bucket key states both — TODAY_SECTION_DROP). The whole-view `counts` aggregate
 * is NOT here — it rides `meta.counts` (runRead / the MCP metadata block). Inline
 * per-bucket `total` (present iff capped) is injected downstream by
 * {@link withTodayBucketTotals}, where the pre-cap sizes are known.
 */
function shapeTodayView(view: Obj, compact: boolean, promoter: RefPromoter): Obj {
  return {
    today: { items: shapeList(view["today"], TODAY_SECTION_DROP, compact, promoter) },
    evening: { items: shapeList(view["evening"], TODAY_SECTION_DROP, compact, promoter) },
  };
}

/**
 * Inject each today bucket's inline `total` (read-shape v2 R1): present iff the
 * bucket was capped (`items.length < total`), absent otherwise — an untruncated
 * bucket never restates its own length. `totals` are the pre-cap bucket sizes
 * from `truncateToday`. Both the CLI `data.children` wrapper and the MCP data
 * block run the shaped children through this so completeness is answerable
 * locally, with no truncation sidecar. Returns the children object unchanged when
 * it is not the expected shape.
 */
export function withTodayBucketTotals(
  children: unknown,
  totals: { today: number; evening: number },
): unknown {
  if (children === null || typeof children !== "object") return children;
  const c = children as Obj;
  return {
    today: withBucketTotal(c["today"], totals.today),
    evening: withBucketTotal(c["evening"], totals.evening),
  };
}

/**
 * Stamp a bucket record's inline `total` (read-shape v2 R1) iff it was capped
 * (`items.length < total`) — an untruncated bucket never restates its own length.
 * The pre-cap `total` comes from the bounding layer; returns the bucket unchanged
 * when it is not a `{items}` record. Shared by the today and area inline-total
 * injectors.
 */
function withBucketTotal(bucket: unknown, total: number): unknown {
  if (bucket === null || typeof bucket !== "object") return bucket;
  const b = bucket as Obj;
  const items = b["items"];
  const shown = Array.isArray(items) ? items.length : 0;
  return shown < total ? { ...b, total } : b;
}

/** Shape sidebar sections (anytime/someday catalogues) with the section's drop spec. */
function shapeSections(
  sections: unknown,
  drop: ItemDrop,
  compact: boolean,
  promoter: RefPromoter,
): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((s) =>
    s === null || typeof s !== "object" ? s : withShapedItems(s as Obj, drop, compact, promoter),
  );
}

/**
 * The flat, mixed-provenance list kinds mapped to their drop spec. Only the
 * stage-PURE catalogues (inbox/someday/logbook/trash; the section-based `anytime`
 * is pure too, handled via shapeSections below) drop the bucket-implied `stage`.
 * The mixed/derived surfaces (search/changes/deadlines/projects) keep it. The global
 * `upcoming` view is NOT here — it reshapes into `data.sections` day blocks
 * ({@link shapeUpcomingView}), keeping `stage` (R10.2: stage-mixed — future-dated
 * `upcoming` rows beside deadline-forecast `anytime`/`someday` ones).
 */
const FLAT_LIST_DROP: ReadonlyMap<string, ItemDrop> = new Map([
  ["inbox", { stage: true }],
  ["logbook", { stage: true }],
  ["trash", { stage: true }],
  ["changes", NO_DROP],
  ["search", NO_DROP],
  // deadlines is stage-MIXED (to-dos + projects, deadline-ordered) — keep `stage`.
  ["deadlines", NO_DROP],
  ["projects", NO_DROP],
]);

/**
 * Apply the universal reshapes + R6 + R7 + R10 to a read payload for one view
 * `kind`. `full` forces the FULL tier (R7 default-pruning off, everything else
 * applied); an unrecognized kind passes through unchanged. The input is never
 * mutated (shallow copies throughout), so the human-render path keeps the full
 * entities.
 */
export function shapeReadPayload(
  kind: string,
  data: unknown,
  full: boolean,
  promoter?: RefPromoter,
): unknown {
  // The ref-promotion oracle drives the round-trip law for flat container refs.
  // Absent (a DB-less unit shaping): assume every title round-trips — bare
  // titles, no uuid siblings. Production always passes the client's promoter.
  const p = promoter ?? ALWAYS_ROUND_TRIPS;
  // `detail` is the FULL record and drops no ancestry / stage / `when`.
  if (kind === "detail") return shapeItem(data, NO_DROP, false, p);
  const compact = !full;
  const flatDrop = FLAT_LIST_DROP.get(kind);
  if (flatDrop !== undefined) return shapeList(data, flatDrop, compact, p);
  // The global `upcoming` view reshapes into `data.sections` day blocks (PR 4).
  if (kind === "upcoming" && Array.isArray(data)) return shapeUpcomingView(data, compact, p);
  if (kind === "today" && data !== null && typeof data === "object") {
    return shapeTodayView(data as Obj, compact, p);
  }
  if (kind === "anytime" && Array.isArray(data)) {
    return shapeSections(data, ANYTIME_SECTION_DROP, compact, p); // stage-pure → drop stage
  }
  if (kind === "someday" && Array.isArray(data)) {
    return shapeSections(data, SOMEDAY_SECTION_DROP, compact, p); // stage-pure → drop stage
  }
  if (kind === "area-view" && data !== null && typeof data === "object") {
    return shapeAreaView(data as Obj, compact, p);
  }
  if (kind === "project-view" && data !== null && typeof data === "object") {
    return shapeProjectView(data as Obj, compact, p);
  }
  // The `areas` listing carries Area entities whose tags fold to names.
  if (kind === "areas" && Array.isArray(data)) return data.map(shapeArea);
  // tags / legend / snapshot / diagnostics: not tag-carrying entity payloads.
  return data;
}

/** The disambiguation-candidate kinds an error may list (a subset of the entity kinds). */
export type CandidateType = "to-do" | "project" | "heading" | "area" | "tag";

/**
 * The ONE fixed error-candidate shape — the presence-keyed disambiguation DTO a
 * not-found / ambiguous resolution lists under `error.detail.candidates` (and the
 * did-you-mean fallback under the same key). Deliberately minimal and INVARIANT
 * across request flags: `--full` / `--all` / etc. NEVER widen it, because an
 * error payload is the most determinism-critical surface. A candidate carries
 * ONLY material that helps a caller pick the right entity, drawn from the SAME
 * single-source derivations the read wire uses — never the raw internal entity
 * (no counts, no notes, no dates, no null-stuffed keys):
 * - `uuid` / `title` — always present.
 * - `type` — names the kind, EXCEPT to-do: absent `type` = to-do (present for
 *   `project` / `heading` / `area` / `tag`), the same convention the item wire uses.
 * - `area` / `project` — container hint as a TITLE string, present only when set.
 * - `stage` / `when` — the R10/R12 lifecycle words, present only for a to-do /
 *   project candidate whose source row carries the materialized lifecycle fields
 *   (a thin uuid+title resolver row carries neither — presence-keyed, so absent).
 * A trashed / logged candidate needs no boolean: `stage` already reads `"trash"`
 * / `"logbook"` for it — the same vocabulary the wire uses.
 */
export interface CandidateRef {
  uuid: string;
  title: string;
  /** The kind — omitted for a to-do (absent `type` = to-do), present otherwise. */
  type?: CandidateType;
  area?: string;
  project?: string;
  stage?: Stage;
  when?: When;
}

/** The fixed cap on a listed candidate array; the error `message` states the total when it overflows. */
export const CANDIDATE_CAP = 8;

/** Read a container hint — a Ref `{title}` or a plain title string — to its non-empty title, else null. */
function candidateContainerTitle(v: unknown): string | null {
  if (typeof v === "string") return v === "" ? null : v;
  if (v !== null && typeof v === "object") {
    const t = (v as Obj)["title"];
    if (typeof t === "string" && t !== "") return t;
  }
  return null;
}

/**
 * Project ONE entity — a materialized to-do/project/area/heading, or a thin
 * `{uuid, title}` resolver row — to the fixed {@link CandidateRef}. The SINGLE
 * source every error-candidate emit flows through (the did-you-mean fallback and
 * every not-found/ambiguous resolver), so the candidate shape can never vary by
 * site. Reuses the wire's own {@link stageOf}/{@link whenOf} derivations — the
 * lifecycle words are never re-derived here.
 */
export function candidateRef(type: CandidateType, src: unknown): CandidateRef {
  const s = (src ?? {}) as Obj;
  const out: CandidateRef = {
    uuid: typeof s["uuid"] === "string" ? (s["uuid"] as string) : "",
    title: typeof s["title"] === "string" ? (s["title"] as string) : "",
  };
  // Absent `type` = to-do — emit it only for the other kinds.
  if (type !== "to-do") out.type = type;
  const area = candidateContainerTitle(s["area"]);
  if (area !== null) out.area = area;
  const project =
    candidateContainerTitle(s["project"]) ?? candidateContainerTitle(s["headingProject"]);
  if (project !== null) out.project = project;
  // stage/when only for the task kinds, and only when the source carries the
  // materialized lifecycle substrate (`derived.start`) — a thin uuid+title
  // resolver row does not, so the keys stay absent (presence-keyed, like the wire).
  if (
    (type === "to-do" || type === "project") &&
    typeof ((s["derived"] ?? {}) as Obj)["start"] === "string"
  ) {
    const stage = stageOf(s);
    out.stage = stage;
    const when = whenOf(s, stage);
    if (when !== undefined) out.when = when;
  }
  return out;
}
