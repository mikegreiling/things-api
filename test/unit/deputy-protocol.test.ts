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
  DEPUTY_CAPABILITY_OBSERVER,
  type DeputyHello,
  deputyHostsObserver,
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
 * THE HELPER CAPABILITY, PINNED ACROSS THE SAME SEAM (DEPOBS1).
 *
 * `hello.capabilities` is what lets a new CLI meet an old helper and degrade to
 * the polling settles instead of speaking verbs nobody implements — so the
 * string the deputy advertises and the string the client looks for must be one
 * string. Parsed out of the Swift rather than trusted, for the reason the ban
 * list is: a mismatch here is silent until a field drive quietly loses its
 * settles.
 */
describe("the observer capability name", () => {
  it("matches deputy/src/main.swift", () => {
    const swift = readFileSync(
      fileURLToPath(new URL("../../deputy/src/main.swift", import.meta.url)),
      "utf8",
    );
    const match = /let DEPUTY_CAPABILITY_OBSERVER = "([^"]+)"/.exec(swift);
    expect(match?.[1]).toBe(DEPUTY_CAPABILITY_OBSERVER);
  });

  it("reads a handshake that advertises it, and one that cannot", () => {
    const base: DeputyHello = {
      protocol: 1,
      deputyVersion: EXPECTED_HELPERS_VERSION,
      pid: 42,
      uptimeMs: 1,
    };
    expect(deputyHostsObserver({ ...base, capabilities: [DEPUTY_CAPABILITY_OBSERVER] })).toBe(true);
    // A 1.3.0 helper carries no list at all — absent means "base verbs only",
    // never "unknown", and never a guess in the observer's favor.
    expect(deputyHostsObserver(base)).toBe(false);
    expect(deputyHostsObserver({ ...base, capabilities: [] })).toBe(false);
    expect(deputyHostsObserver(null)).toBe(false);
  });

  it("is registered on the Things application element in ONE list per language", () => {
    // The notification classes the observer registers are the sidecar's, and
    // the two are read by the same settle specs — a class present in one and
    // absent from the other is a settle that fires on one host class only.
    const swift = readFileSync(
      fileURLToPath(new URL("../../deputy/src/observer.swift", import.meta.url)),
      "utf8",
    );
    const python = readFileSync(
      fileURLToPath(new URL("../../src/write/vectors/ui-observer.ts", import.meta.url)),
      "utf8",
    );
    const names = (source: string, marker: string): string[] => {
      // From the OPENING BRACKET of the literal to its close — the Swift
      // declaration's own `[String]` annotation sits before it.
      const open = source.indexOf("[", source.indexOf(marker) + marker.length);
      const end = source.indexOf("]", open);
      return [...source.slice(open, end).matchAll(/"(AX[A-Za-z]+)"/g)].map((m) => m[1] as string);
    };
    const fromSwift = names(swift, "let OBSERVER_NOTIFICATIONS: [String] =");
    const fromSidecar = names(python, "CLASSES =");
    expect(fromSwift.length).toBeGreaterThan(10);
    expect(fromSwift).toEqual(fromSidecar);
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
