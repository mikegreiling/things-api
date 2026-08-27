/**
 * Static availability signals: proxy-shortcut presence. The `shortcuts list`
 * touchpoint goes through a seam — no host state, no spawns. ('Enable Things
 * URLs' used to live here; it is now `urlSchemeCapability` and is covered by
 * test/unit/capability-url-scheme.test.ts.)
 */
import { describe, expect, it } from "vitest";

import { EXPECTED_PROXIES, readShortcutProxies } from "../../src/write/availability.ts";

describe("readShortcutProxies", () => {
  it("splits present/missing against the expected six", () => {
    const state = readShortcutProxies({
      listShortcuts: () =>
        "Some Unrelated Shortcut\nthings-proxy-find-items\nthings-proxy-create-heading\n",
    });
    expect(state.present).toEqual(["things-proxy-find-items", "things-proxy-create-heading"]);
    expect(state.missing).toHaveLength(EXPECTED_PROXIES.length - 2);
    expect(state.detail).toContain("things setup");
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
