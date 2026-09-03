/**
 * Deputy path resolution: both sides (TS here, deputy/src/main.swift) derive
 * the state dir from the same THINGS_API_STATE_DIR / XDG_STATE_HOME
 * precedence, so pointing one env at a temp dir points the socket, token, and
 * logs of BOTH processes there. These tests pin the TS half of that contract.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEPUTY_BANNED_SCRIPT_PHRASES,
  deputySocketPath,
  deputyStateDir,
  deputyTokenPath,
  EXPECTED_HELPERS_VERSION,
} from "../../src/deputy/protocol.ts";

describe("deputy paths", () => {
  it("THINGS_API_STATE_DIR wins", () => {
    const env = { THINGS_API_STATE_DIR: "/tmp/x", XDG_STATE_HOME: "/tmp/y" };
    expect(deputyStateDir(env)).toBe(join("/tmp/x", "deputy"));
    expect(deputySocketPath(env)).toBe(join("/tmp/x", "deputy", "deputy.sock"));
    expect(deputyTokenPath(env)).toBe(join("/tmp/x", "deputy", "token"));
  });

  it("XDG_STATE_HOME is the fallback base", () => {
    const env = { XDG_STATE_HOME: "/tmp/y" };
    expect(deputyStateDir(env)).toBe(join("/tmp/y", "things-api", "deputy"));
  });

  it("defaults under ~/.local/state", () => {
    expect(deputyStateDir({})).toContain(join(".local", "state", "things-api", "deputy"));
  });
});

describe("helpers version line", () => {
  // The helpers version is deliberately decoupled from package.json (see
  // EXPECTED_HELPERS_VERSION); the constant and deputy/VERSION (the build
  // script's source of truth) must never drift apart.
  it("EXPECTED_HELPERS_VERSION matches deputy/VERSION", () => {
    const onDisk = readFileSync(
      fileURLToPath(new URL("../../deputy/VERSION", import.meta.url)),
      "utf8",
    ).trim();
    expect(EXPECTED_HELPERS_VERSION).toBe(onDisk);
  });
});

/**
 * THE BROKER'S LINT, PINNED ACROSS THE LANGUAGE SEAM (#695).
 *
 * `scriptGuard` in the deputy refuses any script containing one of these
 * phrases, and the TS side must know the same list to keep its generators from
 * emitting one — that is the whole guard behind
 * test/unit/ui-script-broker-safety.test.ts. Two hand-maintained lists in two
 * languages WILL drift, and the drift is silent until a field command fails, so
 * the Swift array is parsed here rather than trusted.
 */
describe("the deputy's banned script phrases", () => {
  it("match the Swift array in deputy/src/server.swift, in order", () => {
    const swift = readFileSync(
      fileURLToPath(new URL("../../deputy/src/server.swift", import.meta.url)),
      "utf8",
    );
    const match = /for banned in \[([^\]]*)\]/.exec(swift);
    expect(match, "scriptGuard's `for banned in [...]` loop was not found").not.toBeNull();
    const fromSwift = [...(match?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect(fromSwift.length).toBeGreaterThan(0);
    expect([...DEPUTY_BANNED_SCRIPT_PHRASES]).toEqual(fromSwift);
  });

  it("are lower-cased, because the Swift guard lower-cases before comparing", () => {
    // `scriptGuard` tests `script.lowercased().contains(banned)`, so an
    // upper-case character in the list would make that phrase unmatchable.
    for (const phrase of DEPUTY_BANNED_SCRIPT_PHRASES) {
      expect(phrase).toBe(phrase.toLowerCase());
    }
  });
});
