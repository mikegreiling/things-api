/**
 * RAWAX1 — the properties the raw-AX port must hold, checked without a GUI.
 *
 * Three of these are rulings rather than preferences, and each one is here
 * because getting it wrong would be invisible until a drive landed a wrong rule:
 *
 *  1. **An absent attribute reads `""`.** A batched
 *     `AXUIElementCopyMultipleAttributeValues` returns an ERROR PLACEHOLDER in
 *     the slot of every attribute the element lacks, and a naive `String()`
 *     renders it `[object NSObject]` — which is what the probe's first cut
 *     printed for the shell's absent `AXTitle` and for the weekday row-add
 *     button, whose `AXTitle` is genuinely not a string (RAWAX1 §6.2). The
 *     AppleScript path maps `missing value` to `""` (`cgTexts`), so the settle's
 *     shape SIGNATURE — the thing BEEP1's two-agreeing-reads gate compares — is
 *     byte-identical only if this one does too.
 *  2. **The commit tag cannot drift.** `ui.ts` and the executor each hold the
 *     literal, because `ui.ts` imports the executor and a cycle is worse; so a
 *     drift test pins them, the way the deputy's banned-phrase list is pinned
 *     across the TS/Swift seam.
 *  3. **Nothing the executor renders may carry a phrase the broker refuses.**
 *     A raw-AX hop is JXA and routes through the deputy like any other script
 *     (#695 is the campaign this port belongs to; its whole lesson was a script
 *     the broker would not take).
 */
import { describe, expect, it } from "vitest";

import { DEPUTY_BANNED_SCRIPT_PHRASES } from "../../src/deputy/protocol.ts";
import { COMMIT_FAILED_TAG } from "../../src/write/vectors/ui.ts";
import { RAWAX_HELPERS, ROW_TOLERANCE_DEFAULT } from "../../src/write/vectors/ui-rawax.ts";
import {
  RAWAX_COMMIT_FAILED_TAG,
  renderRawAxScript,
} from "../../src/write/vectors/ui-rawax-exec.ts";
import {
  ORDINAL_JUSTIFICATIONS,
  parseAxEnvelope,
  type AxOp,
  type AxProgram,
} from "../../src/write/vectors/ui-rawax-ops.ts";

/**
 * `rawStr` as the primitive layer defines it, EXECUTED rather than
 * pattern-matched.
 *
 * The same technique `pointer-gesture-guard.test.ts` uses on
 * `POINTER_GUARD_DECISION_JS`: pull the function's own source out of the shipped
 * string and run it, so the test drives the code that ships instead of a
 * paraphrase of it.
 */
function rawStrFromShippedSource(): (j: unknown) => string {
  const start = RAWAX_HELPERS.indexOf("function rawStr(j){");
  expect(start, "rawStr is not in the shipped helpers").toBeGreaterThanOrEqual(0);
  const end = RAWAX_HELPERS.indexOf("function rawSv(", start);
  const source = RAWAX_HELPERS.slice(start, end);
  return new Function(`${source}; return rawStr`)() as (j: unknown) => string;
}

/**
 * `cgTexts`' contract, in TypeScript: `missing value` becomes "", anything
 * coercible becomes its text. `rawStr` has to agree with this exactly, because
 * the shape SIGNATURE the settle compares is built out of these strings.
 */
function asIfCgTexts(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? "" : String(v);
}

describe("an absent attribute reads as the empty string (RAWAX1 §6.2, ruled)", () => {
  const rawStr = rawStrFromShippedSource();

  it("maps every shape of ABSENT to the empty string", () => {
    // The batched read's placeholder is an ObjC object; `null`/`undefined` are
    // what a per-attribute read gives. All three mean the same thing.
    expect(rawStr(null)).toBe("");
    expect(rawStr(undefined)).toBe("");
    expect(rawStr({})).toBe("");
    expect(rawStr({ toString: () => "[object NSObject]" })).toBe("");
    expect(rawStr([1, 2])).toBe("");
  });

  it("keeps the values a shape signature is BUILT from", () => {
    // A checkbox's value is a number and the audit compares it as "0"/"1"; a
    // label's value is its text. Dropping either would change the signature as
    // surely as rendering an absent one would.
    expect(rawStr("Every")).toBe("Every");
    expect(rawStr("")).toBe("");
    expect(rawStr(0)).toBe("0");
    expect(rawStr(1)).toBe("1");
    expect(rawStr(false)).toBe("false");
  });

  it("is the mapping the AppleScript path makes, so the signature is byte-identical", () => {
    for (const sample of ["Ends:", "", 0, 1, null, undefined, {}]) {
      expect(rawStr(sample)).toBe(asIfCgTexts(sample));
    }
  });
});

describe("the executor's constants cannot drift from the driver's", () => {
  it("uses the SAME commit-failure tag ui.ts discriminates on", () => {
    expect(RAWAX_COMMIT_FAILED_TAG).toBe(COMMIT_FAILED_TAG);
  });

  it("uses the same row tolerance the label-row law was measured against", () => {
    // CGRD1 §A measured a 3–4 pt baseline offset; RAWAX1 §5.1 re-measured the
    // same DELTAS on a sheet at a different origin. 8 is ~2x the worst case.
    expect(ROW_TOLERANCE_DEFAULT).toBe(8);
  });
});

/** A program exercising every op kind, so nothing goes unrendered. */
function everyOpProgram(): AxProgram {
  const ops: AxOp[] = [
    { label: "census", op: "census-shell", expectRoles: true },
    { label: "probe (polling)", op: "probe-shape", tolerance: 8, poll: true },
    { label: "probe (settled)", op: "probe-shape", tolerance: 8, poll: false },
    {
      label: "settle",
      op: "settle-group",
      expect: { fields: null, requiredLabels: ["Every", "Ends:"], forbiddenLabels: [] },
      reads: 40,
      pollMs: 100,
    },
    {
      label: "frequency = weekly",
      op: "select-popup",
      ref: {
        in: "shell",
        role: "AXPopUpButton",
        ordinal: 1,
        because: ORDINAL_JUSTIFICATIONS.frequency,
      },
      titles: ["weekly"],
    },
    {
      label: "Add deadlines",
      op: "ensure-checkbox",
      ref: { in: "shell", role: "AXCheckBox", title: "Add deadlines" },
      target: true,
      attempts: 3,
    },
    {
      label: "interval = 3",
      op: "type-into",
      ref: { field: "group", target: "interval", tolerance: 8 },
      value: "3",
      what: 'type "3" into the interval field',
      attempts: 3,
      unlessPrefilled: "interval",
    },
    {
      label: "start 14 days earlier",
      op: "type-into",
      ref: { field: "shell", rowLabel: "days earlier", tolerance: 8 },
      value: "14",
      what: 'type "14" into the "days earlier" field',
      attempts: 3,
    },
    { label: "weekdays", op: "converge-weekdays", base: 3, titles: ["Monday", "Thursday"] },
    { label: "reminder", op: "set-datetime", target: "reminder", spec: "time:09:00" },
    {
      label: "Next",
      op: "select-occurrence",
      ref: {
        in: "group",
        role: "AXPopUpButton",
        ordinal: 2,
        because: ORDINAL_JUSTIFICATIONS.nextPopup,
      },
      iso: "2026-08-20",
      levels: 6,
      sampleItems: 5,
    },
    {
      label: "verify",
      op: "verify-prefill",
      controls: [
        {
          label: "interval",
          ref: { field: "group", target: "interval", tolerance: 8 },
          kind: "number",
          expected: ["1"],
          prefillKey: "interval",
        },
      ],
    },
    {
      label: "audit",
      op: "audit",
      expect: { fields: 2, requiredLabels: ["Every", "Ends:"], forbiddenLabels: [] },
      controls: [
        {
          label: "frequency",
          ref: {
            in: "shell",
            role: "AXPopUpButton",
            ordinal: 1,
            because: ORDINAL_JUSTIFICATIONS.frequency,
          },
          kind: "popup",
          expected: ["weekly"],
        },
        {
          label: "the reminder time",
          ref: { dateArea: "reminder" },
          kind: "date-area",
          expected: ["9:00"],
          spec: "time:09:00",
        },
      ],
      commit: { in: "shell", role: "AXButton", title: "OK" },
    },
  ];
  return { shellIndex: 0, shape: "next-popup", ops };
}

describe("the rendered executor", () => {
  const script = renderRawAxScript(everyOpProgram());

  it("carries no phrase the deputy's broker refuses", () => {
    // #695's whole lesson: a script that the broker will not take is a script
    // that fails on every routed Mac while every lab arm stays green.
    const lowered = script.toLowerCase();
    for (const phrase of DEPUTY_BANNED_SCRIPT_PHRASES) expect(lowered).not.toContain(phrase);
  });

  it("carries the program as DATA, not as generated code", () => {
    // The transport-agnostic claim in one assertion: the ops round-trip through
    // JSON, so a deputy-side executor could be handed the identical bytes.
    const match = /var RAWAX_PROGRAM = (\{.*?\});\n/s.exec(script);
    expect(match).not.toBeNull();
    const program = JSON.parse(match?.[1] ?? "null") as AxProgram;
    expect(program.ops).toHaveLength(everyOpProgram().ops.length);
    expect(program.shape).toBe("next-popup");
  });

  it("carries the measured justification for every ordinal address", () => {
    // The positional fence, as data: an ordinal that reaches the executor
    // without its evidence is one nobody can review.
    const match = /var RAWAX_PROGRAM = (\{.*?\});\n/s.exec(script);
    const program = JSON.parse(match?.[1] ?? "null") as AxProgram;
    const refs: unknown[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value === null || typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      if (typeof rec["ordinal"] === "number") refs.push(rec);
      Object.values(rec).forEach(walk);
    };
    walk(program.ops);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const because = (ref as { because?: string }).because ?? "";
      expect(because, `an ordinal address shipped with no justification`).toContain(
        "positional-ok:",
      );
    }
  });

  it("asserts the frontmost application before it types, and never before it reads", () => {
    const firstAssert = script.indexOf("rawAssertFront(");
    const firstPost = script.search(/CGEventPost\(/);
    expect(firstAssert).toBeGreaterThanOrEqual(0);
    expect(firstAssert).toBeLessThan(firstPost);
  });

  it("refuses a non-digit value rather than typing part of it", () => {
    // The executor's typing path is numeric-only by design; a partial type would
    // leave a number nobody asked for that the read-back would faithfully confirm.
    expect(script).toContain("is not a number, and this field takes only digits");
  });
});

describe("the envelope parser", () => {
  it("reads a well-formed envelope", () => {
    const env = parseAxEnvelope(
      JSON.stringify({
        ok: true,
        ops: [
          { label: "a", op: "census-shell", durationMs: 1, axCalls: 2, axElems: 0, verdict: "ok" },
        ],
        axCalls: 2,
        axElems: 0,
        shape: "next-popup",
        confirmed: ["interval"],
      }),
    );
    expect(env?.ok).toBe(true);
    expect(env?.ops).toHaveLength(1);
    expect(env?.shape).toBe("next-popup");
    expect(env?.confirmed).toEqual(["interval"]);
  });

  it("returns null for anything that is not one, rather than half-reading it", () => {
    // A caller that got something else falls back to its own wording; inventing
    // a verdict from a partial structure is how a refusal stops being true.
    expect(parseAxEnvelope("")).toBeNull();
    expect(parseAxEnvelope("OK")).toBeNull();
    expect(parseAxEnvelope("{}")).toBeNull();
    expect(parseAxEnvelope('{"ok":true}')).toBeNull();
    expect(parseAxEnvelope('{"ops":[]}')).toBeNull();
    expect(parseAxEnvelope("not json at all")).toBeNull();
  });

  it("keeps a refusal's sentence and the op it failed at", () => {
    const env = parseAxEnvelope(
      JSON.stringify({
        ok: false,
        detail: "the Repeat dialog does not hold what this drive entered",
        failedAt: "audit",
        ops: [],
        axCalls: 9,
        axElems: 3,
      }),
    );
    expect(env?.ok).toBe(false);
    expect(env?.detail).toContain("does not hold what this drive entered");
    expect(env?.failedAt).toBe("audit");
  });
});

/**
 * THE TWO DEFECTS THE FIELD-SHAPED ARM FOUND (RAWAX1 phase 2, run 1).
 *
 * Both were invisible to every suite that existed when they shipped, and the
 * reason is the same in each case: a unit test renders ONE program and reads its
 * text, while a drive runs a SEQUENCE of them against a live app. These two cells
 * are the cheapest available stand-ins for that — they assert the properties the
 * chained hops depend on, which is as close as a mock can get to the thing the
 * guest measured.
 */
describe("the defects the routed arm caught", () => {
  it("seeds the shape from the PROGRAM, so a hop with no probe inherits it", () => {
    // Defect 2: RAWAX_SHAPE is per-SCRIPT, so the committing tail — which holds
    // the occurrence pick and the audit, both shape-forked, and no probe —
    // started at null and refused every onlyShape op with the recipe-bug
    // sentence. True of that script, false of the drive: node measured the shape
    // one hop earlier and passed it in.
    const script = renderRawAxScript({
      shellIndex: 0,
      shape: "next-popup",
      ops: [{ label: "audit", op: "audit", controls: [], expect: null, commit: null }],
    });
    // The program carries it…
    expect(script).toContain('"shape":"next-popup"');
    // …and the interpreter SEEDS from it rather than starting at null.
    expect(script).toContain("RAWAX_PROGRAM.shape === 'next-popup'");
    expect(script).toMatch(/RAWAX_SHAPE = RAWAX_PROGRAM\.shape/);
  });

  it("asks for focus the canonical way, and proves it the way the app answers", () => {
    // Defect 1: writing the ELEMENT's AXFocused returns AXError 0 and reads back
    // FALSE, every time — so a loop that proves focus by that flag alone can
    // never type, and every raw drive refused with FGRD1's sentence. The fix
    // asks the APPLICATION's kAXFocusedUIElement (the canonical spelling) and
    // accepts either answer as proof.
    const script = renderRawAxScript(everyOpProgram());
    expect(script).toContain("rawSet(RAWAX_APP, 'AXFocusedUIElement', el)");
    // Both proofs, and the element flag is still asked for.
    expect(script).toContain("function rawFocusProven(el)");
    expect(script).toContain("rawSetBool(el, 'AXFocused', true)");
    // Nothing is typed without one of them answering — the property that makes
    // the retry safe, and the one the fix must not have widened away.
    const loop = script.slice(script.indexOf("function opTypeInto"));
    const proveAt = loop.indexOf("gotFocus = rawFocusProven(tf)");
    const typeAt = loop.indexOf("rawType(v, o.what)");
    expect(proveAt).toBeGreaterThanOrEqual(0);
    expect(typeAt).toBeGreaterThan(proveAt);
    expect(loop).toContain("if (gotFocus){");
  });
});
