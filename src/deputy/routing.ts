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
 * | mode    | helper absent  | installed, unhealthy | healthy, NOT onboarded | healthy + onboarded |
 * |---------|----------------|----------------------|------------------------|---------------------|
 * | `auto`  | direct, SILENT | direct, LOUD         | direct, LOUD           | routed              |
 * | `true`  | direct, LOUD   | direct, LOUD         | routed                 | routed              |
 * | `false` | direct, silent | direct, silent       | direct, silent         | direct, silent      |
 *
 * Under `auto` installation IS the intent signal, so absence is not a
 * degradation to report (a fresh machine must not nag) while an installed
 * helper that cannot serve is — silence there would hide the very consent churn
 * the helpers exist to end.
 *
 * There is no "installed but unpermissioned" routing state under `auto`: a
 * deputy without an app-control grant for Things would move the consent dialog
 * onto the helper, where nobody is watching for it, so it stays DORMANT until
 * `things helpers setup` proves the grant. Each half is gated on its OWN
 * requisite — writes on the deputy's `automation.things`, reads on the
 * reader's bookmark grant — so a machine that finished half the ceremony gets
 * the half it earned. Accessibility and System Events are NOT requisite: the
 * UI vector is separately double-gated and refuses on its own.
 *
 * The one answer that gate cannot judge is `not-running`: with Things closed,
 * macOS has no determination to give, so the value describes the app's PROCESS
 * and not its grant (#617). Deactivating on it would drop a fully onboarded
 * machine onto the direct path every time its owner quit the app. That case is
 * DEFERRED instead — active, `automationUnproven` — and settled by the write
 * gate, which is the one caller allowed to start the target (./wake.ts).
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
import { readRendezvousToken, rendezvousExists } from "../host-access.ts";
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
  /**
   * `auto` only: the deputy answered `not-running` for Things, so the onboarding
   * gate could not be judged — a closed app is a liveness fact, not a missing
   * grant (#617). The state is active on that deferral and must be settled by
   * {@link settleDeputyAutomation} once a caller with dispatch intent has woken
   * the target and re-read the standing.
   */
  automationUnproven?: boolean;
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
      `installed helpers are v${first.deputyVersion}, this package expects v${EXPECTED_HELPERS_VERSION} (same protocol) — proceeding; rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers setup\` to align`,
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
    `installed helpers are v${current.deputyVersion}, this package expects v${EXPECTED_HELPERS_VERSION} (same protocol) — proceeding; rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers setup\` to align`,
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
        installed ? "status` to inspect" : "setup` to change that"
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
      `the deputy speaks protocol ${helloResult.protocol}, this package speaks ${DEPUTY_PROTOCOL_VERSION} — running DIRECT. Rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers setup\`.`,
    );
    return {
      active: false,
      reason: `protocol skew (deputy ${helloResult.protocol}, library ${DEPUTY_PROTOCOL_VERSION})`,
      hello: null,
    };
  }
  // The onboarding gate. Routing writes through a deputy that has no
  // app-control grant for Things does not move the consent surface anywhere —
  // it just relocates the dialog to the helper, where nobody is looking. Under
  // `auto` (installation is the intent signal, not a promise) the deputy must
  // PROVE the grant before it carries traffic; `true` is an explicit
  // instruction to route regardless and stays loud on failure.
  const automationThings = helloResult.automation?.things;
  if (mode === "auto" && automationThings === "not-running") {
    // LIVENESS, NOT AUTHORIZATION (#617). A closed Things is what makes the
    // deputy's ask-false determination answer procNotFound, so `not-running`
    // says nothing about the grant — and a machine whose owner simply quit the
    // app would be deactivated here, printed a notice claiming a missing
    // permission, and dropped onto the direct path the helpers exist to end.
    // The decision is DEFERRED instead: the deputy stays active but UNPROVEN,
    // and the write gate settles it (wake the target, re-read the standing,
    // then {@link settleDeputyAutomation}) before anything is dispatched.
    // Nothing is launched from here — activation happens on every invocation,
    // including pure reads and `doctor`, and none of those may start the user's
    // app as a side effect.
    return {
      active: true,
      reason: null,
      hello: helloResult,
      token,
      bridge,
      client: new DeputyAsyncClient(socketPath),
      automationUnproven: true,
    };
  }
  if (mode === "auto" && automationThings !== "granted") {
    bridge.close();
    // Absent fields = helpers predating the TCC handshake. Not provably
    // onboarded is not onboarded: fail closed rather than guess.
    const reason =
      automationThings === undefined
        ? `onboarding not provable (helpers v${helloResult.deputyVersion} predate the permission handshake)`
        : `onboarding incomplete (automation → Things: ${automationThings})`;
    notice(
      true,
      automationThings === undefined
        ? `the installed helpers (v${helloResult.deputyVersion}) cannot report their macOS permission standing, so app automation runs DIRECT — rebuild with \`bash scripts/build-helpers.sh\`, then \`things helpers setup\`.`
        : `the helpers have no app-control permission for Things (${automationThings}), so app automation runs DIRECT — \`things helpers setup\` settles it in one sitting.`,
    );
    return { active: false, reason, hello: null };
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

/**
 * Finish the onboarding gate that a dormant Things deferred (#617).
 *
 * Called by the write gate with the standing it read AFTER waking the target,
 * which is the first moment the grant is knowable. `granted` proves the deputy
 * and the memoized handshake is corrected in place, so every later verdict in
 * this process reads the truth without waking anything again. Anything else is
 * the state the activation gate would have refused on: the transports are
 * closed, the deferred notice is printed, and the process runs direct — because
 * an event routed to a deputy that lacks the grant just relocates the consent
 * dialog to a helper nobody is watching.
 *
 * A no-op unless a deferral is actually outstanding, so `true` mode (which
 * never defers) and every non-deputy machine are untouched.
 */
export function settleDeputyAutomation(standing: string | undefined): void {
  const current = state;
  if (current === null || !current.active || current.automationUnproven !== true) return;
  if (standing === "granted") {
    state = {
      ...current,
      automationUnproven: false,
      hello: {
        ...current.hello,
        ...(current.hello.automation !== undefined && {
          automation: { ...current.hello.automation, things: "granted" },
        }),
      },
    };
    return;
  }
  current.bridge.close();
  current.client.close();
  notice(
    true,
    `the helpers have no app-control permission for Things (${standing ?? "unknown"}), so app automation runs DIRECT — \`things helpers setup\` settles it in one sitting.`,
  );
  state = {
    active: false,
    reason: `onboarding incomplete (automation → Things: ${standing ?? "unknown"})`,
    hello: null,
  };
}

function activeState(env: NodeJS.ProcessEnv): ActiveState | null {
  const routing = deputyRouting(env);
  return routing.active ? (state as ActiveState) : null;
}

function readerInactive(reason: string): ReaderState {
  return {
    active: false,
    granted: false,
    hello: null,
    token: "",
    bridge: null,
    reason,
  };
}

function activateReader(env: NodeJS.ProcessEnv): ReaderState {
  const mode: HelpersMode = loadConfig(env).helpersMode;
  if (mode === "false") return readerInactive("disabled");
  // The rendezvous is `<state>/reader` — our own directory, outside every App
  // Sandbox container — so these are ordinary file touches from any host app.
  // No guard, no consent class, nothing to prove before looking.
  const socketPath = readerSocketPath(env);
  const tokenPath = readerTokenPath(env);
  const installed = halfInstalled(readerInstalledAppPath(env), socketPath, tokenPath);
  if (!rendezvousExists(socketPath) || !rendezvousExists(tokenPath)) {
    // launchd creates the socket when the reader's LaunchAgent is loaded, and
    // install mints the token beside it — so an absent rendezvous means the
    // pair was never installed here, or its LaunchAgent is not loaded.
    // Absence is silent under `auto`; under `true` the caller asserted routing.
    // An UNGRANTED reader is deliberately NOT noticed here — that is the
    // ceremony's own state, reported by `things helpers status` and doctor.
    notice(
      mode === "true" || installed,
      installed
        ? `the reader is installed but not registered with launchd (no rendezvous at ${socketPath}) — database reads run DIRECT. \`things helpers setup\` to re-register it.`
        : "the reader is not installed on this machine — database reads run DIRECT. `things helpers setup` to change that.",
    );
    return readerInactive(
      installed ? `reader not registered with launchd (no ${socketPath})` : "reader not installed",
    );
  }
  const token = readRendezvousToken(tokenPath);
  if (token === null) {
    notice(
      true,
      `the reader's access token could not be read (${tokenPath}) — database reads run DIRECT. \`things helpers setup\` to mint a fresh one.`,
    );
    return readerInactive(`the reader's access token could not be read (${tokenPath})`);
  }
  const bridge = new DeputySyncBridge(socketPath);
  try {
    const res = bridge.request({ v: DEPUTY_PROTOCOL_VERSION, token, verb: "hello" }, 2000);
    if (res["ok"] !== true) throw new DeputyRequestError("handshake", JSON.stringify(res["error"]));
    const readerHello = res as unknown as ReaderHello;
    if (readerHello.protocol !== DEPUTY_PROTOCOL_VERSION) {
      bridge.close();
      notice(
        true,
        `the reader speaks protocol ${readerHello.protocol}, this package speaks ${DEPUTY_PROTOCOL_VERSION} — database reads run DIRECT. Rebuild with \`bash scripts/build-helpers.sh\` + \`things helpers setup\`.`,
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
        ? "reader running but NOT granted (things helpers setup)"
        : reader.reason,
  };
}

/** True when file verbs ride the reader (present, protocol-matched, granted). */
export function deputyFilesActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return fileTransport(env) !== null;
}

/**
 * Does this machine EXPECT the helpers to carry its reads?
 *
 * `true` is an explicit instruction, and under `auto` an installed bundle is
 * the intent signal (src/deputy/agent-daemon.md §3c). The permissions doctrine
 * hangs its no-fallback rule on this: when the helpers are expected but cannot
 * serve, a read refuses loudly instead of quietly re-attaching consent to the
 * terminal — the exact churn the helpers exist to end. A machine with nothing
 * installed under `auto` is an ordinary direct machine and is NOT expecting
 * them, so it falls through to the direct grants as it always has.
 */
export function helpersExpected(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = loadConfig(env).helpersMode;
  if (mode === "false") return false;
  if (mode === "true") return true;
  // Both halves of the question live in our own state directory now — the
  // installed bundle and the rendezvous alike — so this is always answerable
  // from any host, with no probe that could prompt.
  if (existsSync(readerInstalledAppPath(env))) return true;
  return rendezvousExists(readerSocketPath(env)) && rendezvousExists(readerTokenPath(env));
}

/**
 * Does this machine EXPECT the DEPUTY to carry its app automation?
 *
 * The osascript twin of {@link helpersExpected}, and deliberately a SEPARATE
 * question: each half of the pair is gated on its OWN requisite (reads on the
 * reader's bookmark grant, automation on the deputy's app-control grant), so a
 * machine that installed one half is not told it expects the other. `true` is
 * an explicit instruction; under `auto` the installed deputy bundle (or its
 * live rendezvous) is the intent signal.
 *
 * The no-fallback rule hangs on this (permissions doctrine, Article I; issue
 * #620): when the deputy is expected but is not carrying traffic, an osascript
 * REFUSES rather than quietly re-running under the host process's identity —
 * which is a different identity, with different grants, mid-operation. A
 * machine with no deputy installed under `auto` is an ordinary direct machine
 * and is NOT expecting one, so it runs direct exactly as it always has.
 */
export function deputyExpected(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = loadConfig(env).helpersMode;
  if (mode === "false") return false;
  if (mode === "true") return true;
  return halfInstalled(deputyInstalledBinaryPath(env), deputySocketPath(env), deputyTokenPath(env));
}

/** Why the reader is not carrying reads (null when it is). */
export function readerUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (deputyFilesActive(env)) return null;
  const reader = readerRouting(env);
  if (reader.active && !reader.granted) {
    return "the reader is running but holds no read grant for the Things data folder";
  }
  return reader.reason;
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
 *
 * A reader that IS serving and then fails to locate THROWS rather than
 * returning null. Falling back to a direct locate there would silently move
 * the read — and its consent — back onto the host app, which the permissions
 * doctrine forbids (Article I; no-fallback rule). The reader's typed
 * `not-granted` / `not-found` codes travel out on the error so the CLI can
 * name the remedy.
 */
export function deputyDbPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const reader = readerRouting(env);
  if (!reader.active || !reader.granted) return null;
  if (reader.hello?.dbPath != null) return reader.hello.dbPath;
  const rs = readerState as ReaderState;
  if (rs.dbPathMemo !== undefined && rs.dbPathMemo !== null) return rs.dbPathMemo;
  const res = fileSyncRequest({ verb: "locate" }, 10_000, env);
  const path = typeof res["path"] === "string" ? res["path"] : null;
  if (path === null) {
    throw new DeputyRequestError(
      "not-found",
      "the reader answered the locate but named no database",
    );
  }
  rs.dbPathMemo = path;
  return path;
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
