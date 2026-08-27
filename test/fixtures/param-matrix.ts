/**
 * The GENERATED parameter-type matrix (#580): valid baselines and wrong-type
 * injections derived from the schema registry ITSELF, so a new operation or a
 * new field is covered the moment it is declared — the matrix can never fall
 * behind the catalog the way a hand-written case list does.
 *
 * Every value here is synthetic (public repo rule): titles are "Sample …",
 * uuids are literal placeholders, nothing is derived from any real database.
 */
import { RESOLUTION_TIMESTAMP_EXPECTED } from "../../src/surface-copy.ts";
import { PARAM_SCHEMAS, type FieldSpec, type ParamSummary } from "../../src/write/param-schema.ts";
import { OPERATION_KINDS, WEEKDAYS, type OperationKind } from "../../src/write/operations.ts";

/**
 * A well-shaped sample for each `custom` field, keyed by the spec's own
 * `describe` string. EXHAUSTIVENESS is asserted by the test: a new custom shape
 * with no sample here fails the matrix rather than silently going uncovered.
 */
export const CUSTOM_SAMPLES: Record<string, unknown> = {
  "today | evening | anytime | someday | YYYY-MM-DD": "today",
  "a date (YYYY-MM-DD)": "2026-07-20",
  [RESOLUTION_TIMESTAMP_EXPECTED]: "2026-07-20",
  "a time of day (HH:mm, 24-hour)": "09:30",
  [`an array of weekday names (${WEEKDAYS.join(" | ")})`]: ["monday"],
  'a day-of-month anchor {"day": 1–31 | "last"} or an nth-weekday anchor {"weekday": …, "ordinal": 1–5 | "last"}':
    { day: 1 },
  'a month plus a day anchor — {"month": 1–12, "day": …} or {"month": 1–12, "weekday": …, "ordinal": …}':
    { month: 3, day: 1 },
  '{"kind": "never"} | {"kind": "on-date", "date": "YYYY-MM-DD"} | {"kind": "after", "count": 1–999}':
    { kind: "never" },
  '{"position": "first" | "last"} | {"before": "<heading>"} | {"after": "<heading>"}': {
    position: "last",
  },
  'an array of titles, or {"title": "…", "completed": true|false} objects': ["Sample item"],
  'an ordered array of {"kind": "to-do" | "heading", "title": "…"} nodes': [
    { kind: "to-do", title: "Sample child" },
  ],
};

/** A well-shaped value for one field spec, or undefined when none is known. */
export function sampleFor(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case "string":
      return "sample-value";
    case "boolean":
      return true;
    case "number":
      return spec.min ?? 1;
    case "stringArray":
      return ["sample-value"];
    case "enum":
      return spec.values?.[0];
    case "container":
      return { uuid: "sample-uuid-0000" };
    case "custom":
      return CUSTOM_SAMPLES[spec.describe];
    case "unvalidated":
      return "sample-value";
    default:
      return undefined;
  }
}

/** A fully-valid params bag for one operation (every field, required and optional). */
export function validParams(op: OperationKind): Record<string, unknown> {
  const schema = PARAM_SCHEMAS[op] as Record<string, FieldSpec>;
  const bag: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) bag[name] = sampleFor(spec);
  return bag;
}

/** One generated injection: a params bag with exactly ONE field made malformed. */
export interface Injection {
  op: OperationKind;
  /** The field the injection targets ("" for a whole-bag case such as an unknown key). */
  field: string;
  /** What was done to it — the case name in a failure message. */
  kind:
    | "string-where-object"
    | "object-where-string"
    | "number-where-string"
    | "string-where-boolean"
    | "string-where-number"
    | "string-where-array"
    | "invalid-enum-value"
    | "null-where-required"
    | "missing-required"
    | "unknown-key";
  params: Record<string, unknown>;
  /** The JSON path the refusal must name. */
  path: string;
}

/**
 * Every wrong-type injection the registry implies for one operation: per field,
 * the type confusions that field can suffer, plus the whole-bag unknown-key case.
 */
export function injectionsFor(op: OperationKind): Injection[] {
  const schema = PARAM_SCHEMAS[op] as Record<string, FieldSpec>;
  const base = validParams(op);
  const out: Injection[] = [];
  const push = (field: string, kind: Injection["kind"], value: unknown): void => {
    out.push({ op, field, kind, params: { ...base, [field]: value }, path: `params.${field}` });
  };

  for (const [field, spec] of Object.entries(schema)) {
    switch (spec.kind) {
      case "container":
        // The literal #580 shape: a bare uuid string where the object belongs.
        push(field, "string-where-object", "sample-uuid-0000");
        push(field, "number-where-string", 42);
        break;
      case "string":
        push(field, "object-where-string", { uuid: "sample-uuid-0000" });
        push(field, "number-where-string", 42);
        break;
      case "boolean":
        push(field, "string-where-boolean", "true");
        break;
      case "number":
        push(field, "string-where-number", "1");
        break;
      case "stringArray":
        push(field, "string-where-array", "sample-value");
        push(field, "object-where-string", [{ title: "x" }]);
        break;
      case "enum":
        push(field, "invalid-enum-value", "definitely-not-a-value");
        push(field, "number-where-string", 42);
        break;
      case "custom":
        push(field, "number-where-string", 42);
        break;
      case "unvalidated":
        break;
      default:
        break;
    }
    if (!spec.optional) {
      push(field, "null-where-required", null);
      const missing = { ...base };
      delete missing[field];
      out.push({ op, field, kind: "missing-required", params: missing, path: `params.${field}` });
    }
  }

  out.push({
    op,
    field: "",
    kind: "unknown-key",
    params: { ...base, notAParameter: "x" },
    path: "params.notAParameter",
  });
  return out;
}

/** The whole matrix, over every cataloged operation. */
export function allInjections(): Injection[] {
  return OPERATION_KINDS.flatMap((op) => injectionsFor(op));
}

/** Every `custom` describe string the registry uses (the sample-coverage law). */
export function customDescribes(): string[] {
  const seen = new Set<string>();
  for (const op of OPERATION_KINDS) {
    for (const spec of Object.values(PARAM_SCHEMAS[op] as Record<string, FieldSpec>)) {
      if (spec.kind === "custom") seen.add(spec.describe);
    }
  }
  return [...seen];
}

export type { ParamSummary };
