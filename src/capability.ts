/**
 * Prompt-free capability detection (docs/design/permissions-doctrine.md,
 * Articles I–III).
 *
 * Every entry point must know what it is allowed to do BEFORE it touches the
 * live library, and it must find out without putting a macOS consent dialog on
 * screen. This module is the single place that answers that question, so the
 * read gate, the write gate, `things doctor`, and the `things setup` ceremony
 * all quote the same verdict.
 *
 * Read capability is GROUND TRUTH per invocation, never a stored flag. Nothing
 * here is memoized across calls and nothing is persisted except the one marker
 * that records a live-instance fact (./session-grant.ts). The whole preflight
 * is a single `open(2)` in the common case.
 *
 * The paths, in the order they are consulted:
 *
 *  1. an explicit database path — outside the doctrine entirely (Article VI);
 *  2. the helpers — when the reader is serving this process's reads, the READ
 *     ITSELF is the check. The reader resolves its security-scoped bookmark on
 *     every verb and answers `not-granted` / `not-found` as typed errors, so
 *     there is nothing to pre-probe and no hello round-trip is added here. When
 *     the helpers are expected but cannot serve, the read FAILS LOUDLY — a
 *     silent fall-through to direct would move consent back onto the terminal,
 *     which is the exact churn the helpers exist to end;
 *  3. Full Disk Access — one read-open of the user TCC database. FDA-class
 *     files never raise a dialog: the open either works or fails with a silent
 *     EPERM;
 *  4. a witnessed session app-data grant — see ./session-grant.ts;
 *  5. otherwise: refuse, naming both setup ceremonies.
 *
 * The Things group container is NEVER opened as a probe (Article I corollary):
 * the open is itself what raises the app-data consent, so "try it and see" is
 * forbidden — except inside `things setup`, which provokes it deliberately.
 *
 * On the direct WRITE probe — why TCC introspection and not the AppleEvents
 * API. The doctrine names `AEDeterminePermissionToAutomateTarget(askUserIfNeeded:
 * false)` as the direct-path Automation probe, which is exactly what the deputy
 * calls (deputy/src/tcc.swift). From a JXA/ObjC host that call is NOT reachable:
 * JavaScriptCore's bridge cannot marshal an `AEDesc` struct. MEASURED 2026-08-24
 * on macOS 24.6 — `AECreateDesc` fills an untyped `Ref()`, but passing that Ref
 * to any function taking `^{AEDesc=…}` throws "Ref has incompatible type", and
 * the one spelling the bridge accepts (`ref[0]`, a dereferenced copy) arrives
 * zeroed: `AEGetDescDataSize` reports 0 bytes for a 36-byte bundle id, and every
 * target then answers -50 paramErr. A probe that returns the same wrong answer
 * for every input is worse than no probe, so it is not shipped. Reading the
 * Automation row out of TCC.db is the other introspection the Article I
 * corollary names, it is exactly as prompt-free, and it costs nothing extra:
 * direct mode's floor is FDA anyway, so a process that can act at all can
 * already read that file. Where the row cannot be read the verdict is an honest
 * "unknown", which the write gate refuses on rather than resolving with a dialog.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { deputyRouting, deputyRoutesDb, helpersExpected } from "./deputy/routing.ts";
import { sessionGrantValid, type SessionGrantDeps } from "./session-grant.ts";

/** The Things application's bundle identifier — the Automation grant's target. */
export const THINGS_BUNDLE_ID = "com.culturedcode.ThingsMac";

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

/** How reads may reach the live library, if at all. */
export type ReadCapabilityMode =
  /** A caller-supplied database path — outside the doctrine entirely (Article VI). */
  | "explicit-db"
  /** Reads ride the sandboxed reader; the read itself is the capability check. */
  | "helpers"
  /** The helpers are expected here but cannot serve — refuse, never fall back. */
  | "helpers-unavailable"
  /** No helpers, but the host app holds Full Disk Access. */
  | "direct-fda"
  /** A ceremony witnessed an app-data grant that is still live for this app instance. */
  | "session-grant"
  /** Nothing can open the container — the caller must run a setup ceremony. */
  | "none";

/** How app automation may be delivered, if at all. */
export type WriteCapabilityMode =
  /** The deputy is onboarded; Apple Events are sent under the helper identity. */
  | "deputy"
  /** macOS records an Automation grant for the host app against Things. */
  | "direct-granted"
  /** macOS records a REFUSAL. It will not re-ask; the human must re-arm it. */
  | "direct-denied"
  /** No record either way, or none readable — never resolved by prompting. */
  | "direct-unknown";

export interface Capability<Mode> {
  mode: Mode;
  /** One sentence of provenance, for `doctor` and for refusal copy. */
  detail: string;
  /**
   * The remediation lines a refusal prints, in the order they should be
   * offered. Empty when the capability is present.
   */
  remediation: string[];
  /** The identity a direct-mode grant would attach to. */
  host: HostApp;
}

export type ReadCapability = Capability<ReadCapabilityMode>;
export type WriteCapability = Capability<WriteCapabilityMode>;

/** True when this verdict permits opening the live container. */
export function readAllowed(capability: ReadCapability): boolean {
  return capability.mode !== "none" && capability.mode !== "helpers-unavailable";
}

/**
 * Injection seams. Every one of these defaults to a real, prompt-free probe;
 * tests replace them so no test ever touches the host's TCC state.
 */
export interface CapabilityDeps extends SessionGrantDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * Attempt the FDA-class read-open. Returns normally when the host holds Full
   * Disk Access; throws a Node fs error (EPERM when it does not) otherwise.
   */
  fdaProbe?: () => void;
  /** Are this process's database reads actually being served by the reader? */
  helpersServing?: () => boolean;
  /** Are the helpers expected on this machine (enabled, and installed under auto)? */
  helpersExpected?: () => boolean;
  /** Why the helpers are not serving, for the loud refusal. */
  helpersReason?: () => string | null;
  /** The deputy's `automation.things` standing, from its handshake. */
  deputyAutomation?: () => string | undefined;
  /**
   * Read one Automation row out of TCC.db. Returns the raw `auth_value`, or
   * null when there is no row / the file cannot be read.
   */
  automationAuthValue?: (client: string, target: string) => number | null;
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
export function hostApp(deps: CapabilityDeps = {}): HostApp {
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
export function hostDisplayName(deps: CapabilityDeps = {}): string {
  if (hostNameMemo !== null) return hostNameMemo;
  const host = hostApp(deps);
  if (host.name !== ANONYMOUS_HOST || host.bundleId === null) {
    hostNameMemo = host.name;
    return hostNameMemo;
  }
  hostNameMemo = (deps.lookupAppName ?? lookupAppNameDefault)(host.bundleId) ?? ANONYMOUS_HOST;
  return hostNameMemo;
}

// ── The prompt-free probes ───────────────────────────────────────────────────

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
export function fdaGranted(deps: CapabilityDeps = {}): FdaVerdict {
  const env = deps.env ?? process.env;
  try {
    (deps.fdaProbe ?? (() => fdaProbeDefault(env)))();
    return { granted: true, code: null };
  } catch (err) {
    return { granted: false, code: (err as NodeJS.ErrnoException).code ?? null };
  }
}

/**
 * One Automation row from TCC.db: the `auth_value` macOS records for `client`
 * driving `target`, or null when there is no row (never asked) or the file is
 * unreadable (no FDA). Read-only, prompt-free, and defensive — the schema is
 * Apple's private business, so ANY failure degrades to null rather than
 * throwing into a caller that asked a yes/no question.
 */
function automationAuthValueDefault(
  env: NodeJS.ProcessEnv,
  client: string,
  target: string,
): number | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(tccDbPath(env), { readOnly: true });
    const row = db
      .prepare(
        "SELECT auth_value FROM access WHERE service = 'kTCCServiceAppleEvents' " +
          "AND client = ? AND indirect_object_identifier = ? LIMIT 1",
      )
      .get(client, target) as { auth_value?: number } | undefined;
    const value = row?.auth_value;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A close failure cannot change the answer we already have.
    }
  }
}

// ── Read capability (Article I + II) ─────────────────────────────────────────

/**
 * Errnos that mean a plain "no" rather than something worth telling the user
 * about. EPERM is the FDA denial proper; EACCES is its sandboxed cousin; ENOENT
 * simply means this account has no TCC database yet. Anything else is an
 * anomaly and gets named, so a genuinely odd failure is never silently folded
 * into "you lack permission".
 */
const ORDINARY_DENIALS = new Set(["EPERM", "EACCES", "ENOENT"]);

/** The ways a machine can earn read capability, phrased for a human. */
function readRemediation(hostName: string): string[] {
  return [
    "run `things helpers setup` — reads then flow through a helper that holds its own durable grant",
    `or grant Full Disk Access to ${hostName} in System Settings ▸ Privacy & Security ▸ Full Disk Access`,
    "or run `things setup`, which walks through both",
  ];
}

/**
 * Can this process read the live Things library, and on whose authority?
 *
 * Stateless: every call re-derives the verdict, because a grant can appear or
 * vanish between one invocation and the next and a cached "yes" would be a
 * stored onboarding flag by another name. The common case costs one `open(2)`.
 */
export function readCapability(
  options: { dbPath?: string } = {},
  deps: CapabilityDeps = {},
): ReadCapability {
  const env = deps.env ?? process.env;
  const host = hostApp(deps);
  // Article VI — a path the caller already owns gets plain file semantics.
  if (options.dbPath !== undefined || (env["THINGS_DB"] ?? "") !== "") {
    return {
      mode: "explicit-db",
      detail: "an explicit database path was supplied — plain file semantics apply",
      remediation: [],
      host,
    };
  }
  // The helpers path. Reads that ride the reader are not pre-checked here: the
  // reader resolves its bookmark on every verb, so the read IS the check and a
  // probe would only add latency and a second answer to disagree with.
  const serving = (deps.helpersServing ?? (() => deputyRoutesDb(options, env)))();
  if (serving) {
    return {
      mode: "helpers",
      detail: "database reads are served by the sandboxed reader",
      remediation: [],
      host,
    };
  }
  // No silent fall-through: a machine that asked for the helpers and cannot
  // have them is refused, not quietly downgraded onto the terminal's own grants.
  const expected = (deps.helpersExpected ?? (() => helpersExpected(env)))();
  if (expected) {
    const why = (deps.helpersReason ?? (() => null))();
    return {
      mode: "helpers-unavailable",
      detail: `the helpers are enabled on this machine but are not serving reads${
        why !== null ? ` (${why})` : ""
      }`,
      remediation: [
        "run `things helpers setup` to finish onboarding them",
        "or `things helpers status` to see which half is unhealthy",
        "or `things --no-helpers …` to run this one invocation directly",
      ],
      host,
    };
  }
  const fda = fdaGranted(deps);
  if (fda.granted) {
    return {
      mode: "direct-fda",
      detail: `Full Disk Access is held by ${hostDisplayName(deps)}${
        host.bundleId !== null ? ` (${host.bundleId})` : ""
      }`,
      remediation: [],
      host,
    };
  }
  // The sub-FDA tier: a grant a ceremony witnessed, still live for this very
  // app instance. Only consulted when FDA has already said no.
  const session = sessionGrantValid(host.bundleId, deps);
  if (session.valid) {
    return {
      mode: "session-grant",
      detail: `${hostDisplayName(deps)} was granted access to the Things data folder for as long as it stays open`,
      remediation: [],
      host,
    };
  }
  return {
    mode: "none",
    detail:
      `${hostDisplayName(deps)} cannot open the Things data folder — ${session.reason}` +
      (fda.code !== null && !ORDINARY_DENIALS.has(fda.code)
        ? ` (the access check ended in ${fda.code})`
        : ""),
    remediation: readRemediation(hostDisplayName(deps)),
    host,
  };
}

/** Thrown when a read is refused for want of capability (Article II). */
export class ReadCapabilityError extends Error {
  readonly remediation: string[];
  readonly capability: ReadCapability;
  constructor(capability: ReadCapability) {
    super(
      `the Things database cannot be read: ${capability.detail}. ` +
        `${capability.remediation.join("; ")}.`,
    );
    this.name = "ReadCapabilityError";
    this.remediation = capability.remediation;
    this.capability = capability;
  }
}

// ── Write capability (Article I + II) ────────────────────────────────────────

/**
 * macOS `auth_value` for an Automation record. 0 is a refusal; 2 (allowed) and
 * 3 both mean the event will be delivered.
 */
function classifyAuthValue(value: number | null): "granted" | "denied" | "unknown" {
  if (value === null) return "unknown";
  if (value === 0) return "denied";
  if (value >= 2) return "granted";
  return "unknown";
}

/**
 * May this process drive Things over Apple Events, and on whose authority?
 *
 * The deputy wins when it is onboarded (its own handshake reports the grant it
 * holds). Otherwise the host app's own Automation record is read out of TCC —
 * granted, denied, or, when there is no record at all, `direct-unknown`. That
 * last state is deliberately NOT resolved here: resolving it means sending a
 * real Apple Event, which is what raises the dialog, and Article I reserves
 * that for `things setup`.
 */
export function writeCapability(deps: CapabilityDeps = {}): WriteCapability {
  const env = deps.env ?? process.env;
  const host = hostApp(deps);
  const deputyThings = (
    deps.deputyAutomation ?? (() => deputyRouting(env).hello?.automation?.things)
  )();
  if (deputyThings === "granted") {
    return {
      mode: "deputy",
      detail: "the deputy is onboarded and holds app control for Things",
      remediation: [],
      host,
    };
  }
  if (host.bundleId === null) {
    return {
      mode: "direct-unknown",
      detail:
        "this process does not descend from an application bundle, so macOS has no identity " +
        "to record app control against",
      remediation: [
        "run `things helpers setup` — app control then attaches to a helper that always has an identity",
      ],
      host,
    };
  }
  const authValue = (
    deps.automationAuthValue ??
    ((client: string, target: string) => automationAuthValueDefault(env, client, target))
  )(host.bundleId, THINGS_BUNDLE_ID);
  const hostName = hostDisplayName(deps);
  switch (classifyAuthValue(authValue)) {
    case "granted":
      return {
        mode: "direct-granted",
        detail: `${hostName} (${host.bundleId}) holds app control for Things`,
        remediation: [],
        host,
      };
    case "denied":
      return {
        mode: "direct-denied",
        detail: `macOS records a refusal of app control for ${hostName} (${host.bundleId}) — it will not ask again`,
        remediation: [
          `turn on Things3 for ${hostName} under System Settings ▸ Privacy & Security ▸ Automation`,
          `or re-arm the request with \`tccutil reset AppleEvents ${host.bundleId}\`, then run \`things setup\``,
        ],
        host,
      };
    default:
      return {
        mode: "direct-unknown",
        detail: `macOS has no app-control record for ${hostName} (${host.bundleId}) yet`,
        remediation: [
          "run `things setup` — it asks for app control once, while you are at the machine",
          "or run `things helpers setup` to attach the grant to a helper instead",
        ],
        host,
      };
  }
}

/** Thrown when app automation is refused for want of capability (Article II). */
export class WriteCapabilityError extends Error {
  readonly remediation: string[];
  readonly capability: WriteCapability;
  constructor(capability: WriteCapability) {
    super(`Things cannot be driven: ${capability.detail}. ${capability.remediation.join("; ")}.`);
    this.name = "WriteCapabilityError";
    this.remediation = capability.remediation;
    this.capability = capability;
  }
}

/** Test seam: forget the one memo this module keeps (the host's display name). */
export function resetCapabilityForTests(): void {
  hostNameMemo = null;
}
