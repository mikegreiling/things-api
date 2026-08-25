/**
 * The ONE registry of the to-do / project UPDATE vocabulary
 * ({@link UpdateFields}) — and the primitives its fields are built from.
 *
 * `todo.update` / `project.update` is the widest multi-consumer vocabulary in
 * the write engine: the same seven fields are spoken by
 *
 *  1. the URL compilation (`update` / `update-project` parameters),
 *  2. the expected-delta assertions (what verify — and the audit trail's
 *     pre-capture, which snapshots exactly the ASSERTED fields — must prove),
 *  3. the undo inverse (which pre-values restore the field), and
 *  4. the CLI / MCP patch builders (flags → params, including the two `clear-*`
 *     flags that spell a `null`).
 *
 * Per the exhaustive-map doctrine (decisions.md 2026-08-17, #491) none of those
 * may hand-enumerate the vocabulary: each consumer derives from an EXHAUSTIVE
 * `Record<keyof …, …>` here, where every field is either a producer or an
 * explicit skip carrying a WRITTEN reason. A field added to {@link UpdateFields}
 * breaks compilation in {@link UPDATE_FIELD_MAP} until it is consciously handled
 * for all three engine legs, and in {@link UPDATE_INPUT_MAP} until both consumer
 * surfaces accept it — so "accepted by the CLI, silently never reaches the URL"
 * and "asserted shallowly, so a silent app no-op verifies ok" are unreachable by
 * construction rather than by review.
 *
 * The semantic backstop the types cannot give is the DISCRIMINATION property
 * test in test/unit/update-fields.test.ts (two patches sharing a requested-field
 * footprint but differing in ≥1 value ⇒ asserts(A) UNSATISFIED against state(B)).
 */
import {
  decodeReminderTime,
  encodeReminderTime,
  reminderUrlToken,
  type IsoDate,
  type ReminderTime,
} from "../model/dates.ts";
import { splitWhenSugar, type WhenSugarLabels } from "../model/when-sugar.ts";
import { reminderIsLive } from "../read/stage.ts";
import type { UpdateFields, WhenValue } from "./operations.ts";
import type { PreState } from "./pre-state.ts";
import type { FieldAssertion } from "./verify/delta.ts";

/**
 * The slice of the command catalog's `DeltaCtx` the update assertions read
 * (structural — the catalog passes its full ctx).
 */
export interface UpdateAssertCtx {
  /** Local calendar date under the verify clock. */
  todayIso: IsoDate;
}

// ------------------------------------------------------- shared field primitives

/** Round-trip normalization: "6:5"-style inputs → canonical "06:05". */
export function normalizeReminder(time: ReminderTime): ReminderTime {
  return decodeReminderTime(encodeReminderTime(time)) ?? time;
}

/**
 * The URL `when` value with an optional reminder token appended through the
 * deterministic emitter (never a bare 1–11 hour — oddity 2d).
 */
export function whenWithReminder(
  when: WhenValue,
  reminder: ReminderTime | null | undefined,
): string {
  if (reminder === undefined || reminder === null) return when;
  return `${when}@${reminderUrlToken(reminder)}`;
}

/**
 * The schedule assertions a `when` value implies. Shared with the ADD verbs
 * (mode "add"), which mint a fresh row rather than re-scheduling an existing one.
 */
export function whenAssertions(
  when: WhenValue,
  todayIso: IsoDate,
  opts: { mode: "add" | "update" } = { mode: "add" },
): FieldAssertion[] {
  // Strict shape check: an unvalidated string used to flow straight into the
  // URL (e.g. "2026-07-20@09:30", the raw URL grammar) — the app would SET
  // date+reminder while verification asserted the literal string as the date,
  // reporting a false mismatch on a write that succeeded.
  if (
    when !== "today" &&
    when !== "evening" &&
    when !== "anytime" &&
    when !== "someday" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(when)
  ) {
    throw new RangeError(
      when.includes("@")
        ? `invalid when "${when}" — a reminder time is a separate parameter (reminder: "HH:mm"; CLI --reminder), not an @ suffix`
        : `invalid when "${when}" — expected today | evening | anytime | someday | YYYY-MM-DD`,
    );
  }
  switch (when) {
    case "today":
      // Today's non-evening section: in Today (the `today` marker) AND NOT in the
      // evening sub-bucket (the presence-keyed `evening` marker absent — asserted
      // as null, which valuesEqual treats as absent). Gated to Today members under
      // the verify clock exactly as the retired `todaySection` was.
      //
      // The `startDate` assertion differs by op (field bug §0½.8):
      //  - ADD mints a fresh Today item with no schedule history, so the app dates
      //    it EXACTLY today — exact equality is right.
      //  - UPDATE of an item ALREADY in Today whose `startDate` has already arrived
      //    (past or today): the app PRESERVES that historical date rather than
      //    rewriting the storage byte to today (arrived-date law). Assert the
      //    arrived-date PREDICATE (non-null and <= today) so a preserved historical
      //    date verifies, while an undated deadline-only pull (null startDate) is
      //    still rejected — the item's Today membership then rests only on a
      //    deadline, not on the requested schedule.
      return [
        { field: "start", equals: "active" },
        opts.mode === "update"
          ? { field: "startDate", satisfies: { predicate: "arrived-on-or-before", date: todayIso } }
          : { field: "startDate", equals: todayIso },
        { field: "today", equals: true },
        { field: "evening", equals: null },
      ];
    case "evening":
      // The This-Evening sub-bucket: the `evening` marker (which implies `today`).
      return [
        { field: "start", equals: "active" },
        { field: "startDate", equals: todayIso },
        { field: "evening", equals: true },
      ];
    case "anytime":
      return [
        { field: "start", equals: "active" },
        { field: "startDate", equals: null },
      ];
    case "someday":
      return [{ field: "start", equals: "someday" }];
    default:
      // Concrete date: assert only the date — start-state semantics differ
      // for past/today/future dates (only the date itself is invariant).
      return [{ field: "startDate", equals: when }];
  }
}

/**
 * The effective reminder a when-bearing update should leave behind. A bare
 * `when=` CLEARS an existing reminder (R07/R20), so when the caller
 * re-schedules to today/evening/a date without addressing the reminder we
 * auto-preserve the current one; an explicit null is the intentional clear.
 *
 * §9n: a reminder whose row's `startDate` is already strictly PAST is
 * presentation-dead (the GUI hides its bell; the byte lingers in the DB). We do
 * NOT auto-preserve such a stale byte — carrying it into the re-schedule would
 * RESURRECT a reminder the user believes gone. A LIVE reminder (startDate
 * today/future) is preserved as before. The liveness test is the SAME
 * {@link reminderIsLive} predicate the read side gates on, consulted against the
 * target's CURRENT `startDate` under the response clock.
 */
export function effectiveReminder(pre: PreState, params: UpdateFields): ReminderTime | null {
  if (params.reminder !== undefined) return params.reminder;
  const when = params.when;
  const schedulable =
    when === "today" ||
    when === "evening" ||
    (typeof when === "string" && /^\d{4}-\d{2}-\d{2}$/.test(when));
  if (!schedulable) return null;
  const target = pre.target;
  if (target === null || target.type === "heading") return null;
  if (!reminderIsLive(target.startDate, pre.todayIso)) return null;
  // Read the RAW stored byte off the substrate (top-level `reminder` is
  // live-gated under the LOAD clock, which can differ from `pre.todayIso` under a
  // pinned THINGS_NOW). The `reminderIsLive` guard above applies liveness under
  // the injected clock explicitly, so the raw byte + this gate reproduce the
  // former semantics exactly.
  return target.derived.reminder;
}

export function assertNotesModesExclusive(params: UpdateFields): void {
  if (
    params.notes !== undefined &&
    (params.appendNotes !== undefined || params.prependNotes !== undefined)
  ) {
    throw new RangeError("notes (replace) is exclusive with appendNotes/prependNotes");
  }
  if (params.appendNotes !== undefined && params.prependNotes !== undefined) {
    throw new RangeError("appendNotes and prependNotes cannot be combined in one update");
  }
}

/** The notes body an append/prepend leg should leave behind (E04/E05/E11/E12). */
function joinedNotes(pre: PreState, params: UpdateFields): string | undefined {
  const current = pre.target !== null && pre.target.type !== "heading" ? pre.target.notes : "";
  // Separator semantics probed: newline-joined, no stray newline against an
  // empty note (E04/E05/E11/E12).
  if (params.appendNotes !== undefined) {
    return current === "" ? params.appendNotes : `${current}\n${params.appendNotes}`;
  }
  if (params.prependNotes !== undefined) {
    return current === "" ? params.prependNotes : `${params.prependNotes}\n${current}`;
  }
  return undefined;
}

// ------------------------------------------------------------ the field registry

/** The URL parameters one field contributes to `update` / `update-project`. */
type WireProducer = (params: UpdateFields, pre: PreState) => Record<string, string | undefined>;

/** The delta assertions one field contributes (emitted only when requested). */
type AssertProducer = (
  params: UpdateFields,
  pre: PreState,
  ctx: UpdateAssertCtx,
) => FieldAssertion[];

/** A consciously-skipped leg: the reason is copy, not a placeholder. */
interface Skip {
  skip: string;
}

/**
 * How ONE field of the update vocabulary behaves in each of the three engine
 * legs. Every leg is either a producer or an explicit {@link Skip}.
 */
interface UpdateFieldSpec {
  /** URL parameters, or why this field carries none of its own. */
  wire: WireProducer | Skip;
  /**
   * Presence trigger for the ASSERT leg, overriding the default
   * `params[key] !== undefined` — used where a field's assertion is triggered by
   * a SIBLING (the reminder a bare `when=` rewrites).
   */
  assertWhen?: (params: UpdateFields) => boolean;
  /** Delta assertions, or why this field cannot be asserted. */
  assert: AssertProducer | Skip;
  /**
   * The undo inverse: the audit-record pre-field whose captured value restores
   * this field (the restored parameter is the map key itself), or why the field
   * has no per-field inverse.
   */
  restore: { preField: string } | Skip;
}

/**
 * EXHAUSTIVE over every key of {@link UpdateFields}. The mapped-type key set
 * (`-?` makes each required) is what makes a newly added field a COMPILE error
 * until it earns an entry here.
 */
const UPDATE_FIELD_MAP: { [K in keyof UpdateFields]-?: UpdateFieldSpec } = {
  title: {
    wire: (p) => ({ title: p.title }),
    assert: (p) => [{ field: "title", equals: p.title }],
    restore: { preField: "title" },
  },
  notes: {
    wire: (p) => ({ notes: p.notes }),
    assert: (p) => [{ field: "notes", equals: p.notes }],
    restore: { preField: "notes" },
  },
  appendNotes: {
    wire: (p) => ({ "append-notes": p.appendNotes }),
    assert: (p, pre) => [{ field: "notes", equals: joinedNotes(pre, p) }],
    restore: {
      skip:
        "an append asserts the RESULTING notes body, so the captured `notes` pre-value (the " +
        "`notes` entry's inverse) restores it — there is no separate append to invert",
    },
  },
  prependNotes: {
    wire: (p) => ({ "prepend-notes": p.prependNotes }),
    assert: (p, pre) => [{ field: "notes", equals: joinedNotes(pre, p) }],
    restore: {
      skip:
        "a prepend asserts the RESULTING notes body, so the captured `notes` pre-value (the " +
        "`notes` entry's inverse) restores it — there is no separate prepend to invert",
    },
  },
  when: {
    // The reminder rides ALONG this parameter (`when=<value>@<token>`) — see the
    // `reminder` entry's wire skip.
    wire: (p, pre) => ({
      when: p.when === undefined ? undefined : whenWithReminder(p.when, effectiveReminder(pre, p)),
    }),
    assert: (p, pre, ctx) =>
      p.when === undefined ? [] : whenAssertions(p.when, ctx.todayIso, { mode: "update" }),
    restore: {
      skip:
        "the schedule axis is restored as ONE reconstructed `when=` step by undo's " +
        "scheduleSteps() (start/startDate/today/evening, or an Inbox move), not field-by-field",
    },
  },
  reminder: {
    wire: {
      skip:
        "the URL scheme has no standalone reminder parameter — a reminder rides the `when` " +
        "value as its `@<token>` suffix, emitted by the `when` entry through effectiveReminder. " +
        "H-REMINDER-SCOPE refuses a reminder without a schedulable when, so one can never be " +
        "requested with no `when` to carry it",
    },
    // Asserted whenever the SCHEDULE is rewritten (a bare `when=` clears an
    // existing reminder unless it is auto-preserved — R07/R20, effectiveReminder),
    // and whenever a reminder is requested outright: a requested reminder that the
    // wire could not carry must fail verification, never pass silently.
    assertWhen: (p) => p.when !== undefined || p.reminder !== undefined,
    assert: (p, pre) => {
      const reminder = effectiveReminder(pre, p);
      return [
        { field: "reminder", equals: reminder === null ? null : normalizeReminder(reminder) },
      ];
    },
    restore: {
      skip:
        "carried by the schedule step undo's scheduleSteps() builds — a reminder can only be " +
        "re-attached together with the `when` it hangs on (R07/R20)",
    },
  },
  deadline: {
    // The empty string is the URL's deadline CLEAR (a null deadline).
    wire: (p) => ({ deadline: p.deadline === null ? "" : p.deadline }),
    assert: (p) => [{ field: "deadline", equals: p.deadline }],
    restore: { preField: "deadline" },
  },
};

/** The vocabulary's keys, in registry order (the order consumers emit in). */
const UPDATE_FIELD_KEYS = Object.keys(UPDATE_FIELD_MAP) as (keyof UpdateFields)[];

/**
 * The `update` / `update-project` URL parameters for a patch (the target `id` is
 * the caller's). Every field either contributes here or carries a written reason
 * for why it cannot — a flag accepted by a consumer can no longer be dropped on
 * the way to the wire without one.
 */
export function updateWireParams(
  params: UpdateFields,
  pre: PreState,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of UPDATE_FIELD_KEYS) {
    const spec = UPDATE_FIELD_MAP[key];
    if ("skip" in spec.wire) continue;
    Object.assign(out, spec.wire(params, pre));
  }
  return out;
}

/**
 * The expected-delta assertions for a patch: REQUESTED-FIELDS-ONLY (a field the
 * caller did not set contributes nothing, keeping its don't-care semantics), and
 * every requested field contributes — the audit pre-capture snapshots exactly
 * this set, so it is also what undo has to restore from.
 */
export function updateAssertions(
  params: UpdateFields,
  pre: PreState,
  ctx: UpdateAssertCtx,
): FieldAssertion[] {
  const out: FieldAssertion[] = [];
  for (const key of UPDATE_FIELD_KEYS) {
    const spec = UPDATE_FIELD_MAP[key];
    if ("skip" in spec.assert) continue;
    const present =
      spec.assertWhen !== undefined ? spec.assertWhen(params) : params[key] !== undefined;
    if (present) out.push(...spec.assert(params, pre, ctx));
  }
  return out;
}

/**
 * The undo inverse's per-field parameters, read off an audit record's captured
 * pre-state (`record.pre`). The schedule axis is NOT here — undo reconstructs it
 * as one `when=` step (see the `when` / `reminder` skips).
 */
export function updateRestoreParams(pre: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (pre === null) return out;
  for (const key of UPDATE_FIELD_KEYS) {
    const spec = UPDATE_FIELD_MAP[key];
    if ("skip" in spec.restore) continue;
    const captured = pre[spec.restore.preField];
    if (captured !== undefined) out[key] = captured;
  }
  return out;
}

// ------------------------------------------------- the consumer patch builder

/**
 * The patch a consumer surface (CLI / MCP) hands the update verbs: the
 * {@link UpdateFields} vocabulary plus the resolution timestamps, which the
 * client's update dispatcher splits off onto their own orchestrator legs.
 */
export interface UpdatePatch extends UpdateFields {
  createdAt?: string;
  completedAt?: string;
}

/** A surface's spelling of the update vocabulary, interpolated into usage copy. */
export interface UpdateLabels extends WhenSugarLabels {
  notes: string;
  appendNotes: string;
  prependNotes: string;
  clearReminder: string;
  deadline: string;
  clearDeadline: string;
}

/** CLI flag spellings. */
export const CLI_UPDATE_LABELS: UpdateLabels = {
  when: "--when",
  reminder: "--reminder",
  notes: "--notes",
  appendNotes: "--append-notes",
  prependNotes: "--prepend-notes",
  clearReminder: "--clear-reminder",
  deadline: "--deadline",
  clearDeadline: "--clear-deadline",
};

/** MCP tool-parameter spellings. */
export const MCP_UPDATE_LABELS: UpdateLabels = {
  when: "when",
  reminder: "reminder",
  notes: "notes",
  appendNotes: "append_notes",
  prependNotes: "prepend_notes",
  clearReminder: "clear_reminder",
  deadline: "deadline",
  clearDeadline: "clear_deadline",
};

/** How ONE consumer flag lands in the patch. */
type InputSpec =
  /** A string flag copied onto `param`. */
  | { kind: "value"; param: keyof UpdatePatch }
  /** A boolean flag that spells `param: null` (the field's CLEAR). */
  | { kind: "clear"; param: "reminder" | "deadline" };

/**
 * The consumer-facing update vocabulary: {@link UpdateFields}, the two `clear-*`
 * flags that spell their nulls, and the resolution timestamps. Keys are the
 * camelCase (CLI/commander) spelling; {@link buildUpdatePatch} also accepts the
 * snake_case (MCP) spelling of each.
 */
export interface UpdateInput {
  title?: unknown;
  notes?: unknown;
  appendNotes?: unknown;
  prependNotes?: unknown;
  when?: unknown;
  reminder?: unknown;
  clearReminder?: unknown;
  deadline?: unknown;
  clearDeadline?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
}

/**
 * EXHAUSTIVE over the consumer vocabulary — the CLI and MCP update verbs share
 * this ONE mapping instead of each spelling out the field list (the drift that
 * let the two surfaces validate different flag pairs).
 */
const UPDATE_INPUT_MAP: { [K in keyof UpdateInput]-?: InputSpec } = {
  title: { kind: "value", param: "title" },
  notes: { kind: "value", param: "notes" },
  appendNotes: { kind: "value", param: "appendNotes" },
  prependNotes: { kind: "value", param: "prependNotes" },
  when: { kind: "value", param: "when" },
  reminder: { kind: "value", param: "reminder" },
  clearReminder: { kind: "clear", param: "reminder" },
  deadline: { kind: "value", param: "deadline" },
  clearDeadline: { kind: "clear", param: "deadline" },
  createdAt: { kind: "value", param: "createdAt" },
  completedAt: { kind: "value", param: "completedAt" },
};

const UPDATE_INPUT_KEYS = Object.keys(UPDATE_INPUT_MAP) as (keyof UpdateInput)[];

/** camelCase → the snake_case spelling of the same key (`appendNotes` → `append_notes`). */
function snakeOf(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Read one vocabulary key from a surface's parsed options bag (either spelling). */
function read(source: Record<string, unknown>, key: string): unknown {
  return source[key] ?? source[snakeOf(key)];
}

export type UpdatePatchResult =
  | { kind: "ok"; patch: UpdatePatch }
  | { kind: "error"; message: string };

/**
 * Build an update patch from a consumer surface's parsed options, or report the
 * ONE usage error. Accepts either spelling of each key (commander's camelCase or
 * MCP's snake_case) and ignores everything outside the vocabulary, so a surface
 * hands its whole options bag over instead of re-listing the fields.
 *
 * Owns every mutually-exclusive pair in the vocabulary — the notes modes, both
 * `clear-*` flags against their setters, and the `when` value's `@time` sugar
 * (which is a reminder, so it collides with BOTH reminder flags). A contradiction
 * is refused, never silently resolved in favor of one flag.
 */
export function buildUpdatePatch(
  source: Record<string, unknown>,
  labels: UpdateLabels = CLI_UPDATE_LABELS,
): UpdatePatchResult {
  const bag: Record<string, unknown> = {};
  for (const key of UPDATE_INPUT_KEYS) {
    const value = read(source, key);
    if (value !== undefined) bag[key] = value;
  }

  const notesModes = [bag["notes"], bag["appendNotes"], bag["prependNotes"]].filter(
    (v) => v !== undefined,
  );
  if (notesModes.length > 1) {
    return {
      kind: "error",
      message: `${labels.notes}, ${labels.appendNotes}, ${labels.prependNotes} are exclusive`,
    };
  }
  const clearReminder = bag["clearReminder"] === true;
  const clearDeadline = bag["clearDeadline"] === true;
  if (bag["reminder"] !== undefined && clearReminder) {
    return {
      kind: "error",
      message: `pass at most one of ${labels.reminder} / ${labels.clearReminder}`,
    };
  }
  if (bag["deadline"] !== undefined && clearDeadline) {
    return {
      kind: "error",
      message: `pass at most one of ${labels.deadline} / ${labels.clearDeadline}`,
    };
  }
  // The `@time` suffix IS a reminder: it collides with the clear flag exactly as
  // it collides with an explicit reminder (both would otherwise be applied, and
  // the loser silently dropped).
  const sugar = splitWhenSugar(bag["when"], bag["reminder"] !== undefined || clearReminder, labels);
  if (sugar.kind === "error") return { kind: "error", message: sugar.message };
  if (sugar.kind === "split") {
    bag["when"] = sugar.when;
    bag["reminder"] = sugar.reminder;
  }

  const patch: Record<string, unknown> = {};
  for (const key of UPDATE_INPUT_KEYS) {
    const spec = UPDATE_INPUT_MAP[key];
    const value = bag[key];
    if (spec.kind === "clear") {
      if (value === true) patch[spec.param] = null;
      continue;
    }
    // The values are surface-parsed strings; the pipeline validates their SHAPE
    // (whenAssertions / the reminder codec / the date parsers) and refuses a bad
    // one with a named error, so no re-validation happens here. A NON-string
    // present value is refused rather than skipped (#580): silently dropping it
    // produced an update that reported success while leaving the field untouched
    // — the same silent-degradation genus this registry exists to make
    // unreachable.
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return {
        kind: "error",
        message: `${(labels as unknown as Record<string, string | undefined>)[key] ?? key}: expected a string — received ${
          value === null
            ? "null"
            : Array.isArray(value)
              ? "an array"
              : typeof value === "object"
                ? "an object"
                : typeof value
        }`,
      };
    }
    patch[spec.param] = value;
  }
  return { kind: "ok", patch: patch as UpdatePatch };
}
