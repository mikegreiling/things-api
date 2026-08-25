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
 * Step 2 asks nothing of this host's grants. Since helpers 1.3.0 the reader's
 * socket and token live in `<state>/reader` — launchd owns the socket, install
 * mints the token, and both are ordinary files this user owns — so "is the
 * reader serving?" is answerable identically from every host app, with no
 * consent class in play. (Before 1.3.0 they sat in the reader's App Sandbox
 * container and that question was itself a cross-app container access.)
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
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "./config.ts";
import { deputyRouting, deputyRoutesDb, helpersExpected } from "./deputy/routing.ts";
import {
  fdaGranted,
  type HostAccessDeps,
  type HostApp,
  hostApp,
  hostDisplayName,
  resetHostAccessForTests,
  tccDbPath,
} from "./host-access.ts";
import { sessionGrantValid } from "./session-grant.ts";

export {
  fdaGranted,
  type FdaVerdict,
  type HostApp,
  hostApp,
  hostDisplayName,
  tccDbPath,
} from "./host-access.ts";

/** The Things application's bundle identifier — the Automation grant's target. */
export const THINGS_BUNDLE_ID = "com.culturedcode.ThingsMac";

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

/** How GUI-driving may be delivered, if at all (Article IV). */
export type UiCapabilityMode =
  /** The helper pair holds Accessibility + Automation→System Events. */
  | "helpers"
  /** The lab's documented in-guest escape (see {@link UI_DIRECT_ESCAPE_ENV}). */
  | "direct-escape"
  /** GUI-driving is switched off in config — nothing has been asked for yet. */
  | "config-disabled"
  /** No deputy answers, so there is no identity that could hold the grants. */
  | "helpers-missing"
  /** The deputy answers but the `--gui` tier is incomplete. */
  | "tier-incomplete";

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
export type UiCapability = Capability<UiCapabilityMode>;

/** True when this verdict permits opening the live container. */
export function readAllowed(capability: ReadCapability): boolean {
  return capability.mode !== "none" && capability.mode !== "helpers-unavailable";
}

/** True when this verdict permits driving the Things window. */
export function uiAllowed(capability: UiCapability): boolean {
  return capability.mode === "helpers" || capability.mode === "direct-escape";
}

/** True when app automation may be dispatched. */
export function writeAllowed(capability: WriteCapability): boolean {
  return capability.mode === "deputy" || capability.mode === "direct-granted";
}

/**
 * Injection seams. Every one of these defaults to a real, prompt-free probe;
 * tests replace them so no test ever touches the host's TCC state.
 */
export interface CapabilityDeps extends HostAccessDeps {
  /** Are this process's database reads actually being served by the reader? */
  helpersServing?: () => boolean;
  /** Are the helpers expected on this machine (enabled, and installed under auto)? */
  helpersExpected?: () => boolean;
  /** Why the helpers are not serving, for the loud refusal. */
  helpersReason?: () => string | null;
  /** The deputy's `automation.things` standing, from its handshake. */
  deputyAutomation?: () => string | undefined;
  /**
   * The deputy's GUI-driving standing, from the same handshake: whether it is
   * Accessibility-trusted and where its Automation→System Events grant stands.
   * `null` means no deputy answered at all.
   */
  deputyGuiStanding?: () => {
    axTrusted: boolean | undefined;
    systemEvents: string | undefined;
  } | null;
  /** Is GUI-driving switched on in config (`ui-enabled`)? */
  uiEnabled?: () => boolean;
  /**
   * Read one Automation row out of TCC.db. Returns the raw `auth_value`, or
   * null when there is no row / the file cannot be read.
   */
  automationAuthValue?: (client: string, target: string) => number | null;
  /** Resolve a running app's display name from its bundle id (LaunchServices). */
  lookupAppName?: (bundleId: string) => string | null;
}

// ── The prompt-free probes ───────────────────────────────────────────────────

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

/**
 * The ways a machine can earn read capability, phrased for a human.
 *
 * The ask-again line is deliberately CONDITIONAL, because of what this process
 * can and cannot know. A container that will not open carries no cause: "this
 * host app was never asked" and "this host app was asked and the human clicked
 * Don't Allow" are the same observation from here, and the app-data class
 * cannot be told apart without opening the container — which is the very act
 * that raises the dialog (Article I corollary). What IS measured is the price
 * of a refusal (APDP1, docs/lab/apdp1-grant-pinning.md): it stands for the
 * whole life of that host-app instance, every later open failing instantly and
 * silently, and macOS never re-asks inside it. So the line names the relaunch
 * as the way to be asked again without asserting that anyone refused anything.
 */
function readRemediation(hostName: string): string[] {
  return [
    "run `things helpers setup` — reads then flow through a helper that holds its own durable grant",
    "or run `things setup` — it asks for read access once, while you are at the machine",
    `if that dialog was already refused, quit and reopen ${hostName} first — macOS does not ask a second time inside one run of an app`,
    `or grant Full Disk Access to ${hostName} in System Settings ▸ Privacy & Security ▸ Full Disk Access`,
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
  // Nothing gates this question any more — the rendezvous is ours, so whether
  // the helpers are expected and whether they are serving are both answerable
  // from every host app alike.
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
    const name = hostDisplayName(deps);
    return {
      mode: "session-grant",
      // MEASURED (APDP1): the grant belongs to the host app INSTANCE, so it
      // covers every process under it — this command, other tabs and windows,
      // anything they spawn — and it ends when that app quits. The copy states
      // both halves, because the reach is the part that is worth knowing and
      // the expiry is the part that must never read as durable.
      detail: `${name} holds access to the Things data folder — every command running under ${name}, in any tab or window, reads it without a dialog until ${name} quits`,
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

// ── UI capability (Article IV) ───────────────────────────────────────────────

/**
 * The LAB's escape hatch, and deliberately not consumer surface. The VM lab and
 * the guest e2e bundle drive the UI vector DIRECT — the in-guest Accessibility
 * grant is held by the runner's own processes (the AXVM1 layer), there is no
 * helper bundle in a disposable clone, and there is nobody to answer a dialog
 * either. Setting this to `1` restores direct UI-vector availability for that
 * one situation. It is documented in docs/lab/harness.md and exported by the
 * lab's guest environment; nothing consumer-facing mentions it, and it does not
 * bypass `ui.enabled` — a lab clone still sets that key explicitly.
 */
export const UI_DIRECT_ESCAPE_ENV = "THINGS_API_UI_DIRECT";

/** The command that gathers the GUI-driving tier, named in every UI refusal. */
const GUI_SETUP_COMMAND = "run `things helpers setup --gui` to grant GUI-driving to the helpers";

function deputyGuiStandingDefault(
  env: NodeJS.ProcessEnv,
): { axTrusted: boolean | undefined; systemEvents: string | undefined } | null {
  const hello = deputyRouting(env).hello;
  if (hello === undefined || hello === null) return null;
  return { axTrusted: hello.axTrusted, systemEvents: hello.automation?.systemEvents };
}

/**
 * May this process drive the Things WINDOW, and on whose authority?
 *
 * Article IV admits exactly one provenance: the helper pair. Accessibility on a
 * general-purpose host app (a terminal, an agent harness, an MCP host) has a
 * blast radius far beyond Things, churns with every host update, and has no
 * sane story at all over ssh — so direct AX is unsupported, and a refusal here
 * names the config knob and `things helpers setup --gui` rather than raising an
 * Accessibility prompt against whatever happens to be running us.
 *
 * Every answer is prompt-free: the config key is a file read, and the deputy's
 * `hello` carries `AXIsProcessTrusted()` plus its own `AEDeterminePermission`
 * verdict for System Events.
 */
export function uiCapability(deps: CapabilityDeps = {}): UiCapability {
  const env = deps.env ?? process.env;
  const host = hostApp(deps);
  const enabled = (deps.uiEnabled ?? (() => loadConfig(env).ui.enabled))();
  if (!enabled) {
    return {
      mode: "config-disabled",
      detail: "GUI-driving is switched off on this machine (`ui-enabled` is false)",
      remediation: [
        "run `things config set ui-enabled true` to opt in",
        `then ${GUI_SETUP_COMMAND}`,
      ],
      host,
    };
  }
  if ((env[UI_DIRECT_ESCAPE_ENV] ?? "") === "1") {
    return {
      mode: "direct-escape",
      detail: `${UI_DIRECT_ESCAPE_ENV}=1 — GUI-driving runs directly under this process (lab escape)`,
      remediation: [],
      host,
    };
  }
  const standing = (deps.deputyGuiStanding ?? (() => deputyGuiStandingDefault(env)))();
  if (standing === null) {
    return {
      mode: "helpers-missing",
      detail:
        "GUI-driving is granted only to the helpers, and no helper is answering on this machine",
      remediation: [GUI_SETUP_COMMAND, "or `things helpers status` to see which half is unhealthy"],
      host,
    };
  }
  const missing: string[] = [];
  if (standing.axTrusted !== true) {
    missing.push(
      standing.axTrusted === undefined
        ? "Accessibility (these helpers predate the permission handshake — rebuild)"
        : "Accessibility",
    );
  }
  if (standing.systemEvents !== "granted") {
    missing.push(`automation → System Events (${standing.systemEvents ?? "unknown"})`);
  }
  if (missing.length === 0) {
    return {
      mode: "helpers",
      detail: "the helpers hold Accessibility and app control for System Events",
      remediation: [],
      host,
    };
  }
  return {
    mode: "tier-incomplete",
    detail: `the helpers are onboarded but the GUI-driving tier is incomplete — missing ${missing.join("; ")}`,
    remediation: [GUI_SETUP_COMMAND],
    host,
  };
}

/** Thrown when GUI-driving is refused for want of capability (Article IV). */
export class UiCapabilityError extends Error {
  readonly remediation: string[];
  readonly capability: UiCapability;
  constructor(capability: UiCapability) {
    super(
      `the Things window cannot be driven: ${capability.detail}. ${capability.remediation.join("; ")}.`,
    );
    this.name = "UiCapabilityError";
    this.remediation = capability.remediation;
    this.capability = capability;
  }
}

/** Test seam: forget the one memo this module keeps (the host's display name). */
export function resetCapabilityForTests(): void {
  resetHostAccessForTests();
}
