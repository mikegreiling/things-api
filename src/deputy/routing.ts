/**
 * Deputy routing: decides ONCE per process whether privileged primitives (SQL
 * reads, osascript, container file reads) go through the things-deputy broker
 * or run direct exactly as they always have.
 *
 * Mode resolution (highest wins): the CLI `--helpers/--no-helpers` flag (which
 * writes THINGS_API_HELPERS before any load) → THINGS_API_HELPERS env → stored
 * `helpers-enabled` config → default `auto`. Direct execution is the contract's
 * ground truth; the helpers are an alternative transport for the same
 * primitives.
 *
 * The tri-state (docs/design/agent-daemon.md §3c):
 *
 * | mode    | helper absent            | installed, unhealthy | installed, healthy |
 * |---------|--------------------------|----------------------|--------------------|
 * | `auto`  | direct, SILENT           | direct, LOUD         | routed             |
 * | `true`  | direct, LOUD             | direct, LOUD         | routed             |
 * | `false` | direct, silent           | direct, silent       | direct, silent     |
 *
 * Under `auto` installation IS the intent signal, so absence is not a
 * degradation to report (a fresh machine must not nag) while an installed
 * helper that cannot serve is — silence there would hide the very consent churn
 * the helpers exist to end.
 *
 * Fallback is decided at ACTIVATION, never mid-operation: if a helper is
 * expected but unreachable (or speaks a different protocol), the whole process
 * runs direct with one stderr notice — a half-routed operation is worse than
 * an honestly direct one. A helper that dies mid-request surfaces as that
 * request's error; it is never silently retried on the other path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { type HelpersMode, loadConfig } from "../config.ts";
import { DeputySyncBridge } from "./bridge.ts";
import { DeputyAsyncClient } from "./client.ts";
import { emitHelpersNotice, resetHelpersNoticeForTests } from "./notice.ts";
import {
  DEPUTY_LAUNCHD_LABEL,
  DEPUTY_PROTOCOL_VERSION,
  type DeputyHello,
  DeputyRequestError,
  deputyInstalledBinaryPath,
  deputySocketPath,
  deputyTokenPath,
  EXPECTED_HELPERS_VERSION,
  type ReaderHello,
  readerInstalledAppPath,
  readerSocketPath,
  readerTokenPath,
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

/**
 * The sandboxed reader transport (file verbs only). Activated lazily and
 * independently of the deputy: either half may be installed alone. `granted`
 * mirrors the reader's bookmark state — a present-but-ungranted reader is NOT
 * used (the deputy, or direct access, still serves reads until the ceremony).
 */
interface ReaderState {
  active: boolean;
  granted: boolean;
  hello: ReaderHello | null;
  token: string;
  bridge: DeputySyncBridge | null;
  dbPathMemo?: string | null;
  reason: string | null;
}

let state: RoutingState | null = null;
let readerState: ReaderState | null = null;

/** Test seam: forget the per-process activation memo (and close transports). */
export function resetDeputyRoutingForTests(): void {
  if (state?.active === true) {
    state.bridge.close();
    state.client.close();
  }
  readerState?.bridge?.close();
  state = null;
  readerState = null;
  resetHelpersNoticeForTests();
}

/**
 * Report a degradation — but only when the mode asks to hear about it. Under
 * `auto` an ABSENT helper is an ordinary machine, not a fault: `loud` is false
 * there and the process just runs direct.
 */
function notice(loud: boolean, message: string): void {
  if (loud) emitHelpersNotice(message);
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
 * the wire cannot be trusted). The helpers are versioned on their own line
 * (EXPECTED_HELPERS_VERSION, decoupled from the package version so unchanged
 * helpers never nag across package releases); a helpers-version mismatch on
 * matching protocol gets one automatic `launchctl kickstart` (the installed
 * bundle may already be newer on disk — the daily npm-link reality), then
 * proceeds with a notice: the helpers' verbs are dumb primitives, so
 * cross-version execution is safe by construction as long as the protocol
 * matches.
 */
function reconcileVersions(
  bridge: DeputySyncBridge,
  token: string,
  first: DeputyHello,
): DeputyHello {
  if (first.deputyVersion === EXPECTED_HELPERS_VERSION) return first;
  try {
    execFileSync(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${DEPUTY_LAUNCHD_LABEL}`],
      // Clears the helpers' drain bound: kickstart -k waits for the old
      // process, which finishes an in-flight request before exiting.
      { stdio: "ignore", timeout: 30_000 },
    );
  } catch {
    // Not installed under launchd (foreground/test deputy) — nothing to restart.
    notice(
      true,
      `installed helpers are v${first.deputyVersion}, this package expects v${EXPECTED_HELPERS_VERSION} (same protocol) — proceeding; rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers install\` to align`,
    );
    return first;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    syncSleep(250);
    try {
      const fresh = hello(bridge, token);
      if (fresh.deputyVersion === EXPECTED_HELPERS_VERSION) return fresh;
    } catch {
      // Restart still in flight — keep waiting out the bounded window.
    }
  }
  const current = hello(bridge, token);
  notice(
    true,
    `installed helpers are v${current.deputyVersion}, this package expects v${EXPECTED_HELPERS_VERSION} (same protocol) — proceeding; rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers install\` to align`,
  );
  return current;
}

/**
 * Is a helper half INSTALLED on this machine? Installation is what separates
 * "this host does not use the helpers" (silent under `auto`) from "the helper
 * this host installed cannot serve" (always loud). The installed bundle on disk
 * is the durable signal — a stopped launchd job leaves no socket but the bundle
 * stays put.
 */
function halfInstalled(path: string, socketPath: string, tokenPath: string): boolean {
  return existsSync(path) || (existsSync(socketPath) && existsSync(tokenPath));
}

function activate(env: NodeJS.ProcessEnv): RoutingState {
  const mode: HelpersMode = loadConfig(env).helpersMode;
  if (mode === "false") return { active: false, reason: "disabled", hello: null };

  const socketPath = deputySocketPath(env);
  const tokenPath = deputyTokenPath(env);
  const installed = halfInstalled(deputyInstalledBinaryPath(env), socketPath, tokenPath);
  // `auto` + nothing installed = an ordinary un-onboarded machine, not a fault.
  const loud = mode === "true" || installed;
  if (!existsSync(socketPath) || !existsSync(tokenPath)) {
    notice(
      loud,
      `${
        installed
          ? `installed but not running (no socket at ${socketPath})`
          : "not installed on this machine"
      } — running DIRECT, so TCC prompts attach to this process. \`things helpers ${
        installed ? "status` to inspect" : "install` to change that"
      }.`,
    );
    return {
      active: false,
      reason: installed
        ? `deputy not running (no socket at ${socketPath})`
        : "deputy not installed",
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
    // A socket that will not handshake is a broken helper under EVERY non-off
    // mode — never silent, whatever the mode says about absence.
    notice(
      true,
      `the handshake failed (${why}) — running DIRECT. \`things helpers restart\`, then \`things helpers status\` to inspect.`,
    );
    return { active: false, reason: `handshake failed: ${why}`, hello: null };
  }
  if (helloResult.protocol !== DEPUTY_PROTOCOL_VERSION) {
    bridge.close();
    notice(
      true,
      `the deputy speaks protocol ${helloResult.protocol}, this package speaks ${DEPUTY_PROTOCOL_VERSION} — running DIRECT. Rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers install\`.`,
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

function readerInactive(reason: string): ReaderState {
  return { active: false, granted: false, hello: null, token: "", bridge: null, reason };
}

function activateReader(env: NodeJS.ProcessEnv): ReaderState {
  const mode: HelpersMode = loadConfig(env).helpersMode;
  if (mode === "false") return readerInactive("disabled");
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  const installed = halfInstalled(readerInstalledAppPath(env), socketPath, tokenPath);
  if (!existsSync(socketPath) || !existsSync(tokenPath)) {
    // Absence is silent under `auto`; under `true` the caller asserted routing.
    // An UNGRANTED reader is deliberately NOT noticed here — that is the
    // ceremony's own state, reported by `things helpers status` and doctor.
    notice(
      mode === "true" || installed,
      installed
        ? `the reader is installed but not running (no socket at ${socketPath}) — database reads run DIRECT. \`things helpers status\` to inspect.`
        : "the reader is not installed on this machine — database reads run DIRECT. `things helpers install` to change that.",
    );
    return readerInactive(
      installed ? `reader not running (no socket at ${socketPath})` : "reader not installed",
    );
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  const bridge = new DeputySyncBridge(socketPath);
  try {
    const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
    if (res["ok"] !== true) throw new DeputyRequestError("handshake", JSON.stringify(res["error"]));
    const readerHello = res as unknown as ReaderHello;
    if (readerHello.protocol !== DEPUTY_PROTOCOL_VERSION) {
      bridge.close();
      notice(
        true,
        `the reader speaks protocol ${readerHello.protocol}, this package speaks ${DEPUTY_PROTOCOL_VERSION} — database reads run DIRECT. Rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers install\`.`,
      );
      return readerInactive(`protocol skew (reader ${readerHello.protocol})`);
    }
    return {
      active: true,
      granted: readerHello.granted === true,
      hello: readerHello,
      token,
      bridge,
      reason: null,
    };
  } catch (err) {
    bridge.close();
    const why = err instanceof Error ? err.message : String(err);
    notice(
      true,
      `the reader handshake failed (${why}) — database reads run DIRECT. \`things helpers restart\`, then \`things helpers status\` to inspect.`,
    );
    return readerInactive(`reader handshake failed: ${why}`);
  }
}

/** The reader transport's state (activated lazily; test seam via reset). */
export function readerRouting(env: NodeJS.ProcessEnv = process.env): {
  active: boolean;
  granted: boolean;
  hello: ReaderHello | null;
  reason: string | null;
} {
  readerState ??= activateReader(env);
  return readerState;
}

/**
 * The transport serving FILE verbs (sql / read-file / locate): the sandboxed
 * reader when present AND granted, else null (direct local access). ONLY the
 * reader — the deputy is mutations-only by design (the maintainer's ruling
 * 2026-08-21: no multi-step fallback chains; its container access would ride
 * the per-process consent class this pair exists to end). A reader that dies
 * mid-request errors that request honestly, never a silent transport switch.
 */
function fileTransport(env: NodeJS.ProcessEnv): { bridge: DeputySyncBridge; token: string } | null {
  const reader = readerRouting(env);
  if (reader.active && reader.granted) {
    const rs = readerState as ReaderState;
    return { bridge: rs.bridge as DeputySyncBridge, token: rs.token };
  }
  return null;
}

/**
 * What routing actually RESOLVED to in this process: the configured mode plus
 * whether each half is carrying traffic. Activates both halves (memoized), so
 * it reports the same decision every other call in this process sees — doctor's
 * helpers section reads it rather than re-deriving one.
 */
export interface HelpersRouting {
  mode: HelpersMode;
  /** Automation verbs (osascript/shortcuts) ride the deputy. */
  automation: boolean;
  /** File verbs (sql/read-file/locate) ride the granted reader. */
  files: boolean;
  /** Why automation is not routed (null when it is). */
  deputyReason: string | null;
  /** Why file verbs are not routed (null when they are). */
  readerReason: string | null;
}

export function helpersRouting(env: NodeJS.ProcessEnv = process.env): HelpersRouting {
  const mode = loadConfig(env).helpersMode;
  const deputy = deputyRouting(env);
  const reader = readerRouting(env);
  const files = deputyFilesActive(env);
  return {
    mode,
    automation: deputy.active,
    files,
    deputyReason: deputy.reason,
    readerReason: files
      ? null
      : reader.active && !reader.granted
        ? "reader running but NOT granted (things helpers grant)"
        : reader.reason,
  };
}

/** True when file verbs ride the reader (present, protocol-matched, granted). */
export function deputyFilesActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return fileTransport(env) !== null;
}

/** Blocking FILE-verb round-trip via the granted reader. */
export function fileSyncRequest(
  fields: Record<string, unknown>,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const transport = fileTransport(env);
  if (transport === null) {
    throw new DeputyRequestError("inactive", "the reader is not active");
  }
  return unwrap(
    transport.bridge.request(
      { v: DEPUTY_PROTOCOL_VERSION, token: transport.token, ...fields },
      timeoutMs,
    ),
  );
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
 * The reader-resolved container database path, or null when no granted reader
 * is active (the caller then locates locally, exactly as before the helpers
 * existed). The reader's scope is grant-checked, never prompted — a locate
 * through it can refuse but can never stall on a consent dialog.
 */
export function deputyDbPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const reader = readerRouting(env);
  if (!reader.active || !reader.granted) return null;
  if (reader.hello?.dbPath != null) return reader.hello.dbPath;
  const rs = readerState as ReaderState;
  if (rs.dbPathMemo !== undefined) return rs.dbPathMemo;
  try {
    const res = fileSyncRequest({ verb: "locate" }, 10_000, env);
    rs.dbPathMemo = typeof res["path"] === "string" ? res["path"] : null;
  } catch (err) {
    rs.dbPathMemo = null;
    const why = err instanceof Error ? err.message : String(err);
    emitHelpersNotice(`the reader could not resolve the database (${why}) — this read runs DIRECT`);
  }
  return rs.dbPathMemo;
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
  return deputyFilesActive(env);
}
