/**
 * `resetHelpers` — the never-onboarded teardown. The property Mike pinned:
 * IDEMPOTENT from any partial state — an already-uninstalled helper still
 * gets its permission grants revoked, and a rerun is a clean no-op.
 *
 * The tccutil runner is ALWAYS injected here: a real `tccutil reset All
 * com.pixelcog.*` inside a test run would revoke the developer machine's
 * live helper grants.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetHelpers } from "../../src/index.ts";
import { HELPERS_BUNDLE_ID, READER_LAUNCHD_LABEL } from "../../src/deputy/protocol.ts";

let stateDir: string;
let calls: { bin: string; args: string[] }[];
const savedEnv: Record<string, string | undefined> = {};

function stubTool(ok = true): (bin: string, args: string[]) => { ok: boolean; output: string } {
  return (bin, args) => {
    calls.push({ bin, args });
    return { ok, output: ok ? "Successfully reset All" : "tccutil: refused" };
  };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "reset-"));
  for (const key of ["THINGS_API_STATE_DIR", "THINGS_API_READER_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env["THINGS_API_STATE_DIR"] = stateDir;
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

describe("resetHelpers", () => {
  it("on a bare machine still revokes both identities' grants (Mike's idempotence pin)", () => {
    const result = resetHelpers(process.env, stubTool());
    expect(calls).toEqual([
      { bin: "/usr/bin/tccutil", args: ["reset", "All", HELPERS_BUNDLE_ID] },
      { bin: "/usr/bin/tccutil", args: ["reset", "All", READER_LAUNCHD_LABEL] },
    ]);
    expect(result.tccResets.map((t) => t.ok)).toEqual([true, true]);
    expect(result.warnings).toEqual([]);
    expect(result.shortcutsNote).toContain("Shortcuts.app");
  });

  it("removes the reader container and deputy state when they exist", () => {
    const readerDir = join(stateDir, "reader-container");
    const deputyDir = join(stateDir, "deputy");
    mkdirSync(readerDir, { recursive: true });
    writeFileSync(join(readerDir, "bookmark"), "grant-bytes");
    mkdirSync(deputyDir, { recursive: true });
    writeFileSync(join(deputyDir, "token"), "0".repeat(64));
    const result = resetHelpers(process.env, stubTool());
    expect(existsSync(readerDir)).toBe(false);
    expect(existsSync(deputyDir)).toBe(false);
    expect(result.removed).toEqual(expect.arrayContaining([readerDir, deputyDir]));
  });

  it("a rerun after a reset is a clean no-op that still reports the grant legs", () => {
    resetHelpers(process.env, stubTool());
    calls = [];
    const again = resetHelpers(process.env, stubTool());
    expect(calls).toHaveLength(2);
    expect(again.removed).toEqual([]);
    expect(again.warnings).toEqual([]);
  });

  it("a failing tccutil surfaces as a warning, and the other legs still run", () => {
    const deputyDir = join(stateDir, "deputy");
    mkdirSync(deputyDir, { recursive: true });
    const result = resetHelpers(process.env, stubTool(false));
    expect(result.tccResets.every((t) => !t.ok)).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(existsSync(deputyDir)).toBe(false);
  });
});
