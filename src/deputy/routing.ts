/**
 * Deputy routing: decides ONCE per process whether privileged primitives (SQL
 * reads, osascript, container file reads) go through the things-deputy broker
 * or run direct exactly as they always have.
 *
 * Mode resolution (highest wins): the CLI `--deputy/--no-deputy` flag (which
 * writes THINGS_API_DEPUTY before any load) → THINGS_API_DEPUTY env → stored
 * `deputy-enabled` config → default OFF. Direct execution is the contract's
 * ground truth; the deputy is an alternative transport for the same
 * primitives.
 *
 * Fallback is decided at ACTIVATION, never mid-operation: if the deputy is
 * enabled but unreachable (or speaks a different protocol), the whole process
 * runs direct with one stderr notice — a half-routed operation is worse than
 * an honestly direct one. A deputy that dies mid-request surfaces as that
 * request's error; it is never silently retried on the other path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../config.ts";
import { PKG_VERSION } from "../contracts.ts";
import { DeputySyncBridge } from "./bridge.ts";
import { DeputyAsyncClient } from "./client.ts";
import {
  DEPUTY_LAUNCHD_LABEL,
  DEPUTY_PROTOCOL_VERSION,
  type DeputyHello,
  DeputyRequestError,
  deputySocketPath,
  deputyTokenPath,
} from "./protocol.ts";

export interface DeputyRouting {
  /** True when requests are actually flowing to the deputy. */
  readonly active: boolean;
  /** Why routing is inactive ("disabled", or the activation failure). */
  readonly reason: string | null;
  /** Handshake result when active. */
  readonly hello: DeputyHello | null;
}

interface ActiveState {
  active: true;
  reason: null;
  hello: DeputyHello;
  token: string;
  bridge: DeputySyncBridge;
  client: DeputyAsyncClient;
  /** Memoized `locate` result (undefined = not asked yet this process). */
  dbPathMemo?: string | null;
}

interface InactiveState {
  active: false;
  reason: string;
  hello: null;
}

type RoutingState = ActiveState | InactiveState;

let state: RoutingState | null = null;
let noticed = false;

/** Test seam: forget the per-process activation memo (and close transports). */
export function resetDeputyRoutingForTests(): void {
  if (state?.active === true) {
    state.bridge.close();
    state.client.close();
  }
  state = null;
  noticed = false;
}

function notice(message: string): void {
  if (noticed) return;
  noticed = true;
  process.stderr.write(`things-api deputy: ${message}\n`);
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function hello(bridge: DeputySyncBridge, token: string): DeputyHello {
  const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
  if (res["ok"] !== true) {
    const err = res["error"] as { code?: string; message?: string } | undefined;
    throw new DeputyRequestError(err?.code ?? "internal", err?.message ?? "handshake refused");
  }
  return res as unknown as DeputyHello;
}

/**
 * Version-skew policy: a PROTOCOL mismatch always deactivates (the shapes on
 * the wire cannot be trusted). A package-version mismatch on matching protocol
 * gets one automatic `launchctl kickstart` (the installed binary may already
 * be newer on disk — the daily npm-link reality), then proceeds with a notice:
 * the broker's verbs are dumb primitives, so cross-version execution is safe
 * by construction as long as the protocol matches.
 */
function reconcileVersions(
  bridge: DeputySyncBridge,
  token: string,
  first: DeputyHello,
): DeputyHello {
  if (first.deputyVersion === PKG_VERSION) return first;
  try {
    execFileSync(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${DEPUTY_LAUNCHD_LABEL}`],
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    // Not installed under launchd (foreground/test deputy) — nothing to restart.
    notice(
      `deputy is v${first.deputyVersion}, library is v${PKG_VERSION} (same protocol) — proceeding; rebuild with scripts/build-deputy.sh + \`things deputy restart\` to align`,
    );
    return first;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    syncSleep(250);
    try {
      const fresh = hello(bridge, token);
      if (fresh.deputyVersion === PKG_VERSION) return fresh;
    } catch {
      // Restart still in flight — keep waiting out the bounded window.
    }
  }
  const current = hello(bridge, token);
  notice(
    `deputy is v${current.deputyVersion}, library is v${PKG_VERSION} (same protocol) — proceeding; rebuild + \`things deputy restart\` to align`,
  );
  return current;
}

function activate(env: NodeJS.ProcessEnv): RoutingState {
  const cfg = loadConfig(env);
  if (!cfg.deputyEnabled) return { active: false, reason: "disabled", hello: null };

  const socketPath = deputySocketPath(env);
  const tokenPath = deputyTokenPath(env);
  if (!existsSync(socketPath) || !existsSync(tokenPath)) {
    notice(
      `enabled but not running (no socket at ${socketPath}) — running DIRECT, so TCC prompts attach to this process. \`things deputy status\` to inspect.`,
    );
    return {
      active: false,
      reason: `deputy not running (no socket at ${socketPath})`,
      hello: null,
    };
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  const bridge = new DeputySyncBridge(socketPath);
  let helloResult: DeputyHello;
  try {
    helloResult = reconcileVersions(bridge, token, hello(bridge, token));
  } catch (err) {
    bridge.close();
    const why = err instanceof Error ? err.message : String(err);
    notice(
      `enabled but the handshake failed (${why}) — running DIRECT. \`things deputy status\` to inspect.`,
    );
    return { active: false, reason: `handshake failed: ${why}`, hello: null };
  }
  if (helloResult.protocol !== DEPUTY_PROTOCOL_VERSION) {
    bridge.close();
    notice(
      `deputy speaks protocol ${helloResult.protocol}, library speaks ${DEPUTY_PROTOCOL_VERSION} — running DIRECT. Rebuild + \`things deputy restart\`.`,
    );
    return {
      active: false,
      reason: `protocol skew (deputy ${helloResult.protocol}, library ${DEPUTY_PROTOCOL_VERSION})`,
      hello: null,
    };
  }
  return {
    active: true,
    reason: null,
    hello: helloResult,
    token,
    bridge,
    client: new DeputyAsyncClient(socketPath),
  };
}

/** The per-process routing decision (activated lazily on first ask). */
export function deputyRouting(env: NodeJS.ProcessEnv = process.env): DeputyRouting {
  state ??= activate(env);
  return state;
}

function activeState(env: NodeJS.ProcessEnv): ActiveState | null {
  const routing = deputyRouting(env);
  return routing.active ? (state as ActiveState) : null;
}

/** Unwrap a protocol response: return it on ok, throw DeputyRequestError otherwise. */
function unwrap(res: Record<string, unknown>): Record<string, unknown> {
  if (res["ok"] === true) return res;
  const err = res["error"] as { code?: string; message?: string } | undefined;
  throw new DeputyRequestError(
    err?.code ?? "internal",
    err?.message ?? "deputy refused the request",
  );
}

/** Blocking round-trip via the bridge (facade + sync probes only). */
export function deputySyncRequest(
  fields: Record<string, unknown>,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const active = activeState(env);
  if (active === null) throw new DeputyRequestError("inactive", "deputy routing is not active");
  return unwrap(
    active.bridge.request(
      { v: DEPUTY_PROTOCOL_VERSION, token: active.token, ...fields },
      timeoutMs,
    ),
  );
}

/** Event-loop-friendly round-trip (vector dispatch). */
export async function deputyAsyncRequest(
  fields: Record<string, unknown>,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const active = activeState(env);
  if (active === null) throw new DeputyRequestError("inactive", "deputy routing is not active");
  return unwrap(
    await active.client.request(
      { v: DEPUTY_PROTOCOL_VERSION, token: active.token, ...fields },
      timeoutMs,
    ),
  );
}

/**
 * A first container touch on an ungranted machine blocks in the kernel until
 * the user answers the macOS consent prompt — give the human time to find it.
 */
const FIRST_CONTACT_LOCATE_TIMEOUT_MS = 90_000;

/**
 * The deputy-resolved container database path, or null when the deputy is
 * inactive or cannot resolve one. The handshake never touches the protected
 * container (a consent stall there would deadlock every client), so on first
 * contact this asks the `locate` verb — the request the grant ceremony rides,
 * deliberately allowed to stall while the user answers the consent prompt.
 */
export function deputyDbPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const active = activeState(env);
  if (active === null) return null;
  if (active.hello.dbPath !== null) return active.hello.dbPath;
  if (active.dbPathMemo !== undefined) return active.dbPathMemo;
  process.stderr.write(
    "things-api deputy: first database access through the helper — if macOS shows a consent prompt for things-deputy, approve it (waiting up to 90s)\n",
  );
  try {
    const res = deputySyncRequest({ verb: "locate" }, FIRST_CONTACT_LOCATE_TIMEOUT_MS, env);
    active.dbPathMemo = typeof res["path"] === "string" ? res["path"] : null;
  } catch (err) {
    active.dbPathMemo = null;
    const why = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `things-api deputy: could not resolve the database through the helper (${why}) — this read runs DIRECT\n`,
    );
  }
  return active.dbPathMemo;
}

/**
 * Should DATABASE access route through the deputy? Only for the default
 * container database: an explicit dbPath option or THINGS_DB env names a
 * caller-chosen file (lab clones, fixtures) the deputy knows nothing about —
 * those always open locally, deputy or no deputy.
 */
export function deputyRoutesDb(
  options: { dbPath?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options?.dbPath !== undefined || (env["THINGS_DB"] ?? "") !== "") return false;
  return deputyRouting(env).active;
}
