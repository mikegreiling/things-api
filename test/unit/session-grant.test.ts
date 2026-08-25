/**
 * The instance-scoped app-data grant marker.
 *
 * The load-bearing property under test is that this marker CANNOT become a
 * stored "onboarded" flag: it must go invalid the moment the host-app instance
 * it describes goes away, because the macOS grant it records dies at exactly
 * that moment.
 */
import { readFileSync, existsSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionGrant,
  sessionGrantPath,
  sessionGrantValid,
  witnessSessionGrant,
  type SessionGrantDeps,
} from "../../src/session-grant.ts";
import { makeTempDir } from "../fixtures/temp-dir.ts";

const BUNDLE = "com.mitchellh.ghostty";
const START = "Thu Jul 16 00:29:43 2026";

let stateDir: string;

function deps(over: Partial<SessionGrantDeps> = {}): SessionGrantDeps {
  return {
    env: { THINGS_API_STATE_DIR: stateDir },
    hostPid: () => 4242,
    processStart: () => START,
    bootTime: () => 1_784_187_814,
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  stateDir = makeTempDir("things-session");
});

describe("witnessing", () => {
  it("records the host instance the grant was minted for", () => {
    const marker = witnessSessionGrant(BUNDLE, deps());
    expect(marker).not.toBeNull();
    const onDisk = JSON.parse(readFileSync(sessionGrantPath(deps().env), "utf8"));
    expect(onDisk).toMatchObject({ hostBundleId: BUNDLE, hostPid: 4242, hostStart: START });
  });

  it("refuses to record anything when there is no host instance to tie it to", () => {
    expect(witnessSessionGrant(BUNDLE, deps({ hostPid: () => null }))).toBeNull();
    expect(existsSync(sessionGrantPath(deps().env))).toBe(false);
  });
});

describe("validity — the marker cannot outlive the grant", () => {
  it("is valid for the same running instance", () => {
    witnessSessionGrant(BUNDLE, deps());
    expect(sessionGrantValid(BUNDLE, deps())).toMatchObject({ valid: true });
  });

  it("goes invalid the moment the host app is gone", () => {
    witnessSessionGrant(BUNDLE, deps());
    const verdict = sessionGrantValid(BUNDLE, deps({ hostPid: () => null }));
    expect(verdict.valid).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("no longer running") });
  });

  it("goes invalid when the app restarted into the SAME pid (start time differs)", () => {
    witnessSessionGrant(BUNDLE, deps());
    const verdict = sessionGrantValid(
      BUNDLE,
      deps({ processStart: () => "Thu Jul 16 09:00:00 2026" }),
    );
    expect(verdict.valid).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("restarted") });
  });

  it("goes invalid for a DIFFERENT host app, even one that is running", () => {
    witnessSessionGrant(BUNDLE, deps());
    const verdict = sessionGrantValid("com.apple.Terminal", deps());
    expect(verdict.valid).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("belongs to") });
  });

  it("goes invalid across a machine restart", () => {
    witnessSessionGrant(BUNDLE, deps());
    const verdict = sessionGrantValid(BUNDLE, deps({ bootTime: () => 1_790_000_000 }));
    expect(verdict.valid).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("machine has restarted") });
  });

  it("tolerates the boot-time drift macOS introduces across sleep/wake", () => {
    // MEASURED: kern.boottime is re-derived from the current clock after a
    // suspend, so it moves by minutes without a restart. An exact match would
    // invalidate the marker every time the lid closed.
    witnessSessionGrant(BUNDLE, deps());
    expect(sessionGrantValid(BUNDLE, deps({ bootTime: () => 1_784_187_814 + 600 })).valid).toBe(
      true,
    );
  });

  it("a process with no host identity can never hold one", () => {
    witnessSessionGrant(BUNDLE, deps());
    expect(sessionGrantValid(null, deps()).valid).toBe(false);
  });

  it("no marker at all is an ordinary no", () => {
    const verdict = sessionGrantValid(BUNDLE, deps());
    expect(verdict.valid).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("no app-data grant") });
  });

  it("clearing removes the claim", () => {
    witnessSessionGrant(BUNDLE, deps());
    clearSessionGrant(deps().env);
    expect(sessionGrantValid(BUNDLE, deps()).valid).toBe(false);
  });
});
