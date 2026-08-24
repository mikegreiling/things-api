/**
 * The two halves `things helpers setup` lays down so the reader is reachable
 * from every host app: the LaunchAgent that makes launchd own the socket, and
 * the client-side rendezvous directory holding the matching access token.
 *
 * What is being defended. Until helpers 1.3.0 the sandboxed reader bound its
 * own socket and minted its own token, both of which a sandboxed process can
 * only place inside its container — which turned every CLIENT probe into a
 * cross-app container access (`kTCCServiceSystemPolicyAppData`): silent under a
 * Full Disk Access host, a consent modal from anywhere else. These cells pin
 * the arrangement that ends it, key by key, because a quiet regression in
 * either half looks perfectly healthy on the developer's own FDA machine and
 * fails only on someone else's.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mintReaderRendezvous, renderReaderPlist } from "../../src/deputy/install.ts";
import {
  READER_LAUNCHD_LABEL,
  READER_SOCKET_KEY,
  READER_TOKEN_ENV,
  readerRendezvousDir,
  readerSocketPath,
  readerTokenPath,
} from "../../src/deputy/protocol.ts";

let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "rendezvous-"));
  env = { THINGS_API_STATE_DIR: stateDir };
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const plist = (): string =>
  renderReaderPlist("/opt/helper/things-reader.app", "/var/state/reader/reader.sock", "t0ken");

describe("the reader's LaunchAgent", () => {
  it("hands launchd the socket, at a path outside every sandbox container", () => {
    const xml = plist();
    expect(xml).toContain("<key>Sockets</key>");
    expect(xml).toContain(`<key>${READER_SOCKET_KEY}</key>`);
    expect(xml).toContain("<key>SockPathName</key>");
    expect(xml).toContain("<string>/var/state/reader/reader.sock</string>");
    expect(xml).toContain("<key>SockFamily</key>");
    expect(xml).toContain("<string>Unix</string>");
    expect(xml).not.toContain("Library/Containers");
  });

  it("writes SockPathMode in DECIMAL — a plist has no octal literal", () => {
    // 0600 spelled `<integer>600</integer>` is 0o1130: group- and
    // world-readable, and the socket would silently be open to every process
    // on the machine. launchd reads the number base-10, so 384 it is.
    expect(plist()).toContain("<key>SockPathMode</key>\n      <integer>384</integer>");
    expect(plist()).not.toContain("<integer>600</integer>");
  });

  it("carries the access token in the environment, so the reader needs no token file", () => {
    const xml = plist();
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain(`<key>${READER_TOKEN_ENV}</key>`);
    expect(xml).toContain("<string>t0ken</string>");
  });

  it("keeps the launchd contract the pair already had", () => {
    const xml = plist();
    expect(xml).toContain(`<string>${READER_LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>--serve</string>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    // Background Task Management groups the login item under the bundle name.
    expect(xml).toContain("<key>AssociatedBundleIdentifiers</key>");
  });
});

describe("minting the client-side rendezvous", () => {
  it("creates <state>/reader 0700 with a 0600 token, and returns that token", () => {
    const token = mintReaderRendezvous(env);
    expect(readerRendezvousDir(env)).toBe(join(stateDir, "reader"));
    expect(statSync(readerRendezvousDir(env)).mode & 0o777).toBe(0o700);
    expect(statSync(readerTokenPath(env)).mode & 0o777).toBe(0o600);
    expect(readFileSync(readerTokenPath(env), "utf8")).toBe(token);
    // 32 random bytes, hex — the shape the reader's own minting used.
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-permissions a token file that already exists — mode is not create-only", () => {
    mkdirSync(readerRendezvousDir(env), { recursive: true });
    writeFileSync(readerTokenPath(env), "stale", { mode: 0o644 });
    mintReaderRendezvous(env);
    expect(statSync(readerTokenPath(env)).mode & 0o777).toBe(0o600);
  });

  it("rotates the token per install — both ends are rewritten in one breath", () => {
    const first = mintReaderRendezvous(env);
    expect(mintReaderRendezvous(env)).not.toBe(first);
  });

  it("clears whatever sits at the socket path, so launchd's own bind cannot fail", () => {
    mkdirSync(readerRendezvousDir(env), { recursive: true });
    writeFileSync(readerSocketPath(env), "a stale file from an older layout");
    mintReaderRendezvous(env);
    expect(() => statSync(readerSocketPath(env))).toThrow();
  });
});
