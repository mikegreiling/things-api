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
