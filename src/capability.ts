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
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "./config.ts";
import { readContainerFileSync } from "./deputy/files.ts";
import {
  deputyRouting,
  deputyRoutesDb,
  helpersExpected,
  settleDeputyAutomation,
} from "./deputy/routing.ts";
import { type TargetWake, THINGS_BUNDLE_ID, wakeSystemEvents, wakeThings } from "./deputy/wake.ts";
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
export { THINGS_BUNDLE_ID } from "./deputy/wake.ts";

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
  /** System Events is down and would not start — a liveness fault, not a grant one. */
  | "target-unreachable"
  /** The deputy answers but the `--gui` tier is incomplete. */
  | "tier-incomplete";

/**
 * Where Things' OWN in-app authorization for the URL scheme stands (URLEN1).
 *
 * This is not a macOS consent class at all — `open -g things:///…` is a
 * LaunchServices dispatch that needs no grant. The gate is the app's: Settings
 * ▸ General ▸ "Enable Things URLs", recorded as `uriSchemeEnabled` in the
 * group-container preferences plist. Three states, all measured.
 */
export type UrlSchemeCapabilityMode =
  /** `uriSchemeEnabled = 1` — URL commands execute. */
  | "enabled"
  /** `uriSchemeEnabled = 0` — the app drops URL MUTATIONS with no dialog at all. */
  | "disabled"
  /** No key: nobody has answered the app's first-use dialog on this machine. */
  | "never-asked"
  /** The plist cannot be reached prompt-free — never resolved by dispatching. */
  | "unreadable";

/** How app automation may be delivered, if at all. */
export type WriteCapabilityMode =
  /** The deputy is onboarded; Apple Events are sent under the helper identity. */
  | "deputy"
  /** Things is not running, so where the deputy's grant stands cannot be read. */
  | "deputy-target-dormant"
  /** macOS records an Automation grant for the host app against Things. */
  | "direct-granted"
  /** The lab's documented in-guest escape (see {@link WRITE_DIRECT_ESCAPE_ENV}). */
  | "direct-escape"
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
export type UrlSchemeCapability = Capability<UrlSchemeCapabilityMode>;

/** True when this verdict permits opening the live container. */
export function readAllowed(capability: ReadCapability): boolean {
  return capability.mode !== "none" && capability.mode !== "helpers-unavailable";
}

/**
 * True when THIS process may reach into the Things group container with its
 * OWN file syscalls — a `stat`, an `open`, a sqlite connect.
 *
 * NOT the same question as {@link readAllowed}, and conflating the two is the
 * bug class of issue #664. `helpers` means the READER may open the container on
 * our behalf, under the security-scoped bookmark it holds; it says nothing
 * about this process. A host app with no Full Disk Access that stats a
 * container file itself gets the "access data from other apps" modal for its
 * trouble — and, because the app-data class parks the syscall in the kernel
 * while the dialog stands (TCCDUR1), a syscall that nobody is there to answer
 * for never returns at all.
 *
 * Only the three standings that cover this process's own syscalls qualify: an
 * explicit path (Article VI — outside the doctrine entirely), the host app's
 * Full Disk Access, or a session app-data grant still live for this app
 * instance. Everything else must route the touch through the reader
 * ({@link readContainerFileSync}, the deputy db facade) or go without.
 */
export function directContainerAccessAllowed(capability: ReadCapability): boolean {
  return (
    capability.mode === "explicit-db" ||
    capability.mode === "direct-fda" ||
    capability.mode === "session-grant"
  );
}

/** True when this verdict permits driving the Things window. */
export function uiAllowed(capability: UiCapability): boolean {
  return capability.mode === "helpers" || capability.mode === "direct-escape";
}

/**
 * True when a URL-scheme MUTATION may be dispatched.
 *
 * `unreadable` is permissive, and deliberately so — the asymmetry with the
 * write gate is the point. There, an unknown standing is refused because
 * resolving it means sending the Apple Event that IS the dialog. Here,
 * dispatching costs nothing on a machine whose answer is already "enabled",
 * which is every settled machine; only the two states we have positively READ
 * as not-enabled are refused. What catches the unreadable case instead is the
 * read-after-write verify plus its likely-cause hint (src/write/failure-hints.ts).
 */
export function urlSchemeAllowed(capability: UrlSchemeCapability): boolean {
  return capability.mode === "enabled" || capability.mode === "unreadable";
}

/** True when app automation may be dispatched. */
export function writeAllowed(capability: WriteCapability): boolean {
  return (
    capability.mode === "deputy" ||
    capability.mode === "direct-granted" ||
    capability.mode === "direct-escape"
  );
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
  /**
   * Start System Events and re-read its Automation standing, for the one state
   * where the handshake reports liveness instead of authorization
   * (`not-running`). Prompt-free — see ./deputy/wake.ts for why the launch must
   * come before the determination.
   */
  wakeSystemEvents?: () => TargetWake;
  /**
   * Start Things and re-read its Automation standing — the same liveness step
   * for the AppleScript vector's own target (#617). Consulted ONLY on the
   * dispatch path: a survey never launches the user's app.
   */
  wakeThings?: () => TargetWake;
  /**
   * Report a woken target's real standing back to the routing layer, which
   * defers its `auto` onboarding gate while Things is closed
   * (./deputy/routing.ts, {@link settleDeputyAutomation}).
   */
  settleDeputyAutomation?: (standing: string | undefined) => void;
  /** Is GUI-driving switched on in config (`ui-enabled`)? */
  uiEnabled?: () => boolean;
  /**
   * Read one Automation row out of TCC.db. Returns the raw `auth_value`, or
   * null when there is no row / the file cannot be read.
   */
  automationAuthValue?: (client: string, target: string) => number | null;
  /** Resolve a running app's display name from its bundle id (LaunchServices). */
  lookupAppName?: (bundleId: string) => string | null;
  /**
   * The read standing {@link urlSchemeCapability} consults before it touches
   * the group container. Defaults to a live {@link readCapability} call.
   */
  readStanding?: () => ReadCapability;
  /** Raw bytes of the Things group-container preferences plist. Throws when unreachable. */
  readPrefsPlist?: () => Buffer;
  /** Pull `uriSchemeEnabled` out of those bytes. Throws when the key is absent. */
  extractUriSchemeEnabled?: (plistBytes: Buffer) => string;
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

// ── The lab escapes (not consumer surface) ───────────────────────────────────

/**
 * Is one of the lab's documented escapes set? ({@link UI_DIRECT_ESCAPE_ENV},
 * {@link WRITE_DIRECT_ESCAPE_ENV}.)
 *
 * Both are read in exactly one place each — the capability function for the
 * vector they cover — and both spell "on" the same way, as the literal `1`.
 * Anything else is off, deliberately: an escape that answered to `true`, `yes`
 * or a stray empty string would be a config surface, and these are neither
 * config nor consumer surface. They are documented in docs/lab/harness.md and
 * exported by the lab's guest environment; nothing shipped mentions them.
 */
function labEscapeSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] ?? "") === "1";
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
 * The LAB's escape hatch for the AppleScript vector — the write-side twin of
 * {@link UI_DIRECT_ESCAPE_ENV}, and just as deliberately not consumer surface.
 *
 * A guest shell in a golden clone descends from sshd, not from an application
 * bundle, so `hostApp()` finds no `__CFBundleIdentifier` and macOS has no
 * identity to have recorded an Automation grant against. The verdict is
 * therefore `direct-unknown` in every clone, which blocks every AppleScript-
 * vector verb and every composite carrying an AppleScript leg. What the clone
 * actually has is an in-guest Automation grant on the runner's own processes
 * (the same AXVM1 layer the ui escape leans on), so the block is an artefact of
 * UNKNOWABILITY, not of a missing grant. Setting this to `1` says so.
 *
 * Bounded, and the bound is the point: it is consulted ONLY on the
 * bundle-id-less path. A host that has an identity is answered from its TCC row
 * as it always was, so the escape can never mask a recorded refusal
 * (`direct-denied`) or manufacture a grant for a real user's terminal.
 * Documented in docs/lab/harness.md and exported by the lab's guest
 * environment; nothing consumer-facing mentions it.
 */
export const WRITE_DIRECT_ESCAPE_ENV = "THINGS_API_WRITE_DIRECT";

/**
 * What a {@link writeCapability} verdict is FOR — the one thing that decides
 * whether a dormant Things may be started while the verdict is taken (#617).
 *
 * The asymmetry with the GUI preflight is deliberate. System Events is a
 * headless macOS component nobody sees, so {@link uiCapability} wakes it for
 * every caller. Things is the user's own app: starting it is visible, so only a
 * caller that is ABOUT TO DRIVE IT may do so.
 */
export interface WriteCapabilityOptions {
  /**
   * - `survey` (the default) — `doctor`, the MCP startup bake, `--dry-run`.
   *   Launches nothing and reports a closed Things as the liveness state
   *   `deputy-target-dormant`.
   * - `dispatch` — the write gate and the two setup ceremonies, which are about
   *   to send Things an Apple Event anyway. A dormant target is started in the
   *   background first and its standing re-read, which is also what keeps the
   *   operation at tier 0/1: an Apple Event to a CLOSED Things auto-launches it
   *   WITH focus steal (A40/A41), a background pre-launch does not.
   */
  purpose?: "survey" | "dispatch";
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
 *
 * LIVENESS BEFORE AUTHORIZATION (#617). The deputy's `not-running` is the
 * ask-false determination having no answer for a CLOSED Things — a fact about
 * the app's process, not about the grant. Two rules follow, and both matter:
 *
 *  - while the deputy is standing, that value NEVER falls through to the direct
 *    host branch. A silent direct engagement would put consent back on the
 *    terminal (the routing doctrine's no-fallback rule), and on a machine with
 *    no host record it would refuse a fully onboarded user with "run
 *    `things setup`" — the #610 false-onboarding loop, one vector over;
 *  - a `dispatch` caller resolves it by STARTING Things (a background
 *    LaunchServices dispatch, never an Apple Event) and re-reading the
 *    standing. Only what comes back is an authorization fact.
 */
export function writeCapability(
  options: WriteCapabilityOptions = {},
  deps: CapabilityDeps = {},
): WriteCapability {
  const env = deps.env ?? process.env;
  const host = hostApp(deps);
  const handshake = (
    deps.deputyAutomation ?? (() => deputyRouting(env).hello?.automation?.things)
  )();
  let deputyThings = handshake;
  if (handshake === "not-running") {
    let wake: TargetWake | null = null;
    if (options.purpose === "dispatch") {
      wake = (deps.wakeThings ?? (() => wakeThings(env)))();
      deputyThings = wake.standing;
    }
    if (deputyThings === undefined || deputyThings === "not-running") {
      return {
        mode: "deputy-target-dormant",
        detail:
          wake === null
            ? "Things is not running, so app control for it cannot be read — macOS answers for a " +
              "running app only, and whatever the helpers hold is unreadable while it is down"
            : `Things is not running and ${wake.detail} — app control for it cannot be read while it is down`,
        remediation: [
          "open Things, then rerun this command",
          `or start it in the background with \`open -g -b ${THINGS_BUNDLE_ID}\``,
        ],
        host,
      };
    }
    // A real standing at last: hand it to the routing layer, whose own
    // onboarding gate deferred on the same non-answer (./deputy/routing.ts).
    (deps.settleDeputyAutomation ?? settleDeputyAutomation)(deputyThings);
  }
  if (deputyThings === "granted") {
    return {
      mode: "deputy",
      detail: "the deputy is onboarded and holds app control for Things",
      remediation: [],
      host,
    };
  }
  if (host.bundleId === null) {
    if (labEscapeSet(env, WRITE_DIRECT_ESCAPE_ENV)) {
      return {
        mode: "direct-escape",
        detail: `${WRITE_DIRECT_ESCAPE_ENV}=1 — Apple Events are sent directly under this process (lab escape)`,
        remediation: [],
        host,
      };
    }
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
 * The LAB's escape hatch for the ui vector, and deliberately not consumer
 * surface (its write-side twin is {@link WRITE_DIRECT_ESCAPE_ENV}). The VM lab and
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
 * verdict for System Events. The one state that needs more than a read is a
 * DORMANT System Events, which macOS reaps whenever it has been idle: the
 * target is started in the background — never by sending it an event — and the
 * determination re-read, so `not-running` resolves to the truth instead of
 * masquerading as a missing grant (./deputy/wake.ts).
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
  if (labEscapeSet(env, UI_DIRECT_ESCAPE_ENV)) {
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
  // LIVENESS BEFORE AUTHORIZATION (#610). System Events is an on-demand agent
  // macOS reaps when idle, and the ask-false determination cannot answer for a
  // target that is down — so the deputy's `not-running` describes the PROCESS,
  // not the grant, and treating it as a missing grant sends a fully onboarded
  // machine back through onboarding. Start it (a background launch raises no
  // dialog; waking it with an Apple event would), then re-read the
  // determination. Only after that is the standing an authorization fact.
  let systemEvents = standing.systemEvents;
  let wake: TargetWake | null = null;
  if (systemEvents === "not-running") {
    wake = (deps.wakeSystemEvents ?? (() => wakeSystemEvents(env)))();
    systemEvents = wake.standing;
  }
  if (wake !== null && (systemEvents === undefined || systemEvents === "not-running")) {
    return {
      mode: "target-unreachable",
      detail: `System Events is not running and ${wake.detail} — the Things window is driven through it`,
      remediation: [
        'start it with `open -g -a "System Events"`, then rerun this command',
        "or log out and back in — System Events is a macOS component of your login session",
      ],
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
  if (systemEvents !== "granted") {
    missing.push(`automation → System Events (${systemEvents ?? "unknown"})`);
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

// ── URL-scheme capability (Things' own in-app authorization) ─────────────────

/**
 * Where the app records the answer. MEASURED (URLEN1, Things 3.23): this is the
 * ONLY home — the un-TCC'd user domain `~/Library/Preferences/
 * com.culturedcode.ThingsMac.plist` carries window frames and Sparkle keys and
 * nothing else, under any spelling of the name, so there is no consent-free
 * copy to prefer. The authoritative one lives inside the group container.
 */
const THINGS_PREFS_PLIST = join(
  "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac",
  "Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist",
);

/**
 * Read standings that ALREADY cover the Things group container, so opening a
 * file inside it adds no consent class that is not already settled.
 *
 * `explicit-db` is deliberately absent: a caller-supplied database path says
 * nothing about the container, and opening it to find out is the "try it and
 * see" the Article I corollary forbids. Such a caller gets `unreadable`, which
 * is permissive — exactly the right direction for a path outside the doctrine.
 */
const CONTAINER_REACHABLE: ReadonlySet<ReadCapabilityMode> = new Set<ReadCapabilityMode>([
  "helpers",
  "direct-fda",
  "session-grant",
]);

function extractUriSchemeEnabledDefault(plistBytes: Buffer): string {
  return execFileSync("plutil", ["-extract", "uriSchemeEnabled", "raw", "-o", "-", "--", "-"], {
    input: plistBytes,
    encoding: "utf8",
    timeout: 5000,
  });
}

/** The one line every not-enabled verdict ends with. */
const URL_SETTINGS_PATH = "Things ▸ Settings ▸ General ▸ Enable Things URLs";

/**
 * Has Things been authorized to act on `things:///` commands, and how do we know?
 *
 * Stateless per invocation, like every other verdict here: the setting is the
 * user's to flip at any moment, and a cached "yes" would be a stored onboarding
 * flag by another name. The common case costs one file read plus one `plutil`.
 *
 * WHY THIS IS GATED ON THE READ STANDING. The plist lives inside the Things
 * group container, which is the same `kTCCServiceSystemPolicyAppData` class as
 * the database — so the open is itself what would raise the app-data modal on a
 * machine that holds no standing. This function therefore never opens it
 * speculatively: it asks {@link readCapability} first and reports `unreadable`
 * unless the container is already reachable (helpers, FDA, or a live session
 * grant). Where the helpers are serving, the read rides the reader's own
 * security-scoped bookmark over the container, so the prefs plist is inside the
 * granted subtree and no host grant is involved at all.
 *
 * MEASURED, all three states (URLEN1, golden-v4 / Things 3.23):
 *
 *  - `1` — URL mutations execute.
 *  - `0` — every mutating verb (`add`, token-bearing `update`, the `json`
 *    batch) is dropped in TOTAL SILENCE: zero row delta, no dialog, no window
 *    of any kind, and nothing to wait for. Navigation URLs (`things:///show`)
 *    still work, so this gate covers mutations only.
 *  - absent — nobody has answered the app's own first-use "Things URL Scheme"
 *    dialog (Cancel / Enable). The dispatched request PARKS behind that dialog
 *    rather than being dropped, which is what #611 saw: with nobody at the
 *    machine, the verify window expired and the write reported a silent no-op.
 */
export function urlSchemeCapability(deps: CapabilityDeps = {}): UrlSchemeCapability {
  const host = hostApp(deps);
  const standing = (deps.readStanding ?? (() => readCapability({}, deps)))();
  if (!CONTAINER_REACHABLE.has(standing.mode)) {
    return {
      mode: "unreadable",
      detail:
        "the app's preferences are inside the Things data folder, which this process has no " +
        `standing to open (${standing.mode}) — whether ${URL_SETTINGS_PATH} is on is unknown`,
      remediation: [],
      host,
    };
  }
  let bytes: Buffer;
  try {
    bytes = (
      deps.readPrefsPlist ?? (() => readContainerFileSync(join(homedir(), THINGS_PREFS_PLIST)))
    )();
  } catch {
    return {
      mode: "unreadable",
      detail: `the app's preferences file could not be read — whether ${URL_SETTINGS_PATH} is on is unknown`,
      remediation: [],
      host,
    };
  }
  let raw: string;
  try {
    raw = (deps.extractUriSchemeEnabled ?? extractUriSchemeEnabledDefault)(bytes).trim();
  } catch {
    // The file was readable and carries no such key. An unparseable file lands
    // here too, and that is the safe direction: the refusal names a setting the
    // human can flip, and flipping it rewrites the file and clears the verdict.
    return {
      mode: "never-asked",
      detail:
        "nobody has answered Things' own 'Things URL Scheme' dialog on this machine — the app " +
        "holds the first URL command behind it, and a command dispatched now waits there " +
        "instead of running",
      remediation: [
        `turn on ${URL_SETTINGS_PATH}, then retry`,
        "or send one `things:///` command while you are at the machine and click Enable",
      ],
      host,
    };
  }
  if (raw === "1" || raw === "true") {
    return { mode: "enabled", detail: `${URL_SETTINGS_PATH} is on`, remediation: [], host };
  }
  if (raw === "0" || raw === "false") {
    return {
      mode: "disabled",
      detail:
        `${URL_SETTINGS_PATH} is off — the app puts URL commands in an alert on its own ` +
        "window and holds them there instead of running them",
      remediation: [`turn on ${URL_SETTINGS_PATH}, then retry`],
      host,
    };
  }
  // A shape we have never seen. Reporting it verbatim beats guessing which way
  // the app would read it, and `unreadable` lets the write proceed and be judged
  // by the verify rather than refused on a value nobody has measured.
  return {
    mode: "unreadable",
    detail: `the app records an unrecognized value for ${URL_SETTINGS_PATH} (${raw})`,
    remediation: [],
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

/** Thrown when a URL-scheme mutation is refused for want of the app's own authorization. */
export class UrlSchemeCapabilityError extends Error {
  readonly remediation: string[];
  readonly capability: UrlSchemeCapability;
  constructor(capability: UrlSchemeCapability) {
    super(
      `Things will not act on URL commands: ${capability.detail}. ${capability.remediation.join("; ")}.`,
    );
    this.name = "UrlSchemeCapabilityError";
    this.remediation = capability.remediation;
    this.capability = capability;
  }
}

/** Test seam: forget the one memo this module keeps (the host's display name). */
export function resetCapabilityForTests(): void {
  resetHostAccessForTests();
}
