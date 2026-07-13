/**
 * The period grammar helpers that back the read views' `--since`/`--until`
 * bounds. Here: {@link doublePeriod}, the dumb count-doubler behind the
 * upcoming "wider window" suggestion.
 */
import { describe, expect, it } from "vitest";

import { doublePeriod } from "../../src/cli/period.ts";

describe("doublePeriod", () => {
  it("doubles the count of a relative period, unit preserved", () => {
    expect(doublePeriod("1m")).toBe("2m");
    expect(doublePeriod("2w")).toBe("4w");
    expect(doublePeriod("1y")).toBe("2y");
    expect(doublePeriod("3d")).toBe("6d");
  });

  it("normalizes the unit to lower case and trims", () => {
    expect(doublePeriod("2W")).toBe("4w");
    expect(doublePeriod("  1m  ")).toBe("2m");
  });

  it("leaves an absolute calendar period unchanged — nothing to double", () => {
    expect(doublePeriod("2026-09")).toBe("2026-09");
    expect(doublePeriod("2026")).toBe("2026");
    expect(doublePeriod("2026-09-15")).toBe("2026-09-15");
  });
});
