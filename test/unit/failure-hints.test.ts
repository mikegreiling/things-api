/**
 * Failure attribution tables: consent-failure signatures and verification
 * no-op theories, with the environment tuple sharpening the hints.
 */
import { describe, expect, it } from "vitest";

import { classifyTransportFailure, classifyVerifyFailure } from "../../src/write/failure-hints.ts";
import type { EnvironmentChange } from "../../src/write/environment.ts";

const THINGS_UPDATED: EnvironmentChange[] = [
  { field: "thingsVersion", from: "3.22.11", to: "3.22.12" },
];

describe("classifyTransportFailure", () => {
  it("maps AppleEvent -1743 to permission-denied", () => {
    const hint = classifyTransportFailure({
      vector: "applescript",
      stderr: "execution error: Not authorized to send Apple events to Things3. (-1743)",
      timedOut: false,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("permission-denied");
    expect(hint?.hint).toContain("Automation");
  });

  it("maps a transport deadline kill to permission-pending", () => {
    const hint = classifyTransportFailure({
      vector: "applescript",
      stderr: "",
      timedOut: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("permission-pending");
    expect(hint?.hint).toContain("consent dialog");
  });

  it("maps AppleEvent -1712 (event timed out) to permission-pending", () => {
    const hint = classifyTransportFailure({
      vector: "applescript",
      stderr: "execution error: Things3 got an error: AppleEvent timed out. (-1712)",
      timedOut: false,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("permission-pending");
  });

  it("mentions the environment change when one exists", () => {
    const hint = classifyTransportFailure({
      vector: "applescript",
      stderr: "",
      timedOut: true,
      environmentChanges: THINGS_UPDATED,
    });
    expect(hint?.hint).toContain("Things changed (3.22.11 → 3.22.12)");
  });

  it("returns null for an unrecognized transport failure", () => {
    expect(
      classifyTransportFailure({
        vector: "applescript",
        stderr: "some other error",
        timedOut: false,
        environmentChanges: [],
      }),
    ).toBeNull();
  });

  it("does not read -1743 semantics into url-scheme failures", () => {
    expect(
      classifyTransportFailure({
        vector: "url-scheme",
        stderr: "-1743",
        timedOut: false,
        environmentChanges: [],
      }),
    ).toBeNull();
  });
});

describe("classifyVerifyFailure", () => {
  it("silent no-op on url-scheme with the setting OFF on disk → feature-disabled", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlSchemeEnabled: false,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
    expect(hint?.hint).toContain("Enable Things URLs");
  });

  it("timeout on url-scheme with the setting OFF → feature-disabled (the write is held behind the enable dialog)", () => {
    const hint = classifyVerifyFailure({
      reason: "timeout",
      vector: "url-scheme",
      urlSchemeEnabled: false,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
  });

  it("an unknown on-disk state never claims feature-disabled (Phase 21b: the token is no proxy)", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlSchemeEnabled: null,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("app-behavior-change");
  });

  it("a Things version change since the last verified write → app-updated", () => {
    const hint = classifyVerifyFailure({
      reason: "timeout",
      vector: "url-scheme",
      urlSchemeEnabled: true,
      environmentChanges: THINGS_UPDATED,
    });
    expect(hint?.likelyCause).toBe("app-updated");
    expect(hint?.hint).toContain("3.22.12");
  });

  it("plain silent no-op with the scheme enabled and stable environment → app-behavior-change", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlSchemeEnabled: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("app-behavior-change");
  });

  it("timeout/mismatch with a stable environment stays unattributed", () => {
    expect(
      classifyVerifyFailure({
        reason: "mismatch",
        vector: "applescript",
        urlSchemeEnabled: true,
        environmentChanges: [],
      }),
    ).toBeNull();
  });
});
