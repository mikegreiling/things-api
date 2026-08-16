/**
 * Session-reachability gate — the pure discriminator logic (SESSGATE, #480).
 * No System Events call ever fires: the counts are supplied directly (parse) or
 * the runner is a stub (probe). Covers the three live-session cells the gate
 * distinguishes and the fail-OPEN behaviour on an unreadable probe.
 */
import { describe, expect, it } from "vitest";

import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";
import {
  axSessionReachabilityScript,
  interpretReachability,
  parseReachabilityCounts,
  probeSessionReachability,
} from "../../src/write/vectors/session-reachability.ts";

describe("parseReachabilityCounts", () => {
  it("parses the three-integer 'AS AX ALL' line", () => {
    expect(parseReachabilityCounts("1 1 3")).toEqual({ thingsAs: 1, thingsAx: 1, allAx: 3 });
    expect(parseReachabilityCounts("  1   0   0 \n")).toEqual({
      thingsAs: 1,
      thingsAx: 0,
      allAx: 0,
    });
  });

  it("returns null for an unrecognizable shape (probe error)", () => {
    expect(parseReachabilityCounts("true")).toBeNull();
    expect(parseReachabilityCounts("")).toBeNull();
    expect(parseReachabilityCounts("1 2")).toBeNull();
    expect(parseReachabilityCounts("a b c")).toBeNull();
  });
});

describe("interpretReachability — the three live-session cells", () => {
  it("reachable when a Things window is AX-visible (thingsAx >= 1)", () => {
    expect(interpretReachability({ thingsAs: 1, thingsAx: 1, allAx: 3 })).toEqual({
      reachable: true,
    });
  });

  it("'session' (locked / full-screen) when EVERY process reports zero windows", () => {
    // The live-host signature: Things AS = 1 (its own dictionary sees a window),
    // but System Events sees 0 windows for Things AND every other process.
    const v = interpretReachability({ thingsAs: 1, thingsAx: 0, allAx: 0 });
    expect(v.reachable).toBe(false);
    if (!v.reachable) {
      expect(v.scope).toBe("session");
      expect(v.remediation.toLowerCase()).toContain("unlock");
    }
  });

  it("'window' (another Space) when only Things is AX-0 but others have windows", () => {
    const v = interpretReachability({ thingsAs: 1, thingsAx: 0, allAx: 4 });
    expect(v.reachable).toBe(false);
    if (!v.reachable) {
      expect(v.scope).toBe("window");
      expect(v.detail.toLowerCase()).toContain("another desktop");
    }
  });

  it("'window' (no window) when Things AX-0, others have windows, and Things AS-0", () => {
    const v = interpretReachability({ thingsAs: 0, thingsAx: 0, allAx: 4 });
    expect(v.reachable).toBe(false);
    if (!v.reachable) {
      expect(v.scope).toBe("window");
      expect(v.detail.toLowerCase()).toContain("no open window");
    }
  });

  it("fail-OPEN (reachable) on a probe error or an unreadable AX count", () => {
    expect(interpretReachability(null)).toEqual({ reachable: true });
    // thingsAx = -1 means the System Events count itself could not be read
    // (Accessibility not granted / a hiccup) — never block on that.
    expect(interpretReachability({ thingsAs: 1, thingsAx: -1, allAx: -1 })).toEqual({
      reachable: true,
    });
  });
});

describe("axSessionReachabilityScript", () => {
  it("reads Things' AS window count, the AX window count, and the all-process AX total", () => {
    const s = axSessionReachabilityScript();
    expect(s).toContain('tell application "Things3" to set thingsAs to count windows');
    expect(s).toContain('count (windows of process "Things3")');
    expect(s).toContain("background only is false");
  });
});

describe("probeSessionReachability", () => {
  const cmds: UiCommand[] = [];
  const runWith = (result: UiRunResult) => async (c: UiCommand) => {
    cmds.push(c);
    return result;
  };

  it("interprets a locked-session count line as a 'session' refusal", async () => {
    const v = await probeSessionReachability(
      runWith({ ok: true, stdout: "1 0 0", stderr: "" }),
      100,
    );
    expect(v.reachable).toBe(false);
    if (!v.reachable) expect(v.scope).toBe("session");
  });

  it("fails OPEN when the probe transport itself errors", async () => {
    const v = await probeSessionReachability(
      runWith({ ok: false, stdout: "", stderr: "boom" }),
      100,
    );
    expect(v).toEqual({ reachable: true });
  });
});
