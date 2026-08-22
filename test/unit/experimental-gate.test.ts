/**
 * The private reorder command's availability gates. The sdef canary is a
 * DECLARATION check; Things 3.23 kept the declaration and stopped applying the
 * command (GV4, docs/lab/gv4-323-campaign.md §3.1), so a VERSION gate stands in
 * front of it until the behavioral canary exists.
 */
import { describe, expect, it } from "vitest";

import {
  compareAppVersions,
  PRIVATE_REORDER_NO_OP_FROM,
  privateReorderIsNoOp,
  sdefDeclaresPrivateReorder,
} from "../../src/write/experimental.ts";

describe("compareAppVersions", () => {
  it("orders dotted marketing versions of unequal segment counts", () => {
    expect(compareAppVersions("3.22.14", "3.23")).toBe(-1);
    expect(compareAppVersions("3.23", "3.23")).toBe(0);
    expect(compareAppVersions("3.23.1", "3.23")).toBe(1);
    expect(compareAppVersions("4.0", "3.23")).toBe(1);
    expect(compareAppVersions("3.9", "3.23")).toBe(-1); // numeric, not lexical
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareAppVersions("3.23", "3.23.0")).toBe(0);
    expect(compareAppVersions("3.23.0.0", "3.23")).toBe(0);
  });

  it("tolerates a trailing suffix and refuses a non-numeric stamp", () => {
    expect(compareAppVersions("3.23 (32300036)", "3.23")).toBe(0);
    expect(compareAppVersions("unknown", "3.23")).toBeNull();
    expect(compareAppVersions(null, "3.23")).toBeNull();
  });
});

describe("privateReorderIsNoOp (the GV4 version gate)", () => {
  it("gates 3.23 and later", () => {
    expect(privateReorderIsNoOp(PRIVATE_REORDER_NO_OP_FROM)).toBe(true);
    expect(privateReorderIsNoOp("3.23")).toBe(true);
    expect(privateReorderIsNoOp("3.23.1")).toBe(true);
    expect(privateReorderIsNoOp("4.0")).toBe(true);
  });

  it("leaves every pre-3.23 version alone", () => {
    expect(privateReorderIsNoOp("3.22.14")).toBe(false);
    expect(privateReorderIsNoOp("3.22.11")).toBe(false);
    expect(privateReorderIsNoOp("2.99")).toBe(false);
  });

  it("does NOT gate an unknown or unreadable version (canary-only, as before)", () => {
    expect(privateReorderIsNoOp(null)).toBe(false);
    expect(privateReorderIsNoOp("")).toBe(false);
    expect(privateReorderIsNoOp("unknown")).toBe(false);
  });
});

describe("sdefDeclaresPrivateReorder", () => {
  it("is false when the Resources directory cannot be read", () => {
    expect(sdefDeclaresPrivateReorder("/nonexistent/things-api-test/Resources")).toBe(false);
  });
});
