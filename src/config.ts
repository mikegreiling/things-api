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
   * Opt-in to capabilities riding undocumented app surfaces (the private
   * sdef reorder command). Guarded further by the pipeline's sdef canary.
   */
  allowExperimental: boolean;
  /**
   * The Accessibility GUI ("ui") write vector. When disabled the vector does
   * not exist on this machine: its GUI-only operations report unsupported.
   * Enabling it is the FIRST of two keys — every ui-vector call still needs a
   * per-call `dangerouslyDriveGui` acknowledgement. Intended for a dedicated
   * always-on Mac ("closet mini") kept unlocked; see docs/design/ui-vector.md.
   */
  ui: { enabled: boolean };
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

interface ConfigFile {
  profile?: Profile;
  maxDisruption?: DisruptionTier;
  actor?: string;
  auditEnabled?: boolean;
  acceptedFingerprint?: string;
  allowExperimental?: boolean;
  uiEnabled?: boolean;
}

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
  const uiEnv = boolEnvOverride(env["THINGS_API_UI_ENABLED"], "true", "false");

  return {
    profile,
    maxDisruption,
    actor: env["THINGS_API_ACTOR"] ?? file.actor ?? `${username}@cli`,
    auditEnabled: auditEnv ?? file.auditEnabled ?? true,
    acceptedFingerprint: file.acceptedFingerprint ?? null,
    allowExperimental: experimentalEnv ?? file.allowExperimental ?? false,
    ui: { enabled: uiEnv ?? file.uiEnabled ?? false },
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
      "allow-experimental",
      cfg.allowExperimental,
      file.allowExperimental !== undefined,
      boolEnvOverride(env["THINGS_API_ALLOW_EXPERIMENTAL"], "true", "false") !== undefined,
    ),
    view(
      "ui-enabled",
      cfg.ui.enabled,
      file.uiEnabled !== undefined,
      boolEnvOverride(env["THINGS_API_UI_ENABLED"], "true", "false") !== undefined,
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
