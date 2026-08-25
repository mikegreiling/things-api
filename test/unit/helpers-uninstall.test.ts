/**
 * `uninstallHelpers` — the plain teardown and its `--revoke` form, the
 * ceremony's inverse. The properties that matter:
 *
 *  - A PLAIN uninstall touches no permission store and keeps the local state:
 *    the TCC rows are keyed to the helper identities and go dormant, so a
 *    later setup picks them straight back up.
 *  - `--revoke` is IDEMPOTENT from any partial state (Mike's pin): an
 *    already-uninstalled helper still gets its grants revoked — via the
 *    LaunchServices fallback, because `tccutil` resolves bundle identifiers
 *    through LaunchServices — and a rerun is a clean no-op.
 *  - Revocation runs BEFORE the bundle is torn down, whenever one is installed.
 *
 * The tool runner is ALWAYS injected: a real `tccutil reset All
 * com.pixelcog.*` inside a test run would revoke this machine's live grants,
 * and a real `lsregister` would touch its LaunchServices database.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uninstallHelpers } from "../../src/index.ts";
import { HELPERS_BUNDLE_ID, READER_LAUNCHD_LABEL } from "../../src/deputy/protocol.ts";

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const PACKAGED = "/pkg/deputy/prebuilt/Things API Helper.app";

let stateDir: string;
let calls: { bin: string; args: string[] }[];
const savedEnv: Record<string, string | undefined> = {};

type Runner = (bin: string, args: string[]) => { ok: boolean; output: string };

function stubTool(ok = true): Runner {
  return (bin, args) => {
    calls.push({ bin, args });
    return { ok, output: ok ? "Successfully reset All" : "tccutil: refused" };
  };
}

/** Deps with a packaged bundle available for the LaunchServices fallback. */
function deps(runTool: Runner, packaged: string | null = PACKAGED) {
  return { runTool, packagedBundlePath: () => packaged };
}

/** Pretend a bundle is installed on this machine. */
function markInstalled(): string {
  const dir = join(stateDir, "deputy/bin/Things API Helper.app/Contents/MacOS");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "things-deputy"), "#!/bin/sh\n");
  return dir;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "uninst-"));
  for (const key of [
    "THINGS_API_STATE_DIR",
    "THINGS_API_READER_DIR",
    "THINGS_API_LAUNCH_AGENTS_DIR",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env["THINGS_API_STATE_DIR"] = stateDir;
  // Per-test LaunchAgents dir: the REAL one must never be touched (the
  // 2026-08-24 incident — checks deleted the live helpers' plists).
  process.env["THINGS_API_LAUNCH_AGENTS_DIR"] = join(stateDir, "launch-agents");
  process.env["THINGS_API_READER_DIR"] = join(stateDir, "reader-container");
  calls = [];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe("a plain uninstall", () => {
  it("revokes nothing and keeps the local state — the grants go dormant, not away", () => {
    const readerDir = join(stateDir, "reader-container");
    const deputyDir = join(stateDir, "deputy");
    mkdirSync(readerDir, { recursive: true });
    writeFileSync(join(readerDir, "bookmark"), "grant-bytes");
    mkdirSync(deputyDir, { recursive: true });
    writeFileSync(join(deputyDir, "token"), "0".repeat(64));
    const result = uninstallHelpers({}, process.env, deps(stubTool()));
    expect(calls).toEqual([]);
    expect(result.revocation).toBeNull();
    expect(existsSync(join(readerDir, "bookmark"))).toBe(true);
    expect(existsSync(join(deputyDir, "token"))).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("removes the installed bundle it finds", () => {
    markInstalled();
    const result = uninstallHelpers({}, process.env, deps(stubTool()));
    expect(existsSync(join(stateDir, "deputy/bin"))).toBe(false);
    expect(result.removed).toEqual(expect.arrayContaining([join(stateDir, "deputy/bin")]));
  });
});

describe("uninstall --revoke", () => {
  it("revokes both identities directly when a bundle is installed (no lsregister needed)", () => {
    markInstalled();
    const result = uninstallHelpers({ revoke: true }, process.env, deps(stubTool()));
    expect(calls).toEqual([
      { bin: "/usr/bin/tccutil", args: ["reset", "All", HELPERS_BUNDLE_ID] },
      { bin: "/usr/bin/tccutil", args: ["reset", "All", READER_LAUNCHD_LABEL] },
    ]);
    expect(result.revocation?.resolvedVia).toBe("installed");
    expect(result.revocation?.registeredBundle).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.revocation?.shortcutsNote).toContain("Shortcuts.app");
  });

  it("revokes while the install still exists — tccutil needs LaunchServices to resolve the id", () => {
    const binDir = join(stateDir, "deputy/bin");
    markInstalled();
    const seenDuringRevoke: boolean[] = [];
    uninstallHelpers(
      { revoke: true },
      process.env,
      deps((bin, args) => {
        calls.push({ bin, args });
        seenDuringRevoke.push(existsSync(binDir));
        return { ok: true, output: "Successfully reset All" };
      }),
    );
    // Both revocations ran BEFORE the uninstall/state legs tore anything down.
    expect(seenDuringRevoke).toEqual([true, true]);
    expect(existsSync(binDir)).toBe(false);
  });

  it("on an ALREADY-uninstalled machine, registers the packaged bundle first (Mike's idempotence pin)", () => {
    const result = uninstallHelpers({ revoke: true }, process.env, deps(stubTool()));
    expect(calls).toEqual([
      { bin: LSREGISTER, args: ["-f", "-R", PACKAGED] },
      { bin: "/usr/bin/tccutil", args: ["reset", "All", HELPERS_BUNDLE_ID] },
      { bin: "/usr/bin/tccutil", args: ["reset", "All", READER_LAUNCHD_LABEL] },
    ]);
    expect(result.revocation?.resolvedVia).toBe("packaged");
    expect(result.revocation?.registeredBundle).toBe(PACKAGED);
    expect(result.revocation?.tccResets.map((t) => t.ok)).toEqual([true, true]);
    expect(result.warnings).toEqual([]);
  });

  it("with no bundle anywhere, still attempts the resets and says what it cannot address", () => {
    const result = uninstallHelpers(
      { revoke: true },
      process.env,
      deps((bin, args) => {
        calls.push({ bin, args });
        return {
          ok: false,
          output:
            'tccutil: No such bundle identifier "com.pixelcog.things-reader": The operation couldn’t be completed. (OSStatus error -10814.)',
        };
      }, null),
    );
    expect(calls.map((c) => c.bin)).toEqual(["/usr/bin/tccutil", "/usr/bin/tccutil"]);
    expect(result.revocation?.resolvedVia).toBe("none");
    expect(result.revocation?.tccResets[0]?.detail).toContain("reinstall the helpers");
    expect(result.revocation?.tccResets[0]?.detail).toContain("System Settings");
    // Honest, not a failure: nothing here is broken, it is just unaddressable.
    expect(result.warnings).toEqual([]);
  });

  it("a failing lsregister is a warning, and the resets are still attempted", () => {
    const result = uninstallHelpers(
      { revoke: true },
      process.env,
      deps((bin, args) => {
        calls.push({ bin, args });
        return bin === LSREGISTER
          ? { ok: false, output: "lsregister: could not register" }
          : { ok: true, output: "Successfully reset All" };
      }),
    );
    expect(result.revocation?.resolvedVia).toBe("none");
    expect(result.warnings[0]).toContain("LaunchServices");
    expect(calls.filter((c) => c.bin === "/usr/bin/tccutil")).toHaveLength(2);
  });

  it("removes the reader container and deputy state when they exist", () => {
    const readerDir = join(stateDir, "reader-container");
    const deputyDir = join(stateDir, "deputy");
    mkdirSync(readerDir, { recursive: true });
    writeFileSync(join(readerDir, "bookmark"), "grant-bytes");
    mkdirSync(deputyDir, { recursive: true });
    writeFileSync(join(deputyDir, "token"), "0".repeat(64));
    const result = uninstallHelpers({ revoke: true }, process.env, deps(stubTool()));
    expect(existsSync(readerDir)).toBe(false);
    expect(existsSync(deputyDir)).toBe(false);
    expect(result.removed).toEqual(expect.arrayContaining([readerDir, deputyDir]));
  });

  it("a rerun after a revoke is a clean no-op that still reports the grant legs", () => {
    uninstallHelpers({ revoke: true }, process.env, deps(stubTool()));
    calls = [];
    const again = uninstallHelpers({ revoke: true }, process.env, deps(stubTool()));
    // lsregister + both resets: nothing is installed either time.
    expect(calls).toHaveLength(3);
    expect(again.removed).toEqual([]);
    expect(again.warnings).toEqual([]);
  });

  it("-10814 with a bundle in hand is the idempotent no-op, not a warning", () => {
    markInstalled();
    const result = uninstallHelpers({ revoke: true }, process.env, {
      runTool: (bin, args) => {
        calls.push({ bin, args });
        return {
          ok: false,
          output:
            'tccutil: No such bundle identifier "com.pixelcog.things-reader": The operation couldn’t be completed. (OSStatus error -10814.)',
        };
      },
    });
    expect(result.revocation?.tccResets.map((t) => t.ok)).toEqual([true, true]);
    expect(result.revocation?.tccResets[0]?.detail).toContain("nothing to revoke");
    expect(result.warnings).toEqual([]);
  });

  it("a failing tccutil surfaces as a warning, and the other legs still run", () => {
    const deputyDir = join(stateDir, "deputy");
    mkdirSync(deputyDir, { recursive: true });
    const result = uninstallHelpers({ revoke: true }, process.env, deps(stubTool(false)));
    expect(result.revocation?.tccResets.every((t) => !t.ok)).toBe(true);
    // One per identity; the lsregister failure adds a third.
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(deputyDir)).toBe(false);
  });
});
