/**
 * Final-answer extraction fairness: fenced JSON preferred, bare-JSON message
 * accepted as a fallback (batch loop-cli-r2 refutation: a substantively
 * correct bare-object reply was zeroed purely on fence formatting).
 */
import { describe, expect, it } from "vitest";

import { parseFinalAnswer } from "../../bench/grade.ts";

describe("parseFinalAnswer", () => {
  it("prefers the last fenced json block", () => {
    const text = 'ignore\n```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```\n';
    expect(parseFinalAnswer(text)).toEqual({ a: 2 });
  });

  it("falls back to any fence when no json-tagged fence parses", () => {
    const text = 'prose\n```\n{"b":3}\n```\n';
    expect(parseFinalAnswer(text)).toEqual({ b: 3 });
  });

  it("accepts a bare-JSON message when no fence exists", () => {
    expect(parseFinalAnswer('{"section":"evening"}')).toEqual({ section: "evening" });
    expect(parseFinalAnswer('  {"found":true,\n "title":"X"}  ')).toEqual({
      found: true,
      title: "X",
    });
  });

  it("returns undefined for prose with neither fence nor bare JSON", () => {
    expect(parseFinalAnswer("The item is in the evening section.")).toBeUndefined();
    expect(parseFinalAnswer(null)).toBeUndefined();
  });
});
