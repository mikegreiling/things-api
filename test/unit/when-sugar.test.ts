import { describe, expect, it } from "vitest";

import { CLI_WHEN_LABELS, MCP_WHEN_LABELS, splitWhenSugar } from "../../src/model/when-sugar.ts";

describe("splitWhenSugar (shared <when>@<time> parser)", () => {
  it("passes a suffix-free when through unchanged", () => {
    expect(splitWhenSugar("2026-07-05", false)).toEqual({ kind: "unchanged" });
    expect(splitWhenSugar("today", false)).toEqual({ kind: "unchanged" });
    expect(splitWhenSugar(undefined, false)).toEqual({ kind: "unchanged" });
  });

  it("splits DATE@TIME into when + reminder", () => {
    expect(splitWhenSugar("2026-07-05@09:00", false)).toEqual({
      kind: "split",
      when: "2026-07-05",
      reminder: "09:00",
    });
    expect(splitWhenSugar("today@18:30", false)).toEqual({
      kind: "split",
      when: "today",
      reminder: "18:30",
    });
  });

  it("rejects a malformed suffix with the CLI copy by default", () => {
    const r = splitWhenSugar("2026-07-05@", false);
    expect(r).toEqual({
      kind: "error",
      message:
        'invalid --when "2026-07-05@" — expected today | evening | anytime | someday | YYYY-MM-DD (set a reminder with --reminder HH:mm)',
    });
    expect(splitWhenSugar("@09:00", false).kind).toBe("error");
    expect(splitWhenSugar("a@b@c", false).kind).toBe("error");
  });

  it("rejects a suffix alongside a separately-provided reminder", () => {
    expect(splitWhenSugar("2026-07-05@09:00", true)).toEqual({
      kind: "error",
      message:
        '--when "2026-07-05@09:00" carries an @time suffix and --reminder was also given — use one',
    });
  });

  it("uses the MCP parameter labels when asked", () => {
    expect(splitWhenSugar("2026-07-05@", false, MCP_WHEN_LABELS)).toEqual({
      kind: "error",
      message:
        'invalid when "2026-07-05@" — expected today | evening | anytime | someday | YYYY-MM-DD (set a reminder with reminder HH:mm)',
    });
    expect(splitWhenSugar("today@09:00", true, MCP_WHEN_LABELS)).toEqual({
      kind: "error",
      message: 'when "today@09:00" carries an @time suffix and reminder was also given — use one',
    });
  });

  it("CLI labels are the default", () => {
    expect(splitWhenSugar("x@", false)).toEqual(splitWhenSugar("x@", false, CLI_WHEN_LABELS));
  });
});
