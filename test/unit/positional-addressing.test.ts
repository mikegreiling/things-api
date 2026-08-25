/**
 * NO BARE POSITIONAL FIELD ADDRESSING in the ui vector (CGRD1 guard 1).
 *
 * Things' Accessibility tree is an undocumented private surface: it may be
 * re-laid-out in any release, with no notice and no version signal. #589 is what
 * that costs when a value-bearing control is addressed by its INDEX — the Repeat
 * dialog INSERTS the ends-count field ahead of the interval as soon as an ends
 * bound is selected, so `text field 1 of group 1` was the interval at one moment
 * and the count at the next. The drive wrote the requested interval into the
 * count, and the step's read-back reported OK because it re-read the field it had
 * addressed. A self-referential check cannot see a wrong address.
 *
 * The rule this test enforces: every `<class> <N>` selector in the ui vector's
 * source either carries a `// positional-ok:` marker giving the MEASURED reason it
 * is safe, or it does not ship. The marker is a claim about structure that somebody
 * measured, not a silencer — a new one should name what was measured and where.
 * A new address gets no marker by accident, so this test is what makes adding one
 * a deliberate act.
 *
 * Scope: the classes that either BEAR a value or are the container path to one.
 * `menu`/`menu bar`/`menu item` are excluded — a menu drive clicks an item matched
 * by its pinned English name, so a mis-addressed menu has no such item and fails
 * closed rather than writing something plausible.
 *
 * Precedent for the shape of this test: test/unit/import-boundary.test.ts (static
 * source scan) and the banned-vocabulary copy tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const VECTORS = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/write/vectors");
const FILES = ["ui-recipes.ts", "ui.ts", "ui-drag.ts"];

/** The marker a justified positional address must carry. */
const MARKER = "positional-ok:";

/**
 * AX element classes whose positional form is fenced. Longest-first so
 * `pop up button 3` is reported as a pop-up rather than as a bare `button`.
 */
const CLASSES = [
  "pop up button",
  "radio button",
  "static text",
  "scroll area",
  "text field",
  "text area",
  "UI element",
  "checkbox",
  "window",
  "table",
  "sheet",
  "group",
  "row",
  "cell",
];

const PATTERN = new RegExp(String.raw`\b(${CLASSES.join("|")})\s+(\d+)\b`, "g");

/**
 * Is this a comment line? Both JavaScript comments and the AppleScript `--`
 * comments that live inside the script template literals count — a marker may be
 * written in either, since the addresses live in both.
 */
function isComment(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--") || t === ""
  );
}

/**
 * The justification covering `index`: the marker must sit on the offending line
 * itself, or in the unbroken comment block immediately above it. Deliberately
 * strict — a marker further away could silently come to cover an address added
 * beneath it later.
 */
function justified(lines: string[], index: number): boolean {
  if ((lines[index] ?? "").includes(MARKER)) return true;
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (!isComment(line)) return false;
    if (line.includes(MARKER)) return true;
  }
  return false;
}

describe("ui vector: positional element addressing is fenced (CGRD1)", () => {
  for (const file of FILES) {
    it(`${file} has no unjustified positional address`, () => {
      const lines = readFileSync(join(VECTORS, file), "utf8").split("\n");
      const violations: string[] = [];
      lines.forEach((line, i) => {
        // Prose in a comment is not an address; only real code is scanned. (A
        // marker itself lives in a comment, which is why justified() reads them.)
        if (isComment(line)) return;
        for (const m of line.matchAll(PATTERN)) {
          if (justified(lines, i)) continue;
          violations.push(
            `${file}:${i + 1}: \`${m[1]} ${m[2]}\` is addressed by position. ` +
              `Give it a discriminated address (a label row / AXIdentifier / exact ` +
              `description, fail-closed on anything but one match), or add a ` +
              `\`// ${MARKER} <measured reason>\` comment on this line or directly above it.`,
          );
        }
      });
      expect(violations).toEqual([]);
    });
  }

  it("the scanner actually catches a bare positional field", () => {
    // A guard whose detector is broken is worse than no guard: it reports green
    // forever. Prove the pattern + the justification rule both fire.
    const bare = ["const X = `text field 1 of group 1`;"];
    expect([...(bare[0] as string).matchAll(PATTERN)].length).toBe(2);
    expect(justified(bare, 0)).toBe(false);
    const marked = ["// positional-ok: measured sole field", "const X = `text field 1`;"];
    expect(justified(marked, 1)).toBe(true);
    const inline = ["const X = `text field 1`; // positional-ok: measured sole field"];
    expect(justified(inline, 0)).toBe(true);
    // A marker separated from the address by code does NOT cover it.
    const detached = ["// positional-ok: measured", "const A = 1;", "const B = `text field 1`;"];
    expect(justified(detached, 2)).toBe(false);
  });
});
