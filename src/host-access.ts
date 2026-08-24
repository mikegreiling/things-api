/**
 * Host identity, the Full Disk Access probe, and the reader-container guard
 * (docs/design/permissions-doctrine.md, Articles I and III).
 *
 * This module is deliberately dependency-light — it imports nothing that could
 * import it back — so the routing layer, the capability verdict, and the
 * helpers ceremonies can all consult the same prompt-free facts.
 *
 * ── Why the reader-container guard exists ───────────────────────────────────
 *
 * The sandboxed reader's rendezvous files (its socket and its access token)
 * live INSIDE its App Sandbox container, `~/Library/Containers/
 * com.pixelcog.things-reader/Data`. That is another application's container, so
 * every client-side `stat`/`open` on those paths is a cross-app container
 * access — the `kTCCServiceSystemPolicyAppData` consent class, the same one the
 * Things group container sits behind. Under a host app that holds Full Disk
 * Access macOS answers it silently, which is why the whole reader path looked
 * host-neutral for as long as it was only ever exercised from an FDA terminal.
 * From ANY other host it raises the "would like to access data from other apps"
 * modal — outside a ceremony, which Article I forbids — and a denial then turns
 * the token read into a raw EPERM crash.
 *
 * So no probe touches the rendezvous unless it can PROVE the touch is
 * prompt-free. The proof is {@link readerContainerAccessible}; when it says no,
 * the reader is reported as `unreachable` (an honest third state, distinct from
 * "not installed" and from "installed but not answering") and reads fall
 * through to the direct verdict — which on a grant-less host is the doctrine's
 * loud refusal. That scoping matters: the no-fallback rule governs a reader
 * that is REACHABLE and failing, not a host that cannot see the rendezvous at
 * all.
 *
 * This is an INTERIM rule. The durable fix is to move the rendezvous out of the
 * sandbox container entirely (launchd's `Sockets` key hands the reader a
 * listening fd at a host-neutral path, so the reader never opens it and the
 * client never crosses a container boundary); it is tracked in docs/up-next.md.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, existsSync as realExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readerDirOverride } from "./deputy/protocol.ts";
import { sessionGrantValid, type SessionGrantDeps } from "./session-grant.ts";

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

// ── The reader-container guard ───────────────────────────────────────────────

/**
 * May this process touch the reader's rendezvous files WITHOUT risking a
 * consent dialog? True in exactly three cases, and nothing here touches the
 * container to find out:
 *
 *  1. `THINGS_API_READER_DIR` names the rendezvous — that is an ordinary
 *     directory the caller chose (mock readers in tests and in the lab), not an
 *     App Sandbox container, so no cross-app rule applies;
 *  2. the host app holds Full Disk Access — one `open(2)` on an FDA-class file,
 *     which never prompts;
 *  3. a ceremony witnessed the instance-scoped app-data grant and it is still
 *     live — that grant IS the "access data from other apps" class, so it
 *     covers another app's container exactly as it covers Things' own.
 */
export function readerContainerAccessible(deps: HostAccessDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if (readerDirOverride(env) !== null) return true;
  if (fdaGranted(deps).granted) return true;
  return sessionGrantValid(hostApp(deps).bundleId, deps).valid;
}

/** The one honest reason string a guarded probe reports when it may not look. */
export const READER_UNREACHABLE_REASON =
  "this host cannot verify or reach the reader without durable file access";

/** The single remediation line every unreachable-reader surface prints. */
export function readerUnreachableRemedy(deps: HostAccessDeps = {}): string {
  return (
    `grant Full Disk Access to ${hostDisplayName(deps)}, run \`things setup\`, or use a host ` +
    "with access — reader routing is host-gated today; a fix is queued"
  );
}

// ── EPERM-safe rendezvous reads ──────────────────────────────────────────────

/**
 * `existsSync` for a rendezvous path. It already swallows errno, but it is
 * wrapped anyway so no future refactor can turn a TCC denial into a throw, and
 * so every container touch reads the same at the call site.
 */
export function rendezvousExists(path: string): boolean {
  try {
    return realExistsSync(path);
  } catch {
    return false;
  }
}

/**
 * Read the reader's access token. Returns null instead of throwing when macOS
 * refuses (EPERM/EACCES after a denial, ENOENT when the reader never wrote
 * one). A refusal is a state to report, never a crash, and never a second
 * attempt that could raise the modal again.
 */
export function readRendezvousToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}
