/**
 * The passive helpers notices (src/deputy/notices.ts) + the CLI gating that
 * decides whether a human ever sees them (src/cli/helpers-check.ts).
 *
 * Everything runs against a temp state/config dir and a synthetic "installed"
 * bundle — nothing here reads or touches the machine's real helpers.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXPECTED_HELPERS_VERSION, helpersInstalledBundlePath } from "../../src/deputy/protocol.ts";
import {
  computeHelpersNotice,
  HELPERS_HINT_INTERVAL_DAYS,
  lastHelpersHintAt,
  markHelpersHintShown,
} from "../../src/deputy/notices.ts";
import { resetHelpersNoticeForTests } from "../../src/deputy/notice.ts";
import { maybeEmitHelpersNotice, resetHelpersCheck } from "../../src/cli/helpers-check.ts";

let dir: string;

/** A hermetic env: temp state + config dirs, no THINGS_API_HELPERS override. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    THINGS_API_STATE_DIR: join(dir, "state"),
    THINGS_API_CONFIG_DIR: join(dir, "config"),
    ...overrides,
  };
}

/** Write a synthetic installed bundle stamped with `version`. */
function installBundle(version: string, e: NodeJS.ProcessEnv): void {
  const bundle = helpersInstalledBundlePath(e);
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents/MacOS/things-deputy"), "#!/bin/sh\n");
  writeFileSync(
    join(bundle, "Contents/Info.plist"),
    `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "helpnotice-"));
  resetHelpersCheck();
  resetHelpersNoticeForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("computeHelpersNotice — version skew", () => {
  it("names both versions and the rebuild+reinstall remedy", () => {
    const e = env();
    installBundle("0.9.0", e);
    const notice = computeHelpersNotice({ env: e, platform: "darwin" });
    expect(notice?.kind).toBe("version-skew");
    expect(notice?.text).toContain("v0.9.0");
    expect(notice?.text).toContain(`v${EXPECTED_HELPERS_VERSION}`);
    expect(notice?.text).toContain("things helpers install");
  });

  it("says nothing when the installed bundle matches", () => {
    const e = env();
    installBundle(EXPECTED_HELPERS_VERSION, e);
    expect(computeHelpersNotice({ env: e, platform: "darwin" })).toBeNull();
  });

  it("stays silent under helpers-enabled false — an off host is not nagged", () => {
    const e = env({ THINGS_API_HELPERS: "false" });
    installBundle("0.9.0", e);
    expect(computeHelpersNotice({ env: e, platform: "darwin" })).toBeNull();
  });

  it("fires under an explicit true as well as the default auto", () => {
    const e = env({ THINGS_API_HELPERS: "true" });
    installBundle("0.9.0", e);
    expect(computeHelpersNotice({ env: e, platform: "darwin" })?.kind).toBe("version-skew");
  });

  it("is silent off macOS, where the helpers do not exist", () => {
    const e = env();
    installBundle("0.9.0", e);
    expect(computeHelpersNotice({ env: e, platform: "linux" })).toBeNull();
  });
});

describe("computeHelpersNotice — absence hint", () => {
  it("introduces the helpers on a machine that has never answered the question", () => {
    const notice = computeHelpersNotice({ env: env(), platform: "darwin" });
    expect(notice?.kind).toBe("absent-hint");
    expect(notice?.text).toContain("things helpers install");
    expect(notice?.text).toContain("THINGS_API_NO_HELPERS_CHECK=1");
  });

  it("says nothing once the mode has been set on purpose", () => {
    expect(
      computeHelpersNotice({ env: env(), platform: "darwin", modeUntouched: false }),
    ).toBeNull();
    // An env-forced mode counts as an answer, too.
    expect(
      computeHelpersNotice({ env: env({ THINGS_API_HELPERS: "auto" }), platform: "darwin" }),
    ).toBeNull();
  });

  it("is throttled: quiet inside the window, speaks again after it", () => {
    const e = env();
    const day = 86_400_000;
    const t0 = Date.parse("2026-08-22T12:00:00.000Z");
    expect(computeHelpersNotice({ env: e, platform: "darwin", now: t0 })?.kind).toBe("absent-hint");
    markHelpersHintShown(e, t0);
    expect(lastHelpersHintAt(e)).toBe(t0);
    expect(
      computeHelpersNotice({
        env: e,
        platform: "darwin",
        now: t0 + (HELPERS_HINT_INTERVAL_DAYS - 1) * day,
      }),
    ).toBeNull();
    expect(
      computeHelpersNotice({
        env: e,
        platform: "darwin",
        now: t0 + (HELPERS_HINT_INTERVAL_DAYS + 1) * day,
      })?.kind,
    ).toBe("absent-hint");
  });
});

/**
 * Run the CLI check with a captured stderr sink. The platform is pinned to
 * darwin: the notices are macOS-only by design, and the suite also runs on
 * CI's Linux job.
 */
function capture(argv: string[], e: NodeJS.ProcessEnv, now?: number): string[] {
  const lines: string[] = [];
  maybeEmitHelpersNotice({
    argv,
    env: e,
    platform: "darwin",
    ...(now !== undefined && { now }),
    write: (s) => lines.push(s),
  });
  return lines;
}

describe("maybeEmitHelpersNotice — CLI gating", () => {
  it("prints ONE prefixed stderr line on a human path", () => {
    const e = env();
    installBundle("0.9.0", e);
    const lines = capture(["today"], e);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^things-api helpers: /);
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });

  it("stays silent for --json, the mcp server, and `things helpers` itself", () => {
    for (const argv of [["today", "--json"], ["mcp"], ["helpers", "status"]]) {
      const e = env();
      installBundle("0.9.0", e);
      resetHelpersCheck();
      resetHelpersNoticeForTests();
      expect(capture(argv, e)).toEqual([]);
    }
  });

  it("says nothing on a platform that has no helpers", () => {
    const e = env();
    installBundle("0.9.0", e);
    const lines: string[] = [];
    maybeEmitHelpersNotice({
      argv: ["today"],
      env: e,
      platform: "linux",
      write: (s) => lines.push(s),
    });
    expect(lines).toEqual([]);
  });

  it("honors the kill switch", () => {
    const e = env({ THINGS_API_NO_HELPERS_CHECK: "1" });
    installBundle("0.9.0", e);
    expect(capture(["today"], e)).toEqual([]);
  });

  it("runs at most once per process", () => {
    const e = env();
    installBundle("0.9.0", e);
    expect(capture(["today"], e)).toHaveLength(1);
    expect(capture(["today"], e)).toEqual([]);
  });

  it("stamps the throttle only for the absence hint, never for a skew", () => {
    const skewEnv = env();
    installBundle("0.9.0", skewEnv);
    capture(["today"], skewEnv);
    expect(existsSync(join(dir, "state/helpers-hint.json"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "helpnotice-"));
    resetHelpersCheck();
    resetHelpersNoticeForTests();
    const bareEnv = env();
    const now = Date.parse("2026-08-22T12:00:00.000Z");
    expect(capture(["today"], bareEnv, now)).toHaveLength(1);
    expect(lastHelpersHintAt(bareEnv)).toBe(now);
  });
});
