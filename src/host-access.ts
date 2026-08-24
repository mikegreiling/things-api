/**
 * Host identity and the Full Disk Access probe
 * (docs/design/permissions-doctrine.md, Articles I and III).
 *
 * This module is deliberately dependency-light — it imports nothing that could
 * import it back — so the routing layer, the capability verdict, and the
 * helpers ceremonies can all consult the same prompt-free facts.
 *
 * Its facts serve DIRECT mode: whether this host app holds Full Disk Access,
 * and what to call it in copy. The helpers path needs none of them — since
 * helpers 1.3.0 the reader's rendezvous is a launchd-owned socket plus an
 * installer-minted token in `<state>/reader`, ordinary files this process owns,
 * so reaching the reader crosses no container boundary and raises no consent
 * class from any host.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, existsSync as realExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type SessionGrantDeps } from "./session-grant.ts";

/** The user TCC database. Readable iff the calling process holds Full Disk Access. */
const TCC_DB_RELATIVE = "Library/Application Support/com.apple.TCC/TCC.db";

/** The host app that macOS attributes this process's grants to (Article III). */
export interface HostApp {
  /**
   * The responsible process's bundle identifier when the environment names one
   * (`__CFBundleIdentifier`), else null. This is the TCC *client* identity —
   * the string a grant is recorded against.
   */
  bundleId: string | null;
  /** A display name for copy ("Ghostty", "Terminal"), or "this terminal". */
  name: string;
}

/** Seams for the host-identity and file-access probes; tests replace them all. */
export interface HostAccessDeps extends SessionGrantDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * Attempt the FDA-class read-open. Returns normally when the host holds Full
   * Disk Access; throws a Node fs error (EPERM when it does not) otherwise.
   */
  fdaProbe?: () => void;
  /** Resolve a running app's display name from its bundle id (LaunchServices). */
  lookupAppName?: (bundleId: string) => string | null;
}

// ── Host identity ────────────────────────────────────────────────────────────

/**
 * Terminals and agent harnesses whose display name we can state without asking
 * LaunchServices. Only an exec-free shortcut: an unlisted host still resolves,
 * it just pays one `lsappinfo` call on a copy path.
 */
const KNOWN_HOSTS: Readonly<Record<string, string>> = {
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm2",
  "com.mitchellh.ghostty": "Ghostty",
  "dev.warp.Warp-Stable": "Warp",
  "net.kovidgoyal.kitty": "kitty",
  "io.alacritty": "Alacritty",
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.anthropic.claude-code": "Claude Code",
  "com.anthropic.claudefordesktop": "Claude",
};

/** TERM_PROGRAM values, for hosts that set it but expose no bundle id. */
const TERM_PROGRAM_NAMES: Readonly<Record<string, string>> = {
  Apple_Terminal: "Terminal",
  iTerm: "iTerm2",
  "iTerm.app": "iTerm2",
  ghostty: "Ghostty",
  WarpTerminal: "Warp",
  vscode: "Visual Studio Code",
  Hyper: "Hyper",
  WezTerm: "WezTerm",
};

/** The fallback used everywhere a host cannot be named — never a guess. */
const ANONYMOUS_HOST = "this terminal";

let hostNameMemo: string | null = null;

function lookupAppNameDefault(bundleId: string): string | null {
  try {
    // LaunchServices knows the display name of every RUNNING app, which the
    // host terminal always is. Quoted-value output: "LSDisplayName"="Ghostty".
    const out = execFileSync("lsappinfo", ["info", "-only", "name", bundleId], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /"LSDisplayName"\s*=\s*"([^"]+)"/.exec(out);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The host app, resolved from the environment alone — no subprocess, so this is
 * safe on the hot path. `__CFBundleIdentifier` is set by macOS when a process
 * descends from an app bundle, which is how a terminal's shell (and everything
 * it spawns) carries its emulator's identity.
 */
export function hostApp(deps: HostAccessDeps = {}): HostApp {
  const env = deps.env ?? process.env;
  const bundleId = env["__CFBundleIdentifier"] ?? null;
  const termProgram = env["TERM_PROGRAM"] ?? "";
  const name =
    (bundleId !== null ? KNOWN_HOSTS[bundleId] : undefined) ??
    TERM_PROGRAM_NAMES[termProgram] ??
    ANONYMOUS_HOST;
  return { bundleId, name };
}

/**
 * The host app's display name for COPY. Identical to {@link hostApp}'s name
 * except for an unlisted bundle id, where LaunchServices is asked once per
 * process. Only call this from a path that is about to print.
 */
export function hostDisplayName(deps: HostAccessDeps = {}): string {
  if (hostNameMemo !== null) return hostNameMemo;
  const host = hostApp(deps);
  if (host.name !== ANONYMOUS_HOST || host.bundleId === null) {
    hostNameMemo = host.name;
    return hostNameMemo;
  }
  hostNameMemo = (deps.lookupAppName ?? lookupAppNameDefault)(host.bundleId) ?? ANONYMOUS_HOST;
  return hostNameMemo;
}

/** Test seam: forget the one memo this module keeps (the host's display name). */
export function resetHostAccessForTests(): void {
  hostNameMemo = null;
}

// ── The Full Disk Access probe ───────────────────────────────────────────────

/** Where the FDA probe reads. Exported so `doctor` and the ceremony can name it. */
export function tccDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env["HOME"] ?? homedir(), TCC_DB_RELATIVE);
}

export interface FdaVerdict {
  granted: boolean;
  /** The errno when the open failed, for honest reporting of the unexpected. */
  code: string | null;
}

function fdaProbeDefault(env: NodeJS.ProcessEnv): void {
  // ONE open(2), read-only, immediately closed. This file is FDA-class: macOS
  // answers it with a plain EPERM rather than a dialog, which is precisely why
  // the doctrine picks it as the probe (Article III). Deliberately NOT cached:
  // read capability is ground truth per invocation.
  const fd = openSync(tccDbPath(env), "r");
  closeSync(fd);
}

/**
 * Does the host app hold Full Disk Access? Prompt-free by construction. An
 * EPERM (or the sandbox's EACCES) is the ordinary "no"; any other errno is
 * reported as itself rather than folded into a false negative.
 */
export function fdaGranted(deps: HostAccessDeps = {}): FdaVerdict {
  const env = deps.env ?? process.env;
  try {
    (deps.fdaProbe ?? (() => fdaProbeDefault(env)))();
    return { granted: true, code: null };
  } catch (err) {
    return { granted: false, code: (err as NodeJS.ErrnoException).code ?? null };
  }
}

// ── EPERM-safe rendezvous reads ──────────────────────────────────────────────
//
// The rendezvous is ours now, so these are ordinary reads of ordinary files.
// The belt stays on anyway: a `stat`/`open` that ends in EPERM (a stray chmod,
// a filesystem that answers oddly) is a STATE to report, never a crash out of
// a routing probe, and never a second attempt.

/**
 * `existsSync` for a rendezvous path. It already swallows errno, but it is
 * wrapped anyway so no future refactor can turn a denial into a throw, and so
 * every rendezvous touch reads the same at the call site.
 */
export function rendezvousExists(path: string): boolean {
  try {
    return realExistsSync(path);
  } catch {
    return false;
  }
}

/**
 * Read the reader's access token. Returns null instead of throwing when the
 * read fails (ENOENT before the first install; EPERM if something outside our
 * flows re-permissioned the file).
 */
export function readRendezvousToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}
