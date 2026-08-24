/**
 * The instance-scoped app-data grant marker (docs/design/permissions-doctrine.md,
 * Article III).
 *
 * macOS has a consent class beneath Full Disk Access — "would like to access
 * data from other apps" (`kTCCServiceSystemPolicyAppData`) — that covers the
 * Things group container. It is MEASURED allow-once-per-responsible-process-
 * instance: the grant is pinned to the running host app, and it dies when that
 * app quits. It is also, by TCC's ask-on-access design, undetectable without
 * FDA: the only way to learn whether you hold it is to open the file, and the
 * open is what raises the modal. That is precisely what Article I forbids
 * outside a ceremony.
 *
 * So the grant is not detected — it is WITNESSED. `things setup` deliberately
 * provokes the modal, and if the container open then succeeds it writes this
 * marker recording WHICH host-app instance the grant was minted for. A later
 * invocation reads the marker and re-derives that instance's identity; if it
 * still matches, the grant is necessarily still live and the container may be
 * opened without risk of a dialog.
 *
 * The marker is NOT an "onboarded" flag and cannot become one: it records a
 * live-instance fact (pid + that pid's start time), so it self-invalidates the
 * moment the host app quits — because the grant it describes dies at the same
 * instant. Nothing here can outlive what it describes.
 *
 * The one honest hole: a `tccutil reset` performed by the user mid-session
 * revokes the grant while the app instance keeps running, so the marker stays
 * valid and the next container open re-prompts. That is user-caused, visible,
 * and recorded in the doctrine's enforcement inventory rather than papered over.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "./paths.ts";

/**
 * How far apart two `kern.boottime` readings may sit and still describe the
 * same boot. MEASURED 2026-08-24: macOS re-derives boot time from the current
 * clock after sleep/wake, so the value drifts by minutes on a laptop that
 * suspends — an exact match would invalidate the marker on every lid close.
 * The pid + start-time pair is what actually carries the guarantee; boot time
 * is only a coarse guard against pid reuse across a restart, and a restart
 * moves it by far more than this.
 */
const BOOT_TIME_TOLERANCE_SEC = 3600;

export interface SessionGrantMarker {
  /** The host app the grant was minted for. */
  hostBundleId: string;
  /** That app instance's pid at the time of the ceremony. */
  hostPid: number;
  /** The pid's start time (`ps -o lstart`), which pid reuse cannot reproduce. */
  hostStart: string;
  /** `kern.boottime` seconds, a coarse cross-restart guard. */
  bootTime: number;
  /** When the ceremony witnessed the grant (ISO-8601), for `doctor`. */
  witnessedAt: string;
}

/** Seams so tests never shell out or touch the real state directory. */
export interface SessionGrantDeps {
  env?: NodeJS.ProcessEnv;
  /** The running host app's pid, from LaunchServices. */
  hostPid?: (bundleId: string) => number | null;
  /** A pid's start time, stable for that process's whole life. */
  processStart?: (pid: number) => string | null;
  /** Seconds since the epoch at which the kernel says the system booted. */
  bootTime?: () => number | null;
  now?: () => Date;
}

export function sessionGrantPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "session-grant.json");
}

function hostPidDefault(bundleId: string): number | null {
  try {
    // LaunchServices answers for RUNNING apps only, which is exactly the
    // question: a bundle id with no pid means that instance is gone.
    const out = execFileSync("lsappinfo", ["info", "-only", "pid", bundleId], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /"pid"\s*=\s*(\d+)/.exec(out);
    const pid = match?.[1] !== undefined ? Number(match[1]) : Number.NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processStartDefault(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    // A dead pid exits nonzero — the instance is gone, which is an answer.
    return null;
  }
}

function bootTimeDefault(): number | null {
  try {
    const out = execFileSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /sec\s*=\s*(\d+)/.exec(out);
    return match?.[1] !== undefined ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** The live identity of the host app instance, or null when it is not running. */
function currentInstance(
  bundleId: string,
  deps: SessionGrantDeps,
): { pid: number; start: string } | null {
  const pid = (deps.hostPid ?? hostPidDefault)(bundleId);
  if (pid === null) return null;
  const start = (deps.processStart ?? processStartDefault)(pid);
  return start === null ? null : { pid, start };
}

/**
 * Record that a container open succeeded for the CURRENT host-app instance.
 * Called by `things setup` only, and only after the open actually worked —
 * writing this on any other occasion would turn a live-instance fact into the
 * stored "onboarded" flag the doctrine forbids.
 */
export function witnessSessionGrant(
  bundleId: string,
  deps: SessionGrantDeps = {},
): SessionGrantMarker | null {
  const env = deps.env ?? process.env;
  const instance = currentInstance(bundleId, deps);
  if (instance === null) return null;
  const marker: SessionGrantMarker = {
    hostBundleId: bundleId,
    hostPid: instance.pid,
    hostStart: instance.start,
    bootTime: (deps.bootTime ?? bootTimeDefault)() ?? 0,
    witnessedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  const path = sessionGrantPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

/** Forget the marker (a ceremony that finds the grant gone clears the stale claim). */
export function clearSessionGrant(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(sessionGrantPath(env), { force: true });
}

export type SessionGrantVerdict =
  | { valid: true; marker: SessionGrantMarker }
  | { valid: false; reason: string };

/**
 * Is a witnessed app-data grant still live for THIS host-app instance?
 *
 * Costs a marker read plus, only when a marker exists, two small process
 * queries. Never runs at all when Full Disk Access already answers the
 * question, which is the common direct-mode case.
 */
export function sessionGrantValid(
  bundleId: string | null,
  deps: SessionGrantDeps = {},
): SessionGrantVerdict {
  const env = deps.env ?? process.env;
  if (bundleId === null) {
    return { valid: false, reason: "this process has no host application identity" };
  }
  let marker: SessionGrantMarker;
  try {
    marker = JSON.parse(readFileSync(sessionGrantPath(env), "utf8")) as SessionGrantMarker;
  } catch {
    return { valid: false, reason: "no app-data grant has been witnessed on this machine" };
  }
  if (marker.hostBundleId !== bundleId) {
    return {
      valid: false,
      reason: `the witnessed grant belongs to ${marker.hostBundleId}, not ${bundleId}`,
    };
  }
  const instance = currentInstance(bundleId, deps);
  if (instance === null) {
    return { valid: false, reason: "the application that held the grant is no longer running" };
  }
  if (instance.pid !== marker.hostPid || instance.start !== marker.hostStart) {
    return {
      valid: false,
      reason: "the application that held the grant has been restarted since",
    };
  }
  const boot = (deps.bootTime ?? bootTimeDefault)();
  if (boot !== null && Math.abs(boot - marker.bootTime) > BOOT_TIME_TOLERANCE_SEC) {
    return { valid: false, reason: "the machine has restarted since the grant was witnessed" };
  }
  return { valid: true, marker };
}
