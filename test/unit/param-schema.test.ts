/**
 * The per-operation PARAMETER schema registry (#580).
 *
 * The laws under test:
 *  1. COMPLETENESS — every cataloged operation declares a schema (the per-FIELD
 *     axis is compile-time; this is the runtime half of the same law).
 *  2. NO SILENT ESCAPES — the registry carries no `unvalidated` field without a
 *     written reason (and, today, none at all).
 *  3. VALID BAGS PASS — a bag built from the registry's own shapes validates, so
 *     the refusal matrix below is not vacuously green.
 *  4. THE REFUSAL MATRIX — every field of every op, driven through the type
 *     confusions the registry implies, is refused with the JSON path, the
 *     expected shape, and the received type.
 *  5. CONTAINER CANONICALITY — a bare string is REFUSED (never normalized) with
 *     the object spelling it should have used; `$ref` strings stay legal values.
 */
import { describe, expect, it } from "vitest";

import { RESOLUTION_TIMESTAMP_EXPECTED } from "../../src/surface-copy.ts";
import { OPERATION_KINDS } from "../../src/write/operations.ts";
import {
  PARAM_SCHEMAS,
  operationsMissingSchema,
  paramSummary,
  unvalidatedFields,
  validateOperationParams,
  type FieldSpec,
} from "../../src/write/param-schema.ts";
import {
  CUSTOM_SAMPLES,
  allInjections,
  customDescribes,
  validParams,
} from "../fixtures/param-matrix.ts";

describe("registry completeness", () => {
  it("every cataloged operation declares a parameter schema", () => {
    expect(operationsMissingSchema()).toEqual([]);
    expect(Object.keys(PARAM_SCHEMAS).toSorted()).toEqual([...OPERATION_KINDS].toSorted());
  });

  it("carries no unvalidated escape", () => {
    expect(unvalidatedFields()).toEqual([]);
  });

  it("every custom shape has a matrix sample (so no field goes uncovered)", () => {
    const missing = customDescribes().filter((d) => !Object.hasOwn(CUSTOM_SAMPLES, d));
    expect(missing).toEqual([]);
  });

  it("publishes a machine-readable summary per operation", () => {
    const summary = paramSummary("todo.add");
    const project = summary.find((f) => f.name === "project");
    expect(project).toEqual({
      name: "project",
      kind: "container",
      optional: true,
      expects: 'a container reference object — {"uuid": "…"} or {"title": "…"}',
    });
    const children = paramSummary("project.complete").find((f) => f.name === "children");
    expect(children?.optional).toBe(false);
    expect(children?.values).toEqual(["require-resolved", "auto-complete"]);
  });
});

describe("valid bags pass", () => {
  it.each([...OPERATION_KINDS])("%s accepts a bag built from its own shapes", (op) => {
    expect(validateOperationParams(op, validParams(op))).toBeNull();
  });

  it("an optional field may be absent OR explicitly null", () => {
    expect(validateOperationParams("todo.add", { title: "Sample" })).toBeNull();
    expect(
      validateOperationParams("todo.add", { title: "Sample", project: null, when: null }),
    ).toBeNull();
  });

  it("a $ref is a legal VALUE in a plain string field and inside a container", () => {
    expect(validateOperationParams("todo.complete", { uuid: "$made" })).toBeNull();
    expect(
      validateOperationParams("todo.add", { title: "Sample", project: { uuid: "$proj" } }),
    ).toBeNull();
    expect(validateOperationParams("area.delete", { target: "$area" })).toBeNull();
  });
});

describe("the generated refusal matrix", () => {
  const matrix = allInjections();

  it("covers every operation and is not trivially small", () => {
    expect(new Set(matrix.map((c) => c.op)).size).toBe(OPERATION_KINDS.length);
    expect(matrix.length).toBeGreaterThan(200);
  });

  it("refuses every injection, naming the JSON path", () => {
    const survivors: string[] = [];
    for (const injection of matrix) {
      const detail = validateOperationParams(injection.op, injection.params);
      if (detail === null || !detail.startsWith(injection.path)) {
        survivors.push(
          `${injection.op} ${injection.kind} ${injection.field}: ${detail ?? "ACCEPTED"}`,
        );
      }
    }
    expect(survivors).toEqual([]);
  });

  it("every refusal names an expected shape and what was received", () => {
    const thin: string[] = [];
    for (const injection of matrix) {
      const detail = validateOperationParams(injection.op, injection.params) ?? "";
      // An unknown key names the key and the accepted set; every other refusal
      // names an expected shape AND what arrived in its place.
      const names =
        detail.includes("not a parameter") ||
        detail.includes("takes no parameters") ||
        ((detail.includes("expected") || detail.includes("required")) &&
          (detail.includes("received") ||
            detail.includes("is missing") ||
            detail.includes("is null")));
      if (!names) thin.push(`${injection.op} ${injection.kind} ${injection.field}: ${detail}`);
    }
    expect(thin).toEqual([]);
  });
});

describe("container canonicality (the #580 shape)", () => {
  it("a bare string project is refused with the object spelling, not normalized", () => {
    const detail = validateOperationParams("todo.add", {
      title: "Synthetic child",
      project: "sample-project-uuid",
    });
    expect(detail).toContain("params.project");
    expect(detail).toContain("expected a container reference object");
    expect(detail).toContain("received a string");
    expect(detail).toContain('{"uuid": "sample-project-uuid"}');
  });

  it("a bare $ref string in a container field is refused the same way", () => {
    const detail = validateOperationParams("todo.add", {
      title: "Synthetic child",
      project: "$proj",
    });
    expect(detail).toContain("params.project");
    expect(detail).toContain('{"uuid": "$proj"}');
  });

  it("a container object naming neither uuid nor title is refused", () => {
    expect(validateOperationParams("todo.add", { title: "Sample", project: {} })).toContain(
      "naming neither",
    );
  });

  it("a container object with a stray key is refused by name", () => {
    const detail = validateOperationParams("todo.add", {
      title: "Sample",
      project: { uuid: "u", name: "n" },
    });
    expect(detail).toContain("params.project.name");
  });

  it("an empty uuid/title is refused rather than queried as an empty key", () => {
    expect(
      validateOperationParams("todo.add", { title: "Sample", project: { uuid: "" } }),
    ).toContain("params.project.uuid");
  });
});

describe("field-level refusals", () => {
  it("an unknown parameter is named, and the accepted set is listed", () => {
    const detail = validateOperationParams("todo.add", { title: "Sample", proejct: "typo" });
    expect(detail).toContain("params.proejct");
    expect(detail).toContain("not a parameter");
    expect(detail).toContain("project");
  });

  it("an op that takes no parameters refuses any key", () => {
    expect(validateOperationParams("trash.empty", {})).toBeNull();
    expect(validateOperationParams("trash.empty", { uuid: "x" })).toContain("takes no parameters");
  });

  it("a required field is refused when absent and when null", () => {
    expect(validateOperationParams("todo.complete", {})).toContain("params.uuid");
    expect(validateOperationParams("todo.complete", { uuid: null })).toContain("params.uuid");
  });

  it('a string "true" is not a boolean', () => {
    const detail = validateOperationParams("todo.move", { uuid: "u", inbox: "true" });
    expect(detail).toContain("params.inbox");
    expect(detail).toContain("received a string");
  });

  it("an invalid enum value names the accepted values", () => {
    const detail = validateOperationParams("project.complete", { uuid: "u", children: "yes" });
    expect(detail).toContain("params.children");
    expect(detail).toContain("require-resolved");
  });

  it("an array element of the wrong type is refused by index", () => {
    const detail = validateOperationParams("todo.set-tags", { uuid: "u", tags: ["ok", 7] });
    expect(detail).toContain("params.tags[1]");
  });

  it("params itself must be an object", () => {
    expect(validateOperationParams("todo.add", "not-an-object")).toContain("received a string");
    expect(validateOperationParams("todo.add", null)).toContain("received null");
    expect(validateOperationParams("todo.add", [])).toContain("received an array");
  });

  it("a nested structured item is refused by its own path", () => {
    const detail = validateOperationParams("project.add", {
      title: "Sample",
      items: [{ kind: "to-do", title: "Sample child", tags: "not-an-array" }],
    });
    expect(detail).toContain("params.items[0].tags");
  });

  it("a nested item with an unknown key is refused by name", () => {
    const detail = validateOperationParams("project.add", {
      title: "Sample",
      items: [{ kind: "heading", title: "Sample heading", notes: "no" }],
    });
    expect(detail).toContain("params.items[0].notes");
  });

  it("the repeat-rule anchors delegate to the engine's own validators", () => {
    const both = validateOperationParams("todo.reschedule-repeat", {
      uuid: "u",
      frequency: "monthly",
      interval: 1,
      monthly: { day: 3, weekday: "monday" },
    });
    expect(both).toContain("params.monthly");
    expect(both).toContain("choose one");
    const badOrdinal = validateOperationParams("todo.reschedule-repeat", {
      uuid: "u",
      frequency: "monthly",
      interval: 1,
      monthly: { weekday: "monday", ordinal: 9 },
    });
    expect(badOrdinal).toContain("params.monthly");
  });

  // #612 ride-along: the registry's timestamp() is the single static choke point
  // every untyped surface passes through, so BOTH spellings must clear it here
  // or `--completed-at "YYYY-MM-DD HH:mm"` never reaches the resolver.
  it("a resolution timestamp accepts the T and the space spelling alike (#612)", () => {
    for (const op of ["todo.set-dates", "project.set-dates"] as const) {
      for (const value of [
        "2026-08-19",
        "2026-08-19T09:30",
        "2026-08-19 09:30",
        "2026-08-19 09:30:45",
      ]) {
        expect(
          validateOperationParams(op, { uuid: "todo-uuid-0001", completedAt: value }),
          `${op} ${value}`,
        ).toBeNull();
      }
    }
    expect(
      validateOperationParams("todo.add", { title: "Sample", createdAt: "2026-08-19 09:30" }),
    ).toBeNull();
  });

  it("a malformed resolution timestamp names both accepted spellings (#612)", () => {
    const detail = validateOperationParams("todo.set-dates", {
      uuid: "todo-uuid-0001",
      completedAt: "19/08/2026 09:30",
    });
    expect(detail).toContain("params.completedAt");
    expect(detail).toContain(RESOLUTION_TIMESTAMP_EXPECTED);
    expect(detail).toContain('received "19/08/2026 09:30"');
    // Exactly one separator character: a doubled space is not a datetime.
    expect(
      validateOperationParams("todo.set-dates", {
        uuid: "todo-uuid-0001",
        completedAt: "2026-08-19  09:30",
      }),
    ).toContain(RESOLUTION_TIMESTAMP_EXPECTED);
  });

  it("a when value keeps the engine's own vocabulary", () => {
    expect(validateOperationParams("todo.add", { title: "S", when: "tomorrow" })).toContain(
      "today | evening | anytime | someday | YYYY-MM-DD",
    );
    expect(validateOperationParams("todo.add", { title: "S", when: "2026-07-20@09:30" })).toContain(
      "reminder time is a separate parameter",
    );
  });
});

const ascii = (n: number): string => "x".repeat(n);
const emoji = (n: number): string => "\u{1F600}".repeat(n);
const checklist = (n: number): string[] => Array.from({ length: n }, (_, i) => `item ${i}`);

describe("field-length ceilings (#621)", () => {
  it("notes: 10,000 characters land, 10,001 are refused before dispatch", () => {
    expect(
      validateOperationParams("todo.update", { uuid: "todo-uuid-0001", notes: ascii(10_000) }),
    ).toBeNull();
    const detail = validateOperationParams("todo.update", {
      uuid: "todo-uuid-0001",
      notes: ascii(10_001),
    });
    expect(detail).toContain("params.notes");
    expect(detail).toContain("at most 10,000 characters");
    expect(detail).toContain("received 10,001");
  });

  it("notes are measured in CLUSTERS, so an emoji body is not refused at half the ceiling", () => {
    expect(validateOperationParams("todo.add", { title: "S", notes: emoji(10_000) })).toBeNull();
  });

  it("an append/prepend FRAGMENT carries the notes ceiling — the join is the app's business", () => {
    // The wire sends the fragment and Things does the join; the joined RESULT
    // legitimately exceeds the ceiling (NOTECAP1 V-URL-APPEND-XXL), so only the
    // fragment is checked.
    expect(
      validateOperationParams("todo.update", {
        uuid: "todo-uuid-0001",
        appendNotes: ascii(10_000),
      }),
    ).toBeNull();
    expect(
      validateOperationParams("todo.update", {
        uuid: "todo-uuid-0001",
        prependNotes: ascii(10_001),
      }),
    ).toContain("params.prependNotes");
  });

  it("titles: 4,000 UTF-16 code units land, 4,001 are refused — on every title field", () => {
    expect(validateOperationParams("todo.add", { title: ascii(4_000) })).toBeNull();
    expect(validateOperationParams("todo.add", { title: ascii(4_001) })).toContain(
      "at most 4,000 UTF-16 code units",
    );
    expect(validateOperationParams("project.add", { title: ascii(4_001) })).toContain(
      "params.title",
    );
    expect(validateOperationParams("area.add", { title: ascii(4_001) })).toContain("4,000");
    expect(validateOperationParams("tag.add", { title: ascii(4_001) })).toContain("4,000");
    expect(
      validateOperationParams("project.add-heading", {
        project: { uuid: "project-uuid-0001" },
        title: ascii(4_001),
      }),
    ).toContain("4,000");
  });

  it("titles are measured in UTF-16 UNITS, so 2,001 emoji overrun a 4,000 ceiling", () => {
    expect(validateOperationParams("todo.add", { title: emoji(2_000) })).toBeNull();
    expect(validateOperationParams("todo.add", { title: emoji(2_001) })).toContain(
      "received 4,002",
    );
  });

  it("checklist items: 100 land, 101 are refused, and each title carries the title ceiling", () => {
    expect(
      validateOperationParams("todo.add", { title: "S", checklistItems: checklist(100) }),
    ).toBeNull();
    const tooMany = validateOperationParams("todo.add", {
      title: "S",
      checklistItems: checklist(101),
    });
    expect(tooMany).toContain("params.checklistItems");
    expect(tooMany).toContain("at most 100 items");
    expect(tooMany).toContain("received 101");
    expect(
      validateOperationParams("todo.add", { title: "S", checklistItems: [ascii(4_001)] }),
    ).toContain("params.checklistItems[0]");
  });

  it("replace-checklist refuses the same count, in both item spellings", () => {
    const titles = Array.from({ length: 101 }, (_, i) => `item ${i}`);
    expect(
      validateOperationParams("todo.replace-checklist", { uuid: "todo-uuid-0001", items: titles }),
    ).toContain("at most 100 items");
    expect(
      validateOperationParams("todo.replace-checklist", {
        uuid: "todo-uuid-0001",
        items: titles.map((title) => ({ title })),
      }),
    ).toContain("at most 100 items");
    expect(
      validateOperationParams("todo.replace-checklist", {
        uuid: "todo-uuid-0001",
        items: [{ title: ascii(4_001) }],
      }),
    ).toContain("params.items[0].title");
  });
});

describe("registry shape", () => {
  it("every spec carries a behavioral description", () => {
    const bare: string[] = [];
    for (const op of OPERATION_KINDS) {
      for (const [field, spec] of Object.entries(PARAM_SCHEMAS[op] as Record<string, FieldSpec>)) {
        if (spec.describe.trim() === "") bare.push(`${op}.${field}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
