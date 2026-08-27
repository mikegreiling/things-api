/**
 * The measured field ceilings (#621, NOTECAP1) and the counters that read a
 * value in the app's own units.
 *
 * The numbers here are the LAB's, not this file's: `docs/lab/notecap1-notes-ceiling.md`
 * holds the cells that produced them (Things 3.23 / golden `things-lab-golden-v4`).
 * These tests lock the boundary arithmetic — below / at / above each ceiling,
 * in each payload class whose byte : scalar : UTF-16 : cluster ratios differ.
 */
import { describe, expect, it } from "vitest";

import {
  CHECKLIST_MAX_ITEMS,
  NOTES_LIMITS,
  TITLE_LIMITS,
  countGraphemes,
  describeTruncation,
  fieldLengthRefusal,
} from "../../src/write/field-limits.ts";

/** 1 byte : 1 scalar : 1 UTF-16 unit : 1 cluster. */
const ascii = (n: number): string => "x".repeat(n);
/** 4 bytes : 1 scalar : 2 UTF-16 units : 1 cluster. */
const emoji = (n: number): string => "\u{1F600}".repeat(n);
/** 3 bytes : 2 scalars : 2 UTF-16 units : 1 cluster. */
const combining = (n: number): string => "é".repeat(n);
/** 25 bytes : 7 scalars : 11 UTF-16 units : 1 cluster. */
const family = (n: number): string => "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(n);

describe("countGraphemes — the unit Things cuts notes by", () => {
  it("counts one cluster per ASCII character", () => {
    expect(countGraphemes(ascii(10_000))).toBe(10_000);
  });

  it("counts an astral emoji as ONE, not the two UTF-16 units it occupies", () => {
    expect(emoji(500)).toHaveLength(1000);
    expect(countGraphemes(emoji(500))).toBe(500);
  });

  it("counts a base + combining mark as ONE, not two scalars", () => {
    expect(countGraphemes(combining(500))).toBe(500);
  });

  it("counts a ZWJ emoji family, a flag and a skin-tone modifier as ONE each", () => {
    expect(countGraphemes(family(3))).toBe(3);
    expect(countGraphemes("\u{1F1FA}\u{1F1F3}".repeat(4))).toBe(4);
    expect(countGraphemes("\u{1F44D}\u{1F3FD}".repeat(4))).toBe(4);
  });

  it("counts CR LF as ONE — the fast path must not treat it as two", () => {
    expect(countGraphemes("a\r\nb")).toBe(3);
    expect(countGraphemes("\r\n".repeat(100))).toBe(100);
  });

  it("agrees with the fast path on printable ASCII, tabs and newlines", () => {
    const mixed = "line one\n\tline two\n";
    expect(countGraphemes(mixed)).toBe(mixed.length);
  });
});

const refuseNotes = (v: string): string | null =>
  fieldLengthRefusal("params.notes", v, NOTES_LIMITS);
const refuseTitle = (v: string): string | null =>
  fieldLengthRefusal("params.title", v, TITLE_LIMITS);

describe("notes — 10,000 clusters AND 40,000 UTF-16 units", () => {
  const refuse = refuseNotes;

  it("accepts exactly 10,000 ASCII characters and refuses 10,001", () => {
    expect(refuse(ascii(9_999))).toBeNull();
    expect(refuse(ascii(10_000))).toBeNull();
    expect(refuse(ascii(10_001))).toContain("params.notes");
    expect(refuse(ascii(10_001))).toContain("at most 10,000 characters");
    expect(refuse(ascii(10_001))).toContain("received 10,001");
  });

  it("measures emoji in CLUSTERS, so 10,000 emoji fit though they are 20,000 units", () => {
    expect(emoji(10_000)).toHaveLength(20_000);
    expect(refuse(emoji(10_000))).toBeNull();
    expect(refuse(emoji(10_001))).toContain("received 10,001");
  });

  it("measures combining pairs in CLUSTERS, so 10,000 pairs fit", () => {
    expect(refuse(combining(10_000))).toBeNull();
    expect(refuse(combining(10_001))).toContain("received 10,001");
  });

  it("refuses a cluster-legal body that overruns the 40,000-unit ceiling", () => {
    // 3,637 families are only 3,637 clusters — a third of the cluster ceiling —
    // but 40,007 UTF-16 units, and the unit ceiling is what the app actually cut
    // this payload at (NOTECAP1 G-ZWJ, which landed exactly 40,000 units).
    expect(countGraphemes(family(3_637))).toBe(3_637);
    expect(family(3_637)).toHaveLength(40_007);
    const detail = refuse(family(3_637));
    expect(detail).toContain("at most 40,000 UTF-16 code units");
    expect(detail).toContain("received 40,007");
    // One family fewer is 39,996 units — under both ceilings.
    expect(family(3_636)).toHaveLength(39_996);
    expect(refuse(family(3_636))).toBeNull();
  });

  it("says what the app would have done, so the refusal is not mistaken for policy", () => {
    expect(refuse(ascii(20_000))).toContain("truncated prefix");
    expect(refuse(ascii(20_000))).toContain("nothing was sent");
  });
});

describe("titles and names — 4,000 UTF-16 code units", () => {
  const refuse = refuseTitle;

  it("accepts exactly 4,000 ASCII characters and refuses 4,001", () => {
    expect(refuse(ascii(3_999))).toBeNull();
    expect(refuse(ascii(4_000))).toBeNull();
    expect(refuse(ascii(4_001))).toContain("at most 4,000 UTF-16 code units");
    expect(refuse(ascii(4_001))).toContain("received 4,001");
  });

  it("measures emoji in UTF-16 UNITS, not clusters — 2,000 emoji is already 4,000", () => {
    expect(refuse(emoji(2_000))).toBeNull();
    expect(refuse(emoji(2_001))).toContain("received 4,002");
  });
});

describe("checklist items — 100 per dispatch", () => {
  it("is the measured cap, identical on add, update and the json batch", () => {
    expect(CHECKLIST_MAX_ITEMS).toBe(100);
  });
});

describe("describeTruncation — reading a mismatch as a partial landing", () => {
  it("names the truncation when the stored value is a strict prefix", () => {
    const detail = describeTruncation("notes", ascii(12_027), ascii(10_000));
    expect(detail).toContain("TRUNCATED");
    expect(detail).toContain("10,000 of the 12,027");
    expect(detail).toContain("partial value");
  });

  it("stays silent when the values simply differ", () => {
    expect(describeTruncation("title", "New", "Wrong")).toBeNull();
    expect(describeTruncation("notes", "abc", "abcdef")).toBeNull();
    expect(describeTruncation("notes", "abc", "abc")).toBeNull();
  });

  it("stays silent for an empty observed value — that is a no-op, not a cut", () => {
    expect(describeTruncation("notes", "abc", "")).toBeNull();
  });

  it("stays silent for non-string fields", () => {
    expect(describeTruncation("index", 3, 1)).toBeNull();
    expect(describeTruncation("notes", "abc", null)).toBeNull();
  });
});
