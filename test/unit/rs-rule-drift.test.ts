/**
 * Row-shaping-rule drift lock.
 *
 * The RS1–RS8 row-shaping rules are stated in TWO living docs that must never
 * disagree: `docs/contract.md` (the consumer covenant — the one-line summaries)
 * and `docs/design/contracts.md` (the authoritative statements + code paths +
 * edge cases). The two hold near-duplicate prose, which rots the moment someone
 * edits one file and forgets the other. This lock — modeled on the banned-vocab
 * / README-contract style (a doc-content assertion re-derived from the files,
 * tolerant of prose reflow) — pins the two into sync at the rule-SET level:
 *
 *   1. Both files declare the SAME set of RS numbers (no rule added/dropped in
 *      one without the other).
 *   2. Each rule's one-line **bold summary** (the text between `**RS<n> — ` and
 *      the closing `.**`) is byte-identical between the files.
 *
 * The lock deliberately covers the number-set + the summary line ONLY — the
 * bodies below each header may differ in depth (the covenant is terse; the
 * design doc is exhaustive). Anchor: the `**RS<n> — ….**` bold headers.
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

/** The two files whose RS-rule statements must stay in lockstep. */
const CONTRACT = readFileSync(new URL("../../docs/contract.md", import.meta.url), "utf8");
const DESIGN_CONTRACTS = readFileSync(
  new URL("../../docs/design/contracts.md", import.meta.url),
  "utf8",
);

/**
 * Extract every `**RS<n> — <summary>.**` bold header into a map of
 * n → summary. The `[^*]+` stops the summary at the closing `**`, so the em-dash
 * separator (` — `) is what distinguishes a real rule header from the reshape
 * sub-headers (`**RS5 view-card reshape …**`, no em-dash) that share the digit.
 */
function extractRsSummaries(md: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of md.matchAll(/\*\*RS(\d+) — ([^*]+?)\.\*\*/g)) {
    const n = Number(m[1]);
    const summary = m[2]!.trim();
    // A malformed duplicate anchor (same number, different summary) is itself a
    // drift the lock should surface loudly rather than silently overwrite.
    if (out.has(n) && out.get(n) !== summary) {
      throw new Error(`RS${n} declared twice with differing summaries in one file`);
    }
    out.set(n, summary);
  }
  return out;
}

describe("RS row-shaping-rule drift lock", () => {
  const covenant = extractRsSummaries(CONTRACT);
  const design = extractRsSummaries(DESIGN_CONTRACTS);

  it("both files declare a non-empty RS rule set", () => {
    expect(covenant.size).toBeGreaterThan(0);
    expect(design.size).toBe(covenant.size);
  });

  it("the two files declare the SAME set of RS numbers", () => {
    const covNums = [...covenant.keys()].toSorted((a, b) => a - b);
    const desNums = [...design.keys()].toSorted((a, b) => a - b);
    expect(covNums).toEqual(desNums);
  });

  it("declares a contiguous RS1..RSn set (no gaps, no phantom numbers)", () => {
    const nums = [...design.keys()].toSorted((a, b) => a - b);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it("each rule's one-line bold summary is identical between the two files", () => {
    for (const [n, summary] of design) {
      expect(covenant.get(n), `RS${n} present in design contracts but not the covenant`).toBe(
        summary,
      );
    }
  });
});
