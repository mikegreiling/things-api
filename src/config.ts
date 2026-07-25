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

  const profile: Profile =
    env["THINGS_API_PROFILE"] === "dedicated-server" || file.profile === "dedicated-server"
      ? "dedicated-server"
      : "workstation";

  const envTier = env["THINGS_API_MAX_DISRUPTION"];
  const maxDisruption = (
    envTier !== undefined && /^[0-3]$/.test(envTier)
      ? Number(envTier)
      : (file.maxDisruption ?? PROFILE_DEFAULT_TIER[profile])
  ) as DisruptionTier;

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // leave "unknown"
  }

  return {
    profile,
    maxDisruption,
    actor: env["THINGS_API_ACTOR"] ?? file.actor ?? `${username}@cli`,
    auditEnabled: env["THINGS_API_AUDIT"] === "off" ? false : (file.auditEnabled ?? true),
    acceptedFingerprint: file.acceptedFingerprint ?? null,
    allowExperimental:
      env["THINGS_API_ALLOW_EXPERIMENTAL"] === "true" || file.allowExperimental === true,
    ui: {
      enabled: env["THINGS_API_UI_ENABLED"] === "true" || file.uiEnabled === true,
    },
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
 * of those three supplied it.
 */
export interface ConfigKeyView {
  key: string;
  value: string | number | boolean | null;
  source: "env" | "stored" | "default";
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
 * on-disk config supplied it, and `default` otherwise.
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
  const envTier = env["THINGS_API_MAX_DISRUPTION"];
  const view = configKeyView;
  return [
    view(
      "profile",
      cfg.profile,
      file.profile !== undefined,
      env["THINGS_API_PROFILE"] === "dedicated-server",
    ),
    view(
      "maxDisruption",
      cfg.maxDisruption,
      file.maxDisruption !== undefined,
      envTier !== undefined && /^[0-3]$/.test(envTier),
    ),
    view("actor", cfg.actor, file.actor !== undefined, env["THINGS_API_ACTOR"] !== undefined),
    view(
      "auditEnabled",
      cfg.auditEnabled,
      file.auditEnabled !== undefined,
      env["THINGS_API_AUDIT"] === "off",
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
      env["THINGS_API_ALLOW_EXPERIMENTAL"] === "true",
    ),
    view(
      "ui-enabled",
      cfg.ui.enabled,
      file.uiEnabled !== undefined,
      env["THINGS_API_UI_ENABLED"] === "true",
    ),
  ];
}

/** One key's effective view, or undefined for an unknown key (`config get <key>`). */
export function getConfigKey(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigKeyView | undefined {
  return describeConfig(env).find((v) => v.key === key);
}
