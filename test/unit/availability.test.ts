/**
 * Static availability signals: the on-disk 'Enable Things URLs' state and
 * proxy-shortcut presence. All external touchpoints (plist file, plutil,
 * `shortcuts list`) go through seams — no host state, no spawns.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  EXPECTED_PROXIES,
  readShortcutProxies,
  readUrlSchemeEnabled,
} from "../../src/write/availability.ts";

const dir = mkdtempSync(join(tmpdir(), "things-avail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function plistFixture(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "irrelevant — the extract seam interprets the bytes");
  return path;
}

describe("readUrlSchemeEnabled", () => {
  it("plist unreadable → null with a check-the-app pointer", () => {
    const state = readUrlSchemeEnabled({ plistPath: join(dir, "missing.plist") });
    expect(state.enabled).toBeNull();
    expect(state.detail).toContain("Settings > General");
  });

  it("key absent (extract throws) → null: the toggle was never set", () => {
    const state = readUrlSchemeEnabled({
      plistPath: plistFixture("no-key.plist"),
      extract: () => {
        throw new Error("No value at that key path");
      },
    });
    expect(state.enabled).toBeNull();
    expect(state.detail).toContain("never been toggled");
  });

  it("value 1 → enabled", () => {
    const state = readUrlSchemeEnabled({
      plistPath: plistFixture("on.plist"),
      extract: () => "1\n",
    });
    expect(state.enabled).toBe(true);
  });

  it("value 0 → disabled, detail names the setting", () => {
    const state = readUrlSchemeEnabled({
      plistPath: plistFixture("off.plist"),
      extract: () => "0\n",
    });
    expect(state.enabled).toBe(false);
    expect(state.detail).toContain("Enable Things URLs");
  });

  it("unexpected value → null, value surfaced", () => {
    const state = readUrlSchemeEnabled({
      plistPath: plistFixture("odd.plist"),
      extract: () => "banana",
    });
    expect(state.enabled).toBeNull();
    expect(state.detail).toContain("banana");
  });
});

describe("readShortcutProxies", () => {
  it("splits present/missing against the expected six", () => {
    const state = readShortcutProxies({
      listShortcuts: () =>
        "Some Unrelated Shortcut\nthings-proxy-find-items\nthings-proxy-create-heading\n",
    });
    expect(state.present).toEqual(["things-proxy-find-items", "things-proxy-create-heading"]);
    expect(state.missing).toHaveLength(EXPECTED_PROXIES.length - 2);
    expect(state.detail).toContain("things setup shortcuts");
  });

  it("all present → clean detail", () => {
    const state = readShortcutProxies({ listShortcuts: () => EXPECTED_PROXIES.join("\n") });
    expect(state.missing).toEqual([]);
    expect(state.detail).toContain("all proxy shortcuts are installed");
  });

  it("shortcuts CLI unavailable → everything missing, detail says unknown", () => {
    const state = readShortcutProxies({
      listShortcuts: () => {
        throw new Error("spawn shortcuts ENOENT");
      },
    });
    expect(state.present).toEqual([]);
    expect(state.missing).toHaveLength(EXPECTED_PROXIES.length);
    expect(state.detail).toContain("unavailable");
  });
});
