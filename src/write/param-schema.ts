/**
 * The ONE per-operation PARAMETER schema registry — the structural contract every
 * untyped entry point (batch JSONL, MCP `run_operation`/`batch`, a JavaScript
 * caller handing over parsed JSON) is held to BEFORE anything is dispatched.
 *
 * Why it exists (#580): the engine used to duck-test its own params — `todo.add`
 * asked whether `params.project` LOOKED like a container (`.uuid`/`.title`
 * present) and, when a bare uuid STRING was supplied instead, concluded the field
 * was ABSENT. No `list-id` compiled, no destination assertion was emitted, the
 * to-do landed in the Inbox, verification passed against the (empty) delta, and
 * the batch reported success. Malformed input degraded silently into a different,
 * plausible-looking mutation. The same genus lurks anywhere a shape is inferred
 * rather than asserted, so the fix is structural: ONE registry, checked at the
 * two choke points (the batch's static preflight and the mutation pipeline), and
 * duck tests downgraded to belt-and-braces throws.
 *
 * Doctrine (decisions.md 2026-08-17, #491 RRF1 — the exhaustive-map law): the
 * registry is EXHAUSTIVE on both axes. `PARAM_SCHEMAS` is a
 * `{ [K in OperationKind]: … }`, so a new operation breaks compilation until it
 * declares a schema; each op's schema is a `{ [F in keyof Params]-?: FieldSpec }`,
 * so a new parameter breaks compilation until its shape is consciously named.
 * Neither axis can be satisfied by an out-of-date literal.
 *
 * Hand-written, zero-dependency validation in the style of
 * [repeat-rule.ts](./repeat-rule.ts) — NO zod. zod is a consumer-surface
 * dependency confined to `src/mcp/server.ts` (the CLI guest bundle ships neither
 * it nor the MCP SDK; see the lazy loader in `src/index.ts`).
 *
 * The contract:
 *  - a REQUIRED field must be present and the right shape; absent or `null` is a
 *    structural error;
 *  - an OPTIONAL field may be absent, explicitly `null`, or the right shape —
 *    any other type is a structural error (never a silent "treat as absent");
 *  - UNKNOWN keys are refused by name (a typo is never silently dropped);
 *  - a container reference is an OBJECT (`{"uuid": …}` / `{"title": …}`) — a bare
 *    string is refused with steering copy rather than normalized. One canonical
 *    shape (ALPHA-CONTRACT: no shorthand alias machinery pre-1.0).
 *
 * The check is purely STRUCTURAL. It says nothing about whether a uuid exists,
 * whether two fields contradict each other (that stays with each command's
 * `preRead`), or whether a `"$name"` batch temp-reference is declared (that stays
 * with the batch's own `staticRefError`) — so `$`-prefixed strings pass every
 * plain-string field and every container `uuid`, as they must.
 */
import { RESOLUTION_TIMESTAMP_EXPECTED } from "../surface-copy.ts";
import {
  CHECKLIST_MAX_ITEMS,
  type LengthLimit,
  NOTES_LIMITS,
  TITLE_LIMITS,
  fieldLengthRefusal,
} from "./field-limits.ts";
import {
  OPERATION_KINDS,
  WEEKDAYS,
  type OperationKind,
  type OperationParamsMap,
} from "./operations.ts";
import { assertEndsBound, assertMonthlyAnchor } from "./repeat-rule.ts";

// ------------------------------------------------------------- the vocabulary

/**
 * The shape vocabulary. `custom` carries a hand-written validator for the shapes
 * the primitives cannot express (a discriminated bag, a structured item list, a
 * calendar anchor — those WRAP the engine's existing validators rather than
 * restating them). `unvalidated` is the escape hatch and requires a WRITTEN
 * reason; there are currently none.
 */
export type FieldKind =
  | "string"
  | "boolean"
  | "number"
  | "stringArray"
  | "enum"
  | "container"
  | "custom"
  | "unvalidated";

export interface FieldSpec {
  kind: FieldKind;
  /** Absent (or explicitly `null`) is accepted. */
  optional: boolean;
  /** Behavioral description of the accepted shape — the "expected" half of every refusal. */
  describe: string;
  /** enum: the accepted values. */
  values?: readonly string[];
  /** string: reject the empty string. */
  nonEmpty?: boolean;
  /**
   * string / stringArray: the field's MEASURED app ceilings
   * ({@link TITLE_LIMITS} for a title/name, {@link NOTES_LIMITS} for a notes
   * body). An over-long value is refused HERE rather than dispatched, because
   * Things accepts one as a silently TRUNCATED PREFIX — the mutation
   * half-lands and the caller learns only that verification failed (#621,
   * NOTECAP1). For a string array each element is checked on its own.
   */
  limits?: readonly LengthLimit[];
  /**
   * stringArray / custom: the measured cap on how many entries ONE dispatch
   * carries ({@link CHECKLIST_MAX_ITEMS}). Past it Things keeps the first N and
   * drops the rest silently — the same partial landing an over-long value
   * produces, one axis over.
   */
  maxItems?: number;
  /** number: whole numbers only, and the inclusive bounds. */
  integer?: boolean;
  min?: number;
  max?: number;
  /** custom: returns a refusal detail, or null when the value is well-shaped. */
  validate?: (value: unknown, path: string) => string | null;
  /** unvalidated: why this field carries no shape check. */
  reason?: string;
}

// Things stores an over-long field value as a SILENT TRUNCATED PREFIX rather
// than refusing it (#621, NOTECAP1), so the measured ceilings ride on the
// shared constructors — one per field class — rather than a per-field table
// that could drift out of date. `str` covers every title/name a write carries
// (4,000 UTF-16 units, an app-model cap present on every vector); `text` covers
// the free-text notes bodies (10,000 grapheme clusters / 40,000 UTF-16 units,
// the URL scheme's cap). Neither ceiling is policy: a field the app does not
// cut carries no limit here.
const str = (describe = "a non-empty string"): FieldSpec => ({
  kind: "string",
  optional: false,
  nonEmpty: true,
  limits: TITLE_LIMITS,
  describe,
});

/** A string field that legitimately accepts "" (free text: notes). */
const text = (describe = "a string"): FieldSpec => ({
  kind: "string",
  optional: false,
  limits: NOTES_LIMITS,
  describe,
});

const bool = (describe = "true or false"): FieldSpec => ({
  kind: "boolean",
  optional: false,
  describe,
});

const int = (min: number, max: number, describe?: string): FieldSpec => ({
  kind: "number",
  optional: false,
  integer: true,
  min,
  max,
  describe: describe ?? `a whole number ${min}–${max}`,
});

const strArray = (describe = "an array of non-empty strings"): FieldSpec => ({
  kind: "stringArray",
  optional: false,
  limits: TITLE_LIMITS,
  describe,
});

/**
 * Checklist-item titles: title-class strings, plus the measured 100-item cap
 * one dispatch carries (identical on `add`, `update` and the json batch).
 */
const checklistTitles = (describe = "an array of checklist item titles"): FieldSpec => ({
  ...strArray(describe),
  maxItems: CHECKLIST_MAX_ITEMS,
});

const enumOf = (values: readonly string[]): FieldSpec => ({
  kind: "enum",
  optional: false,
  values,
  describe: `one of ${values.join(" | ")}`,
});

const container = (): FieldSpec => ({
  kind: "container",
  optional: false,
  describe: 'a container reference object — {"uuid": "…"} or {"title": "…"}',
});

const custom = (
  describe: string,
  validate: (value: unknown, path: string) => string | null,
): FieldSpec => ({
  kind: "custom",
  optional: false,
  describe,
  validate,
});

/** Mark a spec optional (absent or `null` accepted). */
const opt = (spec: FieldSpec): FieldSpec => ({ ...spec, optional: true });

// --------------------------------------------------------------- type naming

/** The received-type half of a refusal, in the words a caller reading JSON uses. */
export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The refusal for a list longer than one dispatch carries. Shares the shape and
 * the reasoning of {@link fieldLengthRefusal}: the app takes the prefix and
 * drops the tail silently, so the caller must be told before anything is sent.
 */
function itemCountRefusal(path: string, count: number, max: number): string | null {
  if (count <= max) return null;
  return (
    `${path}: expected at most ${max} items — received ${count}; Things keeps the first ` +
    `${max} and drops the rest rather than refusing them, so nothing was sent`
  );
}

// --------------------------------------------------------- shared field specs

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A resolution timestamp: a bare date, or a date and a wall-clock time joined by
 * `T` or by a single space. The space spelling is a first-class alternative, not
 * a normalization: `resolveResolutionInstant` reads both to the same instant, so
 * the two layers accept exactly the same set of strings.
 */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const REMINDER_RE = /^\d{1,2}:\d{2}$/;
const WHEN_KEYWORDS = ["today", "evening", "anytime", "someday"] as const;

/**
 * A scheduling value: a list keyword or a concrete `YYYY-MM-DD`. The wording
 * matches `whenAssertions` (update-fields.ts) verbatim — the two check the same
 * grammar at different depths and must not speak with two voices.
 */
const WHEN_EXPECTED = "today | evening | anytime | someday | YYYY-MM-DD";
const whenValue = (): FieldSpec =>
  custom(WHEN_EXPECTED, (value, path) => {
    if (typeof value !== "string") {
      return `${path}: expected ${WHEN_EXPECTED} — received ${describeType(value)}`;
    }
    if ((WHEN_KEYWORDS as readonly string[]).includes(value) || ISO_DATE_RE.test(value))
      return null;
    return value.includes("@")
      ? `${path}: a reminder time is a separate parameter (reminder: "HH:mm"; CLI --reminder), not an @ suffix — received "${value}"`
      : `${path}: expected ${WHEN_EXPECTED} — received "${value}"`;
  });

const isoDate = (): FieldSpec =>
  custom("a date (YYYY-MM-DD)", (value, path) =>
    typeof value === "string" && ISO_DATE_RE.test(value)
      ? null
      : `${path}: expected a date (YYYY-MM-DD) — received ${typeof value === "string" ? `"${value}"` : describeType(value)}`,
  );

const timestamp = (): FieldSpec =>
  custom(RESOLUTION_TIMESTAMP_EXPECTED, (value, path) =>
    typeof value === "string" && TIMESTAMP_RE.test(value)
      ? null
      : `${path}: expected ${RESOLUTION_TIMESTAMP_EXPECTED} — received ${typeof value === "string" ? `"${value}"` : describeType(value)}`,
  );

const reminderTime = (): FieldSpec =>
  custom("a time of day (HH:mm, 24-hour)", (value, path) =>
    typeof value === "string" && REMINDER_RE.test(value)
      ? null
      : `${path}: expected a time of day (HH:mm, 24-hour) — received ${typeof value === "string" ? `"${value}"` : describeType(value)}`,
  );

/** An array of distinct weekday names (weekly rules). */
const weekdayArray = (): FieldSpec =>
  custom(`an array of weekday names (${WEEKDAYS.join(" | ")})`, (value, path) => {
    if (!Array.isArray(value)) {
      return `${path}: expected an array of weekday names — received ${describeType(value)}`;
    }
    for (let i = 0; i < value.length; i++) {
      const day = value[i];
      if (typeof day !== "string" || !(WEEKDAYS as readonly string[]).includes(day)) {
        return `${path}[${i}]: expected one of ${WEEKDAYS.join(" | ")} — received ${typeof day === "string" ? `"${day}"` : describeType(day)}`;
      }
    }
    return null;
  });

/** Wrap a throwing engine validator (repeat-rule.ts) as a schema `custom`. */
function wrapThrowing(fn: () => void, path: string): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return `${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Refuse keys outside a CLOSED nested bag. */
function unknownNestedKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): string | null {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    if (!allowed.includes(key)) {
      return `${path}.${key}: not a recognized field here — accepted fields are ${allowed.join(", ")}`;
    }
  }
  return null;
}

/** MONTHLY anchor: a day-of-month OR an nth-weekday, never a bag holding both. */
const monthlyAnchor = (): FieldSpec =>
  custom(
    'a day-of-month anchor {"day": 1–31 | "last"} or an nth-weekday anchor {"weekday": …, "ordinal": 1–5 | "last"}',
    (value, path) => {
      if (!isRecord(value)) {
        return `${path}: expected a day-of-month or nth-weekday anchor object — received ${describeType(value)}`;
      }
      const unknown = unknownNestedKey(value, ["day", "weekday", "ordinal"], path);
      if (unknown !== null) return unknown;
      return wrapThrowing(() => assertMonthlyAnchor(value, "the anchor"), path);
    },
  );

/** YEARLY anchor: a month plus the monthly-style day anchor. */
const yearlyAnchor = (): FieldSpec =>
  custom(
    'a month plus a day anchor — {"month": 1–12, "day": …} or {"month": 1–12, "weekday": …, "ordinal": …}',
    (value, path) => {
      if (!isRecord(value)) {
        return `${path}: expected a month plus a day anchor object — received ${describeType(value)}`;
      }
      const unknown = unknownNestedKey(value, ["month", "day", "weekday", "ordinal"], path);
      if (unknown !== null) return unknown;
      const month = value["month"];
      if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) {
        return `${path}.month: expected a whole number 1–12 — received ${describeType(month)}`;
      }
      return wrapThrowing(() => assertMonthlyAnchor(value, "the anchor"), path);
    },
  );

/** The "Ends" bound: a discriminated {kind} bag. */
const endsBound = (): FieldSpec =>
  custom(
    '{"kind": "never"} | {"kind": "on-date", "date": "YYYY-MM-DD"} | {"kind": "after", "count": 1–999}',
    (value, path) => {
      if (!isRecord(value)) {
        return `${path}: expected an end-bound object — received ${describeType(value)}`;
      }
      const kind = value["kind"];
      if (kind !== "never" && kind !== "on-date" && kind !== "after") {
        return `${path}.kind: expected one of never | on-date | after — received ${typeof kind === "string" ? `"${kind}"` : describeType(kind)}`;
      }
      const allowed =
        kind === "on-date" ? ["kind", "date"] : kind === "after" ? ["kind", "count"] : ["kind"];
      const unknown = unknownNestedKey(value, allowed, path);
      if (unknown !== null) return unknown;
      if (kind === "on-date" && typeof value["date"] !== "string") {
        return `${path}.date: expected a date (YYYY-MM-DD) — received ${describeType(value["date"])}`;
      }
      if (kind === "after" && typeof value["count"] !== "number") {
        return `${path}.count: expected a whole number 1–999 — received ${describeType(value["count"])}`;
      }
      return wrapThrowing(() => assertEndsBound(value as never), path);
    },
  );

/** Heading placement: exactly one of a position keyword, a `before`, or an `after` anchor. */
const headingPlacement = (): FieldSpec =>
  custom(
    '{"position": "first" | "last"} | {"before": "<heading>"} | {"after": "<heading>"}',
    (value, path) => {
      if (!isRecord(value)) {
        return `${path}: expected a placement object — received ${describeType(value)}`;
      }
      const unknown = unknownNestedKey(value, ["position", "before", "after"], path);
      if (unknown !== null) return unknown;
      const forms = (["position", "before", "after"] as const).filter(
        (k) => value[k] !== undefined && value[k] !== null,
      );
      if (forms.length !== 1) {
        return forms.length === 0
          ? `${path}: expected exactly one of position, before, after — received an object naming none of them`
          : `${path}: expected exactly one of position, before, after — received an object naming ${forms.join(" and ")}`;
      }
      const only = forms[0] as "position" | "before" | "after";
      const v = value[only];
      if (only === "position") {
        if (v !== "first" && v !== "last") {
          return `${path}.position: expected first | last — received ${typeof v === "string" ? `"${v}"` : describeType(v)}`;
        }
        return null;
      }
      if (typeof v !== "string" || v.length === 0) {
        return `${path}.${only}: expected a non-empty string naming a heading — received ${describeType(v)}`;
      }
      return null;
    },
  );

/** `todo.replace-checklist` items: plain titles, or `{title, completed?}` bags. */
const checklistItems = (): FieldSpec =>
  custom(
    'an array of titles, or {"title": "…", "completed": true|false} objects',
    (value, path) => {
      if (!Array.isArray(value)) {
        return `${path}: expected an array of checklist items — received ${describeType(value)}`;
      }
      const tooMany = itemCountRefusal(path, value.length, CHECKLIST_MAX_ITEMS);
      if (tooMany !== null) return tooMany;
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        const at = `${path}[${i}]`;
        if (typeof item === "string") {
          if (item.length === 0)
            return `${at}: expected a non-empty title — received an empty string`;
          const long = fieldLengthRefusal(at, item, TITLE_LIMITS);
          if (long !== null) return long;
          continue;
        }
        if (!isRecord(item)) {
          return `${at}: expected a title string or a {"title": "…"} object — received ${describeType(item)}`;
        }
        const unknown = unknownNestedKey(item, ["title", "completed"], at);
        if (unknown !== null) return unknown;
        if (typeof item["title"] !== "string" || item["title"].length === 0) {
          return `${at}.title: expected a non-empty string — received ${describeType(item["title"])}`;
        }
        const longTitle = fieldLengthRefusal(`${at}.title`, item["title"], TITLE_LIMITS);
        if (longTitle !== null) return longTitle;
        if (item["completed"] !== undefined && typeof item["completed"] !== "boolean") {
          return `${at}.completed: expected true or false — received ${describeType(item["completed"])}`;
        }
      }
      return null;
    },
  );

/** `project.add` structured items: ordered `to-do` / `heading` nodes. */
const projectItems = (): FieldSpec =>
  custom('an ordered array of {"kind": "to-do" | "heading", "title": "…"} nodes', (value, path) => {
    if (!Array.isArray(value)) {
      return `${path}: expected an array of project items — received ${describeType(value)}`;
    }
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const at = `${path}[${i}]`;
      if (!isRecord(item)) {
        return `${at}: expected a {"kind": "to-do" | "heading", "title": "…"} object — received ${describeType(item)}`;
      }
      const kind = item["kind"];
      if (kind !== "to-do" && kind !== "heading") {
        return `${at}.kind: expected to-do | heading — received ${typeof kind === "string" ? `"${kind}"` : describeType(kind)}`;
      }
      const allowed =
        kind === "heading"
          ? ["kind", "title"]
          : ["kind", "title", "notes", "when", "deadline", "tags", "checklistItems"];
      const unknown = unknownNestedKey(item, allowed, at);
      if (unknown !== null) return unknown;
      if (typeof item["title"] !== "string" || item["title"].length === 0) {
        return `${at}.title: expected a non-empty string — received ${describeType(item["title"])}`;
      }
      const longTitle = fieldLengthRefusal(`${at}.title`, item["title"], TITLE_LIMITS);
      if (longTitle !== null) return longTitle;
      if (kind === "heading") continue;
      const childSpecs: Record<string, FieldSpec> = {
        notes: opt(text()),
        when: opt(whenValue()),
        deadline: opt(isoDate()),
        tags: opt(strArray()),
        checklistItems: opt(checklistTitles()),
      };
      for (const [key, spec] of Object.entries(childSpecs)) {
        const error = checkField(spec, item[key], `${at}.${key}`);
        if (error !== null) return error;
      }
    }
    return null;
  });

// ------------------------------------------------------------- the value check

/** Validate ONE field value against its spec; null when well-shaped. */
function checkField(spec: FieldSpec, value: unknown, path: string): string | null {
  if (value === undefined || value === null) {
    if (spec.optional) return null;
    return `${path}: required — expected ${spec.describe}, but the field is ${value === null ? "null" : "missing"}`;
  }
  switch (spec.kind) {
    case "unvalidated":
      return null;
    case "string": {
      if (typeof value !== "string") {
        return `${path}: expected ${spec.describe} — received ${describeType(value)}`;
      }
      if (spec.nonEmpty === true && value.length === 0) {
        return `${path}: expected ${spec.describe} — received an empty string`;
      }
      if (spec.limits !== undefined) {
        return fieldLengthRefusal(path, value, spec.limits);
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${path}: expected ${spec.describe} — received ${describeType(value)}`;
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `${path}: expected ${spec.describe} — received ${describeType(value)}`;
      }
      if (spec.integer === true && !Number.isInteger(value)) {
        return `${path}: expected ${spec.describe} — received ${value}`;
      }
      if (
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        return `${path}: expected ${spec.describe} — received ${value}`;
      }
      return null;
    }
    case "stringArray": {
      if (!Array.isArray(value)) {
        return `${path}: expected ${spec.describe} — received ${describeType(value)}`;
      }
      if (spec.maxItems !== undefined) {
        const tooMany = itemCountRefusal(path, value.length, spec.maxItems);
        if (tooMany !== null) return tooMany;
      }
      for (let i = 0; i < value.length; i++) {
        const el = value[i];
        if (typeof el !== "string") {
          return `${path}[${i}]: expected a non-empty string — received ${describeType(el)}`;
        }
        if (el.length === 0) {
          return `${path}[${i}]: expected a non-empty string — received an empty string`;
        }
        if (spec.limits !== undefined) {
          const detail = fieldLengthRefusal(`${path}[${i}]`, el, spec.limits);
          if (detail !== null) return detail;
        }
      }
      return null;
    }
    case "enum": {
      const values = spec.values ?? [];
      if (typeof value !== "string" || !values.includes(value)) {
        return `${path}: expected ${spec.describe} — received ${typeof value === "string" ? `"${value}"` : describeType(value)}`;
      }
      return null;
    }
    case "container":
      return checkContainer(value, path);
    case "custom":
      return spec.validate?.(value, path) ?? null;
    default: {
      const exhaustive: never = spec.kind;
      return `${path}: unhandled field kind ${String(exhaustive)}`;
    }
  }
}

/**
 * A container reference is an OBJECT. A bare string — the #580 shape — is refused
 * with the object spelling it should have used; it is NOT normalized, because one
 * canonical shape is the whole point (a shorthand alias would put the silent
 * degradation back, just one layer up).
 */
function checkContainer(value: unknown, path: string): string | null {
  const expected = 'a container reference object — {"uuid": "…"} or {"title": "…"}';
  if (typeof value === "string") {
    return (
      `${path}: expected ${expected} — received a string; to reference it by uuid ` +
      `(or by a batch $ref), use {"uuid": ${JSON.stringify(value)}}`
    );
  }
  if (!isRecord(value)) {
    return `${path}: expected ${expected} — received ${describeType(value)}`;
  }
  const unknown = unknownNestedKey(value, ["uuid", "title"], path);
  if (unknown !== null) return unknown;
  const uuid = value["uuid"];
  const title = value["title"];
  if (uuid === undefined && title === undefined) {
    return `${path}: expected ${expected} — received an object naming neither`;
  }
  for (const [key, v] of [
    ["uuid", uuid],
    ["title", title],
  ] as const) {
    if (v === undefined) continue;
    if (typeof v !== "string") {
      return `${path}.${key}: expected a non-empty string — received ${describeType(v)}`;
    }
    if (v.length === 0) {
      return `${path}.${key}: expected a non-empty string — received an empty string`;
    }
  }
  // A `$name` temp-ref is a legal uuid VALUE here; whether it is DECLARED is the
  // batch preflight's question (staticRefError), not this one's.
  return null;
}

// ----------------------------------------------------------------- the registry

type OpSchema<K extends OperationKind> = { [F in keyof OperationParamsMap[K]]-?: FieldSpec };

/** `{ uuid }` — the shape most verbs take. */
const UUID_ONLY: OpSchema<"todo.complete"> = { uuid: str("an item uuid") };

/** The update vocabulary shared by `todo.update` and `project.update`. */
const UPDATE_FIELDS = {
  title: opt(str()),
  notes: opt(text()),
  appendNotes: opt(text()),
  prependNotes: opt(text()),
  when: opt(whenValue()),
  reminder: opt(reminderTime()),
  deadline: opt(isoDate()),
} as const;

/** The calendar-anchor rule vocabulary carried inline by the add-repeating composites. */
const ADD_REPEATING_RULE = {
  frequency: enumOf(["daily", "weekly", "monthly", "yearly"]),
  interval: int(1, 99, "a whole number 1–99"),
  afterCompletion: opt(bool()),
  weekdays: opt(weekdayArray()),
  monthly: opt(monthlyAnchor()),
  yearly: opt(yearlyAnchor()),
  ends: opt(endsBound()),
} as const;

const REPEAT_RULE: OpSchema<"todo.make-repeating"> = {
  uuid: str("an item uuid"),
  ...ADD_REPEATING_RULE,
  reminder: opt(reminderTime()),
  deadline: opt(bool("true or false (deadline the spawned occurrences)")),
  startDaysEarlier: opt(int(0, 366, "a whole number of days ≥ 0")),
  next: opt(isoDate()),
};

const SET_DATES: OpSchema<"todo.set-dates"> = {
  uuid: str("an item uuid"),
  completedAt: opt(timestamp()),
  createdAt: opt(timestamp()),
};

const NAME_OR_UUID: OpSchema<"area.delete"> = { target: str("a uuid or a unique title") };

const CLONE: OpSchema<"todo.clone"> = {
  uuid: str("an item uuid"),
  title: opt(str()),
  preserveCreated: opt(bool()),
};

const SET_TAGS: OpSchema<"todo.set-tags"> = {
  uuid: str("an item uuid"),
  tags: strArray("an array of tag titles (an empty array clears all tags)"),
};

/** No parameters at all — any key is unknown. */
const NO_PARAMS: OpSchema<"trash.empty"> = {};

const REORDER_SCOPES = [
  "today",
  "evening",
  "project",
  "area",
  "inbox",
  "someday",
  "projects",
  "heading",
  "area-someday",
  "anytime",
  "container-day",
  "day",
  "heading-someday",
  "tomorrow",
  "upcoming",
] as const;

/**
 * The registry. EXHAUSTIVE on both axes by construction: a new
 * {@link OperationKind} breaks compilation here, and a new parameter on any
 * operation breaks compilation in that operation's entry.
 */
export const PARAM_SCHEMAS: { [K in OperationKind]: OpSchema<K> } = {
  "todo.add": {
    title: str(),
    notes: opt(text()),
    when: opt(whenValue()),
    reminder: opt(reminderTime()),
    deadline: opt(isoDate()),
    tags: opt(strArray("an array of tag titles")),
    checklistItems: opt(checklistTitles()),
    project: opt(container()),
    area: opt(container()),
    heading: opt(str("a heading title inside the destination project")),
    createdAt: opt(timestamp()),
    completedAt: opt(timestamp()),
  },
  "todo.update": { uuid: str("an item uuid"), ...UPDATE_FIELDS },
  "todo.complete": UUID_ONLY,
  "todo.cancel": UUID_ONLY,
  "todo.reopen": UUID_ONLY,
  "todo.move": {
    uuid: str("an item uuid"),
    project: opt(container()),
    area: opt(container()),
    heading: opt(str("a heading title inside the destination project")),
    inbox: opt(bool()),
    noHeading: opt(bool()),
    loose: opt(bool()),
  },
  "todo.set-tags": SET_TAGS,
  "todo.replace-checklist": { uuid: str("an item uuid"), items: checklistItems() },
  "todo.edit-checklist-item": {
    uuid: str("an item uuid"),
    action: enumOf(["add", "remove", "check", "uncheck", "rename", "move"]),
    title: opt(str()),
    index: opt(int(1, 10_000, "a whole number ≥ 1 (1-based position)")),
    at: opt(int(1, 10_000, "a whole number ≥ 1 (1-based position)")),
    to: opt(int(1, 10_000, "a whole number ≥ 1 (1-based position)")),
    newTitle: opt(str()),
  },
  "todo.delete": UUID_ONLY,
  "project.add": {
    title: str(),
    notes: opt(text()),
    area: opt(container()),
    when: opt(whenValue()),
    deadline: opt(isoDate()),
    todos: opt(strArray("an array of child to-do titles")),
    items: opt(projectItems()),
    createdAt: opt(timestamp()),
    completedAt: opt(timestamp()),
  },
  "project.update": { uuid: str("a project uuid or unique title"), ...UPDATE_FIELDS },
  "project.complete": {
    uuid: str("a project uuid or unique title"),
    children: enumOf(["require-resolved", "auto-complete"]),
  },
  "project.delete": { uuid: str("a project uuid or unique title") },
  "area.add": { title: str(), tags: opt(strArray("an array of tag titles")) },
  "area.delete": NAME_OR_UUID,
  "tag.add": { title: str(), parent: opt(str("an existing parent tag title")) },
  "tag.delete": NAME_OR_UUID,
  "trash.empty": NO_PARAMS,
  reorder: {
    scope: enumOf(REORDER_SCOPES),
    container: opt(container()),
    uuids: strArray("an array of item uuids, top-first"),
    named: opt(strArray("an array of item uuids (a subset of uuids)")),
    strategy: opt(enumOf(["native", "bounce"])),
  },
  "todo.duplicate": UUID_ONLY,
  "area.update": {
    target: str("a uuid or a unique title"),
    title: opt(str()),
    tags: opt(strArray("an array of existing tag titles")),
  },
  "tag.update": {
    target: str("a uuid or a unique title"),
    title: opt(str()),
    parent: opt(str("an existing parent tag title")),
    unnest: opt(bool()),
    shortcut: opt(str("a single character")),
    clearShortcut: opt(bool()),
  },
  "project.move": {
    uuid: str("a project uuid or unique title"),
    area: opt(container()),
    noArea: opt(bool()),
  },
  "todo.restore": UUID_ONLY,
  "project.duplicate": { uuid: str("a project uuid or unique title") },
  "project.cancel": {
    uuid: str("a project uuid or unique title"),
    children: enumOf(["require-resolved", "auto-cancel"]),
  },
  "project.reopen": { uuid: str("a project uuid or unique title") },
  "project.restore": { uuid: str("a project uuid or unique title") },
  "project.set-tags": {
    uuid: str("a project uuid or unique title"),
    tags: strArray("an array of tag titles (an empty array clears all tags)"),
  },
  "todo.set-dates": SET_DATES,
  "project.set-dates": SET_DATES,
  "project.add-heading": { project: container(), title: str() },
  "project.rename-heading": { uuid: str("a heading uuid"), title: str() },
  "project.archive-heading": {
    uuid: str("a heading uuid"),
    children: opt(enumOf(["complete", "cancel", "reparent"])),
  },
  "project.unarchive-heading": { uuid: str("a heading uuid"), restoreChildren: opt(bool()) },
  "project.promote-heading": { uuid: str("a heading uuid") },
  "project.move-heading": {
    project: container(),
    headings: strArray("an array of heading uuids, in the order they should land"),
    placement: headingPlacement(),
  },
  "project.move-heading-to-project": {
    project: container(),
    heading: str("a heading title or uuid inside the source project"),
    toProject: container(),
  },
  "project.dissolve-heading": { uuid: str("a heading uuid") },
  "todo.clear-dated-reminder": UUID_ONLY,
  "todo.make-repeating": REPEAT_RULE,
  "todo.reschedule-repeat": REPEAT_RULE,
  "todo.pause-repeat": UUID_ONLY,
  "todo.resume-repeat": UUID_ONLY,
  "todo.create-next-copy": UUID_ONLY,
  "todo.convert-to-project": UUID_ONLY,
  "project.reschedule-repeat": REPEAT_RULE,
  "project.pause-repeat": { uuid: str("a project uuid or unique title") },
  "project.resume-repeat": { uuid: str("a project uuid or unique title") },
  "area.reorder": {
    target: str("an area uuid or unique title"),
    before: opt(str("an area uuid or unique title")),
    after: opt(str("an area uuid or unique title")),
    position: opt(enumOf(["first", "last"])),
  },
  "project.make-repeating": REPEAT_RULE,
  "project.add-repeating": {
    ...ADD_REPEATING_RULE,
    title: str(),
    notes: opt(text()),
    area: opt(container()),
    when: opt(whenValue()),
    deadline: opt(isoDate()),
    todos: opt(strArray("an array of child to-do titles")),
    items: opt(projectItems()),
    createdAt: opt(timestamp()),
  },
  "todo.add-repeating": {
    ...ADD_REPEATING_RULE,
    title: str(),
    notes: opt(text()),
    when: opt(whenValue()),
    reminder: opt(reminderTime()),
    deadline: opt(isoDate()),
    startDaysEarlier: opt(int(0, 366, "a whole number of days ≥ 0")),
    tags: opt(strArray("an array of tag titles")),
    checklistItems: opt(checklistTitles()),
    project: opt(container()),
    area: opt(container()),
    heading: opt(str("a heading title inside the destination project")),
    createdAt: opt(timestamp()),
  },
  "todo.clone": CLONE,
  "project.clone": CLONE,
  "log-now": NO_PARAMS,
};

// ------------------------------------------------------------------ the check

/**
 * The STRUCTURAL parameter check for one operation. Returns the FIRST refusal
 * detail (JSON path · expected shape · received type), or null when the bag is
 * well-shaped. Never throws; never mutates or normalizes the params.
 */
export function validateOperationParams(op: OperationKind, params: unknown): string | null {
  if (!isRecord(params)) {
    return `params: expected an object of operation parameters — received ${describeType(params)}`;
  }
  const schema = PARAM_SCHEMAS[op] as Record<string, FieldSpec | undefined>;
  const known = Object.keys(PARAM_SCHEMAS[op] as Record<string, FieldSpec>);

  for (const key of Object.keys(params)) {
    if (params[key] === undefined) continue;
    if (!Object.hasOwn(schema, key)) {
      return known.length === 0
        ? `params.${key}: "${op}" takes no parameters — nothing was applied for this field`
        : `params.${key}: not a parameter of "${op}" — accepted parameters are ${known.join(", ")}`;
    }
  }
  for (const key of known) {
    const spec = schema[key];
    if (spec === undefined) continue;
    const error = checkField(spec, params[key], `params.${key}`);
    if (error !== null) return error;
  }
  return null;
}

/** A structural parameter refusal — an input-contract error, never an app failure. */
export class ParamSchemaError extends RangeError {
  /** The operation whose parameter bag was refused. */
  readonly op: OperationKind;

  constructor(op: OperationKind, detail: string) {
    super(detail);
    this.name = "ParamSchemaError";
    this.op = op;
  }
}

/** {@link validateOperationParams}, as a throwing assertion for the pipeline. */
export function assertOperationParams(op: OperationKind, params: unknown): void {
  const detail = validateOperationParams(op, params);
  if (detail !== null) throw new ParamSchemaError(op, detail);
}

/** One parameter's machine-readable summary (the `capabilities` params column). */
export interface ParamSummary {
  name: string;
  kind: FieldKind;
  optional: boolean;
  /** Behavioral description of the accepted shape. */
  expects: string;
  /** enum only: the accepted values. */
  values?: readonly string[];
}

/**
 * The per-op parameter summary `things capabilities` publishes, so the promise
 * that the catalog carries "operation kinds AND their parameter shapes" is met by
 * data rather than by prose.
 */
export function paramSummary(op: OperationKind): ParamSummary[] {
  const schema = PARAM_SCHEMAS[op] as Record<string, FieldSpec>;
  return Object.entries(schema).map(([name, spec]) => {
    const row: ParamSummary = {
      name,
      kind: spec.kind,
      optional: spec.optional,
      expects: spec.describe,
    };
    if (spec.values !== undefined) row.values = spec.values;
    return row;
  });
}

/** Runtime completeness law: every cataloged operation declares a schema. */
export function operationsMissingSchema(): OperationKind[] {
  return OPERATION_KINDS.filter((op) => !Object.hasOwn(PARAM_SCHEMAS, op));
}

/** Every `unvalidated` escape in the registry, with its written reason (currently none). */
export function unvalidatedFields(): { op: OperationKind; field: string; reason: string }[] {
  const out: { op: OperationKind; field: string; reason: string }[] = [];
  for (const op of OPERATION_KINDS) {
    for (const [field, spec] of Object.entries(PARAM_SCHEMAS[op] as Record<string, FieldSpec>)) {
      if (spec.kind === "unvalidated") out.push({ op, field, reason: spec.reason ?? "" });
    }
  }
  return out;
}
