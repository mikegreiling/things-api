/**
 * things-deputy wire protocol: shared constants, request/response shapes, and
 * path resolution for the broker's socket, token, and state directory.
 *
 * The helpers (deputy/src, deputy/reader) are deliberately dumb privileged
 * proxies — the deputy runs fixed-shape osascript/shortcuts (mutations), the
 * sandboxed reader serves read-only SQL and scoped file reads — so that macOS
 * permission grants attach to their stable signed identities instead of
 * whichever agent harness invokes the CLI. All product logic stays here in the
 * library; the protocol therefore carries raw primitives, never operations.
 * See docs/design/agent-daemon.md (§β1, §3b).
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { stateDir } from "../paths.ts";

export const DEPUTY_PROTOCOL_VERSION = 1;

/**
 * The helpers version this package expects — the helpers are versioned on
 * their OWN line (deputy/VERSION), decoupled from the package version, so a
 * package release whose helper sources are unchanged never nags for (or
 * forces) a reinstall of a byte-equivalent bundle. Bump deputy/VERSION with
 * any helper-source change; a drift test asserts this constant matches it.
 * The PROTOCOL version above remains the hard compatibility gate.
 */
export const EXPECTED_HELPERS_VERSION = "1.2.0";

/** The outer helper bundle's identifier (Things API Helper.app) — TCC + BTM identity. */
export const HELPERS_BUNDLE_ID = "com.pixelcog.things-api-helper";

/** launchd label (and signing identifier) of the broker. */
export const DEPUTY_LAUNCHD_LABEL = "com.pixelcog.things-deputy";

/**
 * The deputy derives its own state dir from the same THINGS_API_STATE_DIR /
 * XDG_STATE_HOME precedence as the library (deputy/src/main.swift mirrors
 * this), so pointing both sides at one env is all a test needs.
 */
export function deputyStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "deputy");
}

export function deputySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(deputyStateDir(env), "deputy.sock");
}

export function deputyTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(deputyStateDir(env), "token");
}

/**
 * The directory `helpers install` owns WHOLESALE: it is deleted and recreated
 * on every install, so any previous layout (however old) is erased without
 * dedicated migration logic, and the fresh inodes reset the kernel's
 * per-vnode code-signature cache (copying over an executed inode makes every
 * future exec die with SIGKILL — observed live 2026-08-21).
 */
export function helpersInstallDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(deputyStateDir(env), "bin");
}

/** Where `helpers install` places the bundle. */
export function helpersInstalledBundlePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(helpersInstallDir(env), "Things API Helper.app");
}

/** The installed deputy executable (the bundle's main executable). */
export function deputyInstalledBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(helpersInstalledBundlePath(env), "Contents/MacOS/things-deputy");
}

/** The installed nested reader app. */
export function readerInstalledAppPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(helpersInstalledBundlePath(env), "Contents/Helpers/things-reader.app");
}

/** launchd label (and bundle identifier) of the sandboxed reader. */
export const READER_LAUNCHD_LABEL = "com.pixelcog.things-reader";

/**
 * The reader's state lives in its App Sandbox container home — the OS picks
 * the path from the bundle identifier. THINGS_API_READER_DIR overrides for
 * tests (a mock reader is just a socket; no sandbox involved).
 */
export function readerContainerDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["THINGS_API_READER_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;
  return join(homedir(), "Library/Containers", READER_LAUNCHD_LABEL, "Data");
}

export function readerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(readerContainerDir(env), "reader.sock");
}

export function readerTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(readerContainerDir(env), "token");
}

/** Reader handshake: DeputyHello plus the grant state. */
export interface ReaderHello extends DeputyHello {
  role: "reader";
  /** False until the one-time open-panel ceremony has granted the folder. */
  granted: boolean;
}

export interface DeputyErrorShape {
  code: string;
  message: string;
}

/** A protocol-level failure (the deputy answered `ok:false`, or never answered). */
export class DeputyRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeputyRequestError";
    this.code = code;
  }
}

/**
 * One Automation target's standing, as the deputy reads it prompt-free:
 * `not-running` means the target was not up, so macOS had no answer to give;
 * `unknown` covers "never asked" (the consent record does not exist yet) and
 * anything unrecognized. Only `granted` lets the ceremony skip that leg.
 */
export type AutomationPermission = "granted" | "denied" | "not-running" | "unknown";

export interface DeputyAutomationStatus {
  things: AutomationPermission;
  systemEvents: AutomationPermission;
}

export interface DeputyHello {
  protocol: number;
  deputyVersion: string;
  pid: number;
  /** Reader only: its cached container-db resolution (absent on the deputy). */
  dbPath?: string | null;
  uptimeMs: number;
  /**
   * The deputy's own Accessibility trust. Absent on helpers older than 1.2.0
   * (and on the reader, which drives nothing) — absent means "unknown", never
   * "false".
   */
  axTrusted?: boolean;
  /** The deputy's Automation standing per target. Absent on helpers older than 1.2.0. */
  automation?: DeputyAutomationStatus;
}

/**
 * osascript outcome as the deputy reports it. `ok:true` at the protocol level
 * means "the deputy ran osascript" — a failing script is exitCode ≠ 0 here,
 * exactly as execFile would report it, so vector-side classification logic
 * reads the same signals on both paths.
 */
export interface DeputyOsaResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Present when osascript died to a signal (number, e.g. 15 for SIGTERM). */
  signal?: number;
}

export type DeputyRow = Record<string, unknown>;

/** BLOB columns cross the wire as `{ "$b64": <base64> }`; revive to Uint8Array. */
export function reviveRow(row: DeputyRow): DeputyRow {
  for (const [key, value] of Object.entries(row)) {
    if (
      value !== null &&
      typeof value === "object" &&
      "$b64" in value &&
      typeof (value as { $b64: unknown }).$b64 === "string"
    ) {
      row[key] = new Uint8Array(Buffer.from((value as { $b64: string }).$b64, "base64"));
    }
  }
  return row;
}
