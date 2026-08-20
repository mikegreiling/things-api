/**
 * Deputy path resolution: both sides (TS here, deputy/src/main.swift) derive
 * the state dir from the same THINGS_API_STATE_DIR / XDG_STATE_HOME
 * precedence, so pointing one env at a temp dir points the socket, token, and
 * logs of BOTH processes there. These tests pin the TS half of that contract.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { deputySocketPath, deputyStateDir, deputyTokenPath } from "../../src/deputy/protocol.ts";

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
