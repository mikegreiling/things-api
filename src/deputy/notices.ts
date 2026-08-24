/**
 * The PASSIVE helpers notices — what a human sees on a command they were
 * running anyway, without asking about the helpers at all (the skill-drift
 * precedent, src/cli/skill-check.ts).
 *
 * Two conditions, both computed from disk with no handshake and no prompt:
 *
 *  - `version-skew`: routing is on (`auto`/`true`), a bundle IS installed, and
 *    its version differs from the one this package expects. The remedy is a
 *    rebuild + reinstall — the installed bundle is a COPY, so restarting it
 *    would only restart the stale code.
 *  - `absent-hint`: nothing is installed, the routing mode has never been set,
 *    and the hint has not been shown for {@link HELPERS_HINT_INTERVAL_DAYS}
 *    days. This one is a suggestion, not a fault, so it is throttled by a stamp
 *    in the state dir and suppressible like the rest.
 *
 * Emission (gating, kill switch, the one-line-per-process budget) belongs to
 * the caller — src/cli/helpers-check.ts. These functions only decide.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getConfigKey, type HelpersMode, loadConfig } from "../config.ts";
import { stateDir } from "../paths.ts";
import { installedHelpersVersion } from "./install.ts";
import { EXPECTED_HELPERS_VERSION, helpersInstalledBundlePath } from "./protocol.ts";

/** How long the absence hint stays quiet after being shown once. */
export const HELPERS_HINT_INTERVAL_DAYS = 14;

export type HelpersNoticeKind = "version-skew" | "absent-hint";

export interface HelpersNotice {
  kind: HelpersNoticeKind;
  /** The one line to print (no prefix — the notice sink adds it). */
  text: string;
}

export interface HelpersNoticeOptions {
  env?: NodeJS.ProcessEnv;
  /** Wall clock (ms) for the hint throttle; defaults to now. */
  now?: number;
  /** Host platform; the helpers are macOS-only, so nothing fires elsewhere. */
  platform?: string;
  /**
   * Test seam. Defaults to the real provenance: true when `helpers-enabled` is
   * neither stored nor forced by the environment (nobody has ever answered the
   * routing question on this host).
   */
  modeUntouched?: boolean;
}

function hintStampPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "helpers-hint.json");
}

/** When the absence hint was last shown (ms), or null when never/unreadable. */
export function lastHelpersHintAt(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    const raw = JSON.parse(readFileSync(hintStampPath(env), "utf8")) as { shownAt?: unknown };
    const parsed = typeof raw.shownAt === "string" ? Date.parse(raw.shownAt) : NaN;
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/** Record that the absence hint was shown, restarting its throttle window. */
export function markHelpersHintShown(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  try {
    mkdirSync(stateDir(env), { recursive: true });
    writeFileSync(
      hintStampPath(env),
      `${JSON.stringify({ shownAt: new Date(now).toISOString() }, null, 2)}\n`,
    );
  } catch {
    // A hint that cannot remember itself is still better than a broken command.
  }
}

/**
 * The notice this machine has earned, or null when it has nothing to say.
 * Skew outranks the hint (they are mutually exclusive anyway: one needs an
 * installed bundle, the other its absence).
 */
export function computeHelpersNotice(options: HelpersNoticeOptions = {}): HelpersNotice | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const mode: HelpersMode = loadConfig(env).helpersMode;
  if (mode === "false") return null;

  const installed = existsSync(helpersInstalledBundlePath(env));
  if (installed) {
    const version = installedHelpersVersion(env);
    if (version === null || version === EXPECTED_HELPERS_VERSION) return null;
    return {
      kind: "version-skew",
      text:
        `helpers v${version} installed, this package expects v${EXPECTED_HELPERS_VERSION} — ` +
        "rebuild with `bash scripts/build-helpers.sh` and rerun `things helpers setup` " +
        "(THINGS_API_NO_HELPERS_CHECK=1 silences this)",
    };
  }

  // Nothing installed: a suggestion, and only for a host that has never
  // expressed an opinion — an explicit `auto`/`true` owner is mid-setup, not
  // in need of an introduction.
  const untouched =
    options.modeUntouched ?? getConfigKey("helpers-enabled", env)?.source === "default";
  if (!untouched) return null;
  const last = lastHelpersHintAt(env);
  const now = options.now ?? Date.now();
  if (last !== null && now - last < HELPERS_HINT_INTERVAL_DAYS * 86_400_000) return null;
  return {
    kind: "absent-hint",
    text:
      "database reads and app automation run in THIS process, so macOS permission grants " +
      "follow whichever terminal or agent runtime started it — `things helpers setup` moves " +
      "them onto two stable helpers (THINGS_API_NO_HELPERS_CHECK=1 silences this)",
  };
}
