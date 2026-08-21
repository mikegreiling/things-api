/**
 * things-deputy wire protocol: shared constants, request/response shapes, and
 * path resolution for the broker's socket, token, and state directory.
 *
 * The deputy (deputy/src/*.swift) is a deliberately dumb privileged proxy —
 * read-only SQL, fixed-shape osascript, container-scoped file reads — so that
 * macOS TCC grants attach to its one stable signed identity instead of
 * whichever agent harness invokes the CLI. All product logic stays here in the
 * library; the protocol therefore carries raw primitives, never operations.
 * See docs/design/agent-daemon.md (§β1).
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { stateDir } from "../paths.ts";

export const DEPUTY_PROTOCOL_VERSION = 1;

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

export interface DeputyHello {
  protocol: number;
  deputyVersion: string;
  pid: number;
  dbPath: string | null;
  uptimeMs: number;
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
