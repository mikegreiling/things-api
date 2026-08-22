/**
 * Config profiles + env overrides.
 *
 * `workstation` (default): a human may be at the screen — background app
 * launch (tier 1) is acceptable, focus steal (tier 2) requires an explicit
 * flag. `dedicated-server`: nobody is watching; tier 2 allowed by default.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

import { configDir } from "./paths.ts";

export type Profile = "workstation" | "dedicated-server";
export type DisruptionTier = 0 | 1 | 2 | 3;

export interface ThingsApiConfig {
  profile: Profile;
  /** Highest disruption tier allowed without explicit per-call escalation. */
  maxDisruption: DisruptionTier;
  /** Audit attribution when the caller does not pass one. */
  actor: string;
  /** JSONL audit trail on/off (default on). */
  auditEnabled: boolean;
  /** User-accepted drifted fingerprint (loud escape hatch; see design §6). */
  acceptedFingerprint: string | null;
  /**
   * The Things app version the behavioral LAWS (docs/reference/assumption-register.md)
   * were last certified against. Set when a baseline ships or by an explicit
   * `things config set certified-app-version <X>`. The schema fingerprint cannot
   * see BEHAVIORAL drift (an app update can move an insertion law with zero schema
   * delta), so `things doctor` compares this against the installed version and
   * emits a PASSIVE, non-blocking notice on a mismatch, pointing at the drift
   * suite. Null when never certified (no notice). Precedent: the skill-version
   * passive drift notice (src/cli/skill-check.ts).
   */
  certifiedAppVersion: string | null;
  /**
   * Allow capabilities that ride the app's PRIVATE, UNDOCUMENTED sdef reorder
   * command (default true). This is a private vendor surface, NOT a half-baked
   * "experimental" one: every write is verify-per-write, fingerprint-gated, and
   * canaried by the o-suite (incl. O17), which together detect any divergence.
   * The bidirectional env/config off-switch is retained for hosts that want the
   * private surface disabled; when off, the planner falls back to a proven bounce
   * wherever one exists and refuses only where no enabled path remains.
   */
  allowExperimental: boolean;
  /**
   * Whether the `when=`-bounce reorder protocols may run (default true). When
   * false the move/reorder planner REFUSES every bounce-dependent placement
   * (within-heading order, area-someday order, area-less loose anytime, and the
   * top-level projects / evening scopes) with a teaching error naming this key —
   * it never silently falls back to a destructive or unverified path.
   */
  bounceEnabled: boolean;
  /**
   * Cap on the number of items a single bounce reorder may touch (default 30).
   * Each item costs two verified mutations (~110 ms/item guest-local, BOUNCE2-t);
   * the cap bounds the wall-clock and the Things-Cloud change-record fan-out.
   */
  bounceMaxItems: number;
  /**
   * Auto-launch Things for a write when the app is not running (default true).
   * A write needs the app up to land through any real transport; when it is
   * closed the pipeline background-launches it (tier 1) and waits closed-loop
   * for it to become ready before dispatching. Set false to instead REFUSE a
   * write against a closed app with an environment `blocked` (zero dispatch) —
   * for a host that must never surface the app on its own. Reads are unaffected
   * (they hit the database directly and never launch anything).
   */
  autoLaunch: boolean;
  /**
   * Route privileged primitives (database reads, osascript, container file
   * reads) through the installed helper pair (default false): things-deputy
   * for automation, the sandboxed things-reader for file access. The helpers
   * are launchd-supervised signed processes whose one job is to be the stable
   * macOS permission grantees, so Automation/Accessibility/file grants stop
   * churning with agent-harness updates. When enabled but unreachable, every
   * process falls back to DIRECT execution (today's behavior) with a one-line
   * notice — see src/deputy/routing.ts and docs/design/agent-daemon.md §β1.
   */
  helpersEnabled: boolean;
  /**
   * The Accessibility GUI ("ui") write vector. When disabled the vector does
   * not exist on this machine: its GUI-only operations report unsupported.
   * Enabling it is the FIRST of two keys — every ui-vector call still needs a
   * per-call `dangerouslyDriveGui` acknowledgement. Intended for a dedicated
   * always-on Mac ("closet mini") kept unlocked; see docs/design/ui-vector.md.
   */
  ui: {
    enabled: boolean;
    /**
     * The overall UI-drive budget in milliseconds (default 90000). The ui
     * vector's own watchdog aborts a drive that exceeds this — clearing any open
     * dialog and returning a structured, honest timeout — so the CLI, not the
     * caller, is the first to give up (TRACE1, #487). Generous by design: a live
     * production database (large + Things-Cloud syncing) commits the Repeat
     * dialog several times slower than the lab golden, so the default is the
     * lab-measured drive time multiplied by a wide safety factor. Agent callers
     * should still allow a longer timeout than this (≥120s) so the watchdog wins.
     * Optional in the type (a hand-built config may omit it, defaulting to
     * {@link DEFAULT_UI_DRIVE_BUDGET_MS}); {@link loadConfig} always populates it.
     */
    driveBudgetMs?: number;
  };
  /**
   * Dev-mode step-timeline trace (TRACE1, #487), tri-state. `true`/`false` force
   * tracing on/off; `null` (the default) follows the build — on for a `-dev`
   * source checkout, off for a published install. When on, every write
   * invocation writes a local JSONL timeline under the trace directory (see
   * src/trace/tracer.ts). LOCAL-ONLY: a trace may hold real task titles, so the
   * files must never be committed or attached to a public issue. Optional in the
   * type (a hand-built config may omit it = follow the build); {@link loadConfig}
   * always populates it.
   */
  traceEnabled?: boolean | null;
  /**
   * Container-scoped sandbox: a raw ref (uuid / uuid-prefix / unique area or
   * project name) plus where it came from, resolved to a pinned container at
   * `openThings()`. Null when unscoped. A stored `scope` jails EVERY process on
   * this host — including the owner's own terminal — so per-process scoping
   * belongs on `THINGS_API_SCOPE` / the MCP `--scope` flag, not here (see
   * docs/design/container-scope.md, Trust model). The MCP flag outranks env,
   * which outranks this stored key. Optional in the type (a hand-built config
   * omits it = unscoped); {@link loadConfig} always populates it.
   */
  scope?: { ref: string; source: "env" | "config" } | null;
  host: string;
}

const PROFILE_DEFAULT_TIER: Record<Profile, DisruptionTier> = {
  workstation: 1,
  "dedicated-server": 2,
};

/**
 * A THINGS_API_* boolean override. Returns the forced value when the env var
 * holds a recognized token, or undefined when unset/unrecognized (so the
 * caller falls through to stored config, then the built-in default). The
 * override is BIDIRECTIONAL — a recognized value always wins over stored
 * config, so an env var can force a vector off as well as on. `trueToken` /
 * `falseToken` let THINGS_API_AUDIT keep its legacy on/off vocabulary while
 * the vectors use true/false.
 */
function boolEnvOverride(
  raw: string | undefined,
  trueToken: string,
  falseToken: string,
): boolean | undefined {
  if (raw === trueToken) return true;
  if (raw === falseToken) return false;
  return undefined;
}

/** THINGS_API_PROFILE override, or undefined when unset/unrecognized. */
function profileEnvOverride(raw: string | undefined): Profile | undefined {
  return raw === "workstation" || raw === "dedicated-server" ? raw : undefined;
}

/** THINGS_API_MAX_DISRUPTION override, or undefined when unset/unrecognized. */
function tierEnvOverride(raw: string | undefined): DisruptionTier | undefined {
  return raw !== undefined && /^[0-3]$/.test(raw) ? (Number(raw) as DisruptionTier) : undefined;
}

/**
 * A THINGS_API_BOUNCE_MAX_ITEMS override, or undefined when unset/unrecognized.
 * Only a positive integer is accepted (a bounce touches at least one item);
 * anything else falls through to stored config, then the built-in default.
 */
function positiveIntEnvOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

interface ConfigFile {
  profile?: Profile;
  maxDisruption?: DisruptionTier;
  actor?: string;
  auditEnabled?: boolean;
  acceptedFingerprint?: string;
  certifiedAppVersion?: string;
  allowExperimental?: boolean;
  bounceEnabled?: boolean;
  bounceMaxItems?: number;
  autoLaunch?: boolean;
  helpersEnabled?: boolean;
  uiEnabled?: boolean;
  uiDriveBudgetMs?: number;
  traceEnabled?: boolean;
  scope?: string;
}

/** Default overall UI-drive budget (ms) — see {@link ThingsApiConfig.ui}. */
export const DEFAULT_UI_DRIVE_BUDGET_MS = 90_000;

function configFilePath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ThingsApiConfig {
  let file: ConfigFile = {};
  const path = configFilePath(env);
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
    } catch {
      // Malformed config falls back to defaults; doctor reports it.
    }
  }

  // Precedence for every key: env > stored > default. A recognized env value
  // always wins over stored config; an unset/unrecognized one falls through.
  const profile: Profile =
    profileEnvOverride(env["THINGS_API_PROFILE"]) ?? file.profile ?? "workstation";

  const maxDisruption: DisruptionTier =
    tierEnvOverride(env["THINGS_API_MAX_DISRUPTION"]) ??
    file.maxDisruption ??
    PROFILE_DEFAULT_TIER[profile];

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // leave "unknown"
  }

  const auditEnv = boolEnvOverride(env["THINGS_API_AUDIT"], "on", "off");
  const experimentalEnv = boolEnvOverride(env["THINGS_API_ALLOW_EXPERIMENTAL"], "true", "false");
  const bounceEnabledEnv = boolEnvOverride(env["THINGS_API_BOUNCE_ENABLED"], "true", "false");
  const bounceMaxItemsEnv = positiveIntEnvOverride(env["THINGS_API_BOUNCE_MAX_ITEMS"]);
  const autoLaunchEnv = boolEnvOverride(env["THINGS_API_AUTO_LAUNCH"], "true", "false");
  const helpersEnv = boolEnvOverride(env["THINGS_API_HELPERS"], "true", "false");
  const uiEnv = boolEnvOverride(env["THINGS_API_UI_ENABLED"], "true", "false");
  const uiDriveBudgetEnv = positiveIntEnvOverride(env["THINGS_API_UI_DRIVE_BUDGET_MS"]);
  const traceEnv = boolEnvOverride(env["THINGS_API_TRACE"], "true", "false");

  // Scope precedence within the config layer: THINGS_API_SCOPE env > stored
  // `scope` key. The MCP `--scope` flag outranks BOTH and is applied above this
  // layer, at openThings(). Fail-closed resolution to a container happens there.
  const scopeEnv = env["THINGS_API_SCOPE"];
  const scope: ThingsApiConfig["scope"] =
    scopeEnv !== undefined && scopeEnv !== ""
      ? { ref: scopeEnv, source: "env" }
      : file.scope !== undefined && file.scope !== ""
        ? { ref: file.scope, source: "config" }
        : null;

  return {
    profile,
    maxDisruption,
    actor: env["THINGS_API_ACTOR"] ?? file.actor ?? `${username}@cli`,
    auditEnabled: auditEnv ?? file.auditEnabled ?? true,
    acceptedFingerprint: file.acceptedFingerprint ?? null,
    certifiedAppVersion: file.certifiedAppVersion ?? null,
    allowExperimental: experimentalEnv ?? file.allowExperimental ?? true,
    bounceEnabled: bounceEnabledEnv ?? file.bounceEnabled ?? true,
    bounceMaxItems: bounceMaxItemsEnv ?? file.bounceMaxItems ?? 30,
    autoLaunch: autoLaunchEnv ?? file.autoLaunch ?? true,
    helpersEnabled: helpersEnv ?? file.helpersEnabled ?? false,
    ui: {
      enabled: uiEnv ?? file.uiEnabled ?? false,
      driveBudgetMs: uiDriveBudgetEnv ?? file.uiDriveBudgetMs ?? DEFAULT_UI_DRIVE_BUDGET_MS,
    },
    // Tri-state: env > stored > null (null = "follow the -dev build signal",
    // resolved by resolveTraceEnabled in src/trace/tracer.ts).
    traceEnabled: traceEnv ?? file.traceEnabled ?? null,
    scope,
    host: hostname(),
  };
}

/** Persist one config key (CLI `things config set`). */
export function saveConfigKey(
  key: keyof ConfigFile,
  value: string | number | boolean | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  const path = configFilePath(env);
  let file: ConfigFile = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
    } catch {
      file = {};
    }
  }
  if (value === null) {
    delete file[key];
  } else {
    (file as Record<string, unknown>)[key] = value;
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * One config key's effective value and where it came from. `key` is the
 * `things config set` / `things config get` spelling; `value` is the effective
 * value after env override → stored file → built-in default; `source` says which
 * layer supplied it. `derived` marks a read-only value computed from the
 * environment (`host`) or from another key (the profile-derived `maxDisruption`
 * default) rather than settable directly.
 */
export interface ConfigKeyView {
  key: string;
  value: string | number | boolean | null;
  source: "env" | "stored" | "default" | "derived";
}

function readConfigFile(env: NodeJS.ProcessEnv): ConfigFile {
  const path = configFilePath(env);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
    } catch {
      // Malformed config → treated as no stored keys (doctor reports it).
    }
  }
  return {};
}

/**
 * The effective value + provenance of every config key, in a stable order —
 * backing `things config get`. Env/stored/default detection mirrors
 * {@link loadConfig} exactly, so a key reads `env` only when an env var actually
 * overrode it (a THINGS_API_* value that loadConfig honors), `stored` when the
 * on-disk config supplied it, `derived` for a read-only value computed from the
 * environment or another key, and `default` otherwise.
 */
function configKeyView(
  key: string,
  value: string | number | boolean | null,
  stored: boolean,
  fromEnv: boolean,
): ConfigKeyView {
  return { key, value, source: fromEnv ? "env" : stored ? "stored" : "default" };
}

export function describeConfig(env: NodeJS.ProcessEnv = process.env): ConfigKeyView[] {
  const file = readConfigFile(env);
  const cfg = loadConfig(env);
  const view = configKeyView;

  const tierFromEnv = tierEnvOverride(env["THINGS_API_MAX_DISRUPTION"]) !== undefined;
  const maxDisruption: ConfigKeyView = {
    key: "maxDisruption",
    value: cfg.maxDisruption,
    // env > stored > profile-derived default (the built-in fallback is
    // computed from `profile`, so it reports `derived`, not `default`).
    source: tierFromEnv ? "env" : file.maxDisruption !== undefined ? "stored" : "derived",
  };

  return [
    view(
      "profile",
      cfg.profile,
      file.profile !== undefined,
      profileEnvOverride(env["THINGS_API_PROFILE"]) !== undefined,
    ),
    maxDisruption,
    view("actor", cfg.actor, file.actor !== undefined, env["THINGS_API_ACTOR"] !== undefined),
    view(
      "auditEnabled",
      cfg.auditEnabled,
      file.auditEnabled !== undefined,
      boolEnvOverride(env["THINGS_API_AUDIT"], "on", "off") !== undefined,
    ),
    view(
      "accepted-fingerprint",
      cfg.acceptedFingerprint,
      file.acceptedFingerprint !== undefined,
      false,
    ),
    view(
      "certified-app-version",
      cfg.certifiedAppVersion,
      file.certifiedAppVersion !== undefined,
      false,
    ),
    view(
      "allow-experimental",
      cfg.allowExperimental,
      file.allowExperimental !== undefined,
      boolEnvOverride(env["THINGS_API_ALLOW_EXPERIMENTAL"], "true", "false") !== undefined,
    ),
    view(
      "bounce-enabled",
      cfg.bounceEnabled,
      file.bounceEnabled !== undefined,
      boolEnvOverride(env["THINGS_API_BOUNCE_ENABLED"], "true", "false") !== undefined,
    ),
    view(
      "bounce-max-items",
      cfg.bounceMaxItems,
      file.bounceMaxItems !== undefined,
      positiveIntEnvOverride(env["THINGS_API_BOUNCE_MAX_ITEMS"]) !== undefined,
    ),
    view(
      "auto-launch",
      cfg.autoLaunch,
      file.autoLaunch !== undefined,
      boolEnvOverride(env["THINGS_API_AUTO_LAUNCH"], "true", "false") !== undefined,
    ),
    view(
      "helpers-enabled",
      cfg.helpersEnabled,
      file.helpersEnabled !== undefined,
      boolEnvOverride(env["THINGS_API_HELPERS"], "true", "false") !== undefined,
    ),
    view(
      "ui-enabled",
      cfg.ui.enabled,
      file.uiEnabled !== undefined,
      boolEnvOverride(env["THINGS_API_UI_ENABLED"], "true", "false") !== undefined,
    ),
    view(
      "ui-drive-budget-ms",
      cfg.ui.driveBudgetMs ?? DEFAULT_UI_DRIVE_BUDGET_MS,
      file.uiDriveBudgetMs !== undefined,
      positiveIntEnvOverride(env["THINGS_API_UI_DRIVE_BUDGET_MS"]) !== undefined,
    ),
    view(
      "trace",
      cfg.traceEnabled ?? null,
      file.traceEnabled !== undefined,
      boolEnvOverride(env["THINGS_API_TRACE"], "true", "false") !== undefined,
    ),
    // The container scope's RAW ref (resolved to a container at open); env >
    // stored. A stored value jails every process on this host — see the
    // trust-model note in docs/design/container-scope.md.
    view(
      "scope",
      cfg.scope?.ref ?? null,
      file.scope !== undefined,
      env["THINGS_API_SCOPE"] !== undefined && env["THINGS_API_SCOPE"] !== "",
    ),
    // Read-only, computed from the environment; not settable via `config set`.
    { key: "host", value: cfg.host, source: "derived" },
  ];
}

/** One key's effective view, or undefined for an unknown key (`config get <key>`). */
export function getConfigKey(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigKeyView | undefined {
  return describeConfig(env).find((v) => v.key === key);
}
