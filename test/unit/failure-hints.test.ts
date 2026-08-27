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
    expect(hint?.hint).toContain("Automation dialog");
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
      urlScheme: "disabled",
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
    expect(hint?.hint).toContain("Enable Things URLs");
  });

  it("timeout on url-scheme with the setting OFF → feature-disabled (the write is held behind the enable dialog)", () => {
    const hint = classifyVerifyFailure({
      reason: "timeout",
      vector: "url-scheme",
      urlScheme: "disabled",
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
  });

  it("never-asked → feature-disabled: the app parks the command behind its own alert (URLEN1)", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: "never-asked",
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
  });

  it("UNREADABLE also earns the hint — this is the case the gate could not refuse on (#611)", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: "unreadable",
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
    expect(hint?.hint).toContain("Enable Things URLs");
    // The parked command can still land when someone clicks Enable, so the copy
    // must not send the caller straight into a blind resend.
    expect(hint?.hint).toContain("Verify the item's state before resending");
  });

  it("a vector that delivers no URLs passes null, and is never blamed on the setting", () => {
    // The pipeline keys this on the vector's `dispatchesUrls` declaration, not
    // on its id — the regression CI caught: an id-keyed lookup made the default
    // read the developer's own Things preferences, so an engine test passed on
    // a workstation with the setting on and failed in CI, where nothing is
    // readable and every silent no-op became "feature-disabled".
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "applescript",
      urlScheme: null,
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("app-behavior-change");
  });

  it("null wins even under the `url-scheme` id — a fake there dispatches nothing", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: null,
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("app-behavior-change");
  });

  it("silent no-op when the app was NOT running at preflight → app-not-running (issue #486)", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: "enabled",
      appWasRunning: false,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("app-not-running");
    expect(hint?.hint).toContain("startup window");
  });

  it("app-not-running outranks a coincident Things version change (the launch-drop is the proximate cause)", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: "enabled",
      appWasRunning: false,
      environmentChanges: THINGS_UPDATED,
    });
    expect(hint?.likelyCause).toBe("app-not-running");
  });

  it("the not-authorized signal still outranks app-not-running (a definitive on-disk read)", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: "disabled",
      appWasRunning: false,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("feature-disabled");
  });

  it("a Things version change since the last verified write → app-updated", () => {
    const hint = classifyVerifyFailure({
      reason: "timeout",
      vector: "url-scheme",
      urlScheme: "enabled",
      appWasRunning: true,
      environmentChanges: THINGS_UPDATED,
    });
    expect(hint?.likelyCause).toBe("app-updated");
    expect(hint?.hint).toContain("3.22.12");
  });

  it("plain silent no-op with the scheme enabled and stable environment → app-behavior-change", () => {
    const hint = classifyVerifyFailure({
      reason: "silent-noop",
      vector: "url-scheme",
      urlScheme: "enabled",
      appWasRunning: true,
      environmentChanges: [],
    });
    expect(hint?.likelyCause).toBe("app-behavior-change");
  });

  it("timeout/mismatch with a stable environment stays unattributed", () => {
    expect(
      classifyVerifyFailure({
        reason: "mismatch",
        vector: "applescript",
        urlScheme: "enabled",
        appWasRunning: true,
        environmentChanges: [],
      }),
    ).toBeNull();
  });
});
