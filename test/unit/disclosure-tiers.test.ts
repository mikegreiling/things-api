/**
 * THE TIER CLASSIFICATION LAW (#632).
 *
 * The value of splitting `warnings` into `warnings` + `notes` is entirely in the
 * classification being EXHAUSTIVE and STABLE. A disclosure that slips out of a
 * producer as a bare string — pushed onto an array by hand, the way every one of
 * these used to be written — is unclassified by construction, and the split
 * silently stops meaning anything.
 *
 * So this file holds two kinds of test:
 *  1. PRODUCER COMPLETENESS — a source-level sweep asserting that no write-layer
 *     producer still hand-builds a tier array, i.e. every disclosure goes
 *     through {@link disclose} and therefore through the registry.
 *  2. REGISTRY SHAPE — every entry carries a real tier and a rationale, the
 *     tiers partition cleanly, and `failure-only` never reaches a success bag.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DISCLOSURES,
  attach,
  carry,
  disclose,
  disclosuresOf,
  newDisclosures,
  tiers,
  type DisclosureId,
} from "../../src/write/disclosures.ts";

const WRITE_DIR = new URL("../../src/write/", import.meta.url).pathname;

/** Every `.ts` file under src/write (recursively) — the whole producer surface. */
function writeLayerFiles(dir: string = WRITE_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...writeLayerFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Every registered id of one tier. */
function idsOfTier(tier: string): DisclosureId[] {
  return (Object.keys(DISCLOSURES) as DisclosureId[]).filter((id) => DISCLOSURES[id].tier === tier);
}

describe("the disclosure registry is the classification law", () => {
  it("every entry names a real tier and says WHY that tier", () => {
    const ids = Object.keys(DISCLOSURES) as DisclosureId[];
    expect(ids.length).toBeGreaterThan(20); // a real registry, not a stub
    for (const id of ids) {
      const spec = DISCLOSURES[id];
      expect(["warning", "note", "failure-only"], `${id} tier`).toContain(spec.tier);
      // The rationale is the thing that keeps the classification from drifting
      // under a later edit — an empty or token one defeats the whole registry.
      expect(spec.why.length, `${id} rationale`).toBeGreaterThan(30);
    }
  });

  it("both success tiers are populated — the split is real, not a rename", () => {
    expect(idsOfTier("warning").length).toBeGreaterThan(5);
    expect(idsOfTier("note").length).toBeGreaterThan(5);
  });

  it("the step trace is the ONLY failure-only disclosure", () => {
    expect(idsOfTier("failure-only")).toEqual(["ui-step-trace"]);
  });
});

describe("PRODUCER COMPLETENESS — no write-layer producer hand-builds a tier array", () => {
  // The shapes that USED to build a disclosure array by hand. Each is now a
  // classification hole if it reappears: a string reaching a result without
  // passing the registry.
  const HAND_BUILT = [
    /warnings:\s*\[/, // `warnings: [ ... ]` literal on a result
    /notes:\s*\[/, // ditto for the new tier
    /\bwarnings\.push\(/, // building the old flat array
    /\bnotes\.push\(/,
  ];

  /**
   * Two modules own a DIFFERENT `notes` that is not a mutation-result tier and
   * must not be dragged into the registry:
   *  - `undo.ts` — `UndoPlan.notes`, the fidelity caveats of a PLAN (what the
   *    inverse cannot restore). A plan is not a result and carries no tiers.
   *  - `move.ts` — a local array of per-scope placement lines, joined into the
   *    move result's single `note` string.
   * The `warnings` patterns still apply to both: that name means exactly one
   * thing in this codebase, so it is checked EVERYWHERE with no exemption.
   */
  const NOTES_NAME_COLLISION = new Set(["undo.ts", "move.ts"]);

  it("every src/write file routes its disclosures through disclose()", () => {
    const offenders: string[] = [];
    for (const path of writeLayerFiles()) {
      // The registry module itself legitimately names the arrays — it IS the
      // implementation of the two tiers.
      if (path.endsWith("disclosures.ts")) continue;
      const relative = path.slice(WRITE_DIR.length);
      const patterns = NOTES_NAME_COLLISION.has(relative)
        ? HAND_BUILT.filter((re) => re.source.includes("warnings"))
        : HAND_BUILT;
      const source = readFileSync(path, "utf8");
      for (const [i, line] of source.split("\n").entries()) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
        if (patterns.some((re) => re.test(line))) {
          offenders.push(`${relative}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      "these lines build a disclosure array by hand — route them through disclose(bag, <id>, text) " +
        "so the tier is decided in src/write/disclosures.ts and stays auditable in one place",
    ).toEqual([]);
  });
});

describe("the bag routes each id to its registered tier", () => {
  it("a warning id lands in warnings, a note id in notes", () => {
    const bag = newDisclosures();
    disclose(bag, "promote-placement", "reposition it"); // registry: warning
    disclose(bag, "landed-rule", "repeats weekly"); // registry: note
    expect(bag.warnings).toEqual(["reposition it"]);
    expect(bag.notes).toEqual(["repeats weekly"]);
  });

  it("empty text is dropped rather than emitted as a blank line", () => {
    const bag = newDisclosures();
    disclose(bag, "landed-rule", "");
    expect(tiers(bag)).toEqual({});
  });

  it("omit-when-empty: neither tier is ever projected as []", () => {
    expect(tiers(newDisclosures())).toEqual({});
    const oneSided = newDisclosures();
    disclose(oneSided, "landed-rule", "a note");
    expect(tiers(oneSided)).toEqual({ notes: ["a note"] });
    expect("warnings" in tiers(oneSided)).toBe(false);
  });

  it("carry folds a leg's ALREADY-TIERED disclosures without reclassifying them", () => {
    const outer = newDisclosures();
    disclose(outer, "promote-placement", "outer warning");
    carry(outer, { warnings: ["leg warning"], notes: ["leg note"] });
    expect(outer.warnings).toEqual(["outer warning", "leg warning"]);
    expect(outer.notes).toEqual(["leg note"]);
  });

  it("attach REPLACES both keys, so folding a leg cannot strand a stale array", () => {
    const stale = { op: "x", warnings: ["old"], notes: ["older"] };
    const bag = disclosuresOf(stale);
    disclose(bag, "landed-rule", "fresh");
    const out = attach(stale, bag);
    expect(out.warnings).toEqual(["old"]);
    expect(out.notes).toEqual(["older", "fresh"]);
  });
});
