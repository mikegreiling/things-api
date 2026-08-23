/**
 * Where `things helpers install` finds its bundle when the caller names no
 * path. Two homes: the signed + notarized bundle the release workflow stages
 * into the npm tarball (`deputy/prebuilt`), and the local output of
 * scripts/build-helpers.sh in a source checkout (`deputy/build`).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  helpersBundleCandidates,
  helpersDefaultBuildPath,
  installHelpers,
} from "../../src/index.ts";

const [PREBUILT, BUILD] = helpersBundleCandidates() as [string, string];
const DEPUTY_EXE = "Contents/MacOS/things-deputy";

/** A stand-in bundle: the one file the resolver looks for. */
function fakeBundle(root: string): void {
  const exe = join(root, DEPUTY_EXE);
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

/**
 * Every case below writes into the two real candidate paths, so a checkout
 * that already holds either one is left strictly alone — a developer's built
 * bundle is not test scratch space.
 */
const CLEAN_CHECKOUT = !existsSync(PREBUILT) && !existsSync(BUILD);

afterEach(() => {
  if (!CLEAN_CHECKOUT) return;
  rmSync(PREBUILT, { recursive: true, force: true });
  rmSync(BUILD, { recursive: true, force: true });
});

describe("helpers bundle resolution", () => {
  it("orders the published bundle ahead of the source-checkout build", () => {
    expect(PREBUILT.endsWith("deputy/prebuilt/Things API Helper.app")).toBe(true);
    expect(BUILD.endsWith("deputy/build/Things API Helper.app")).toBe(true);
  });

  it.skipIf(!CLEAN_CHECKOUT)("resolves nothing when neither candidate exists", () => {
    expect(helpersDefaultBuildPath()).toBeNull();
  });

  it.skipIf(!CLEAN_CHECKOUT)("resolves the source-checkout build when it is the only one", () => {
    fakeBundle(BUILD);
    expect(helpersDefaultBuildPath()).toBe(BUILD);
  });

  it.skipIf(!CLEAN_CHECKOUT)("resolves the published bundle when it is the only one", () => {
    fakeBundle(PREBUILT);
    expect(helpersDefaultBuildPath()).toBe(PREBUILT);
  });

  it.skipIf(!CLEAN_CHECKOUT)("prefers the published bundle when both exist", () => {
    fakeBundle(BUILD);
    fakeBundle(PREBUILT);
    expect(helpersDefaultBuildPath()).toBe(PREBUILT);
  });

  it.skipIf(!CLEAN_CHECKOUT)("names both homes, and the build remedy, when neither exists", () => {
    // Throws before any launchd or filesystem side effect.
    expect(() => installHelpers()).toThrow(/deputy\/prebuilt/);
    expect(() => installHelpers()).toThrow(/deputy\/build/);
    expect(() => installHelpers()).toThrow(/scripts\/build-helpers\.sh/);
  });
});
