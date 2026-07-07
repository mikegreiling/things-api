/**
 * Active Automation-consent probe: send the smallest possible AppleScript
 * query to Things and classify the outcome. OPT-IN because the probe itself
 * is a consent-requiring call — on an unauthorized machine it makes macOS
 * show the Automation prompt (useful during onboarding, unwanted everywhere
 * else). Skipped when Things is not running so a diagnostic never launches
 * the app.
 */
import { execFileSync } from "node:child_process";

export type AutomationProbeStatus =
  | "granted"
  | "denied"
  | "pending"
  | "app-not-running"
  | "inconclusive";

export interface AutomationProbeResult {
  status: AutomationProbeStatus;
  detail: string;
}

export interface AutomationProbeDeps {
  isAppRunning?: () => boolean;
  /** Test seam: run the osascript probe; throws like execFileSync on failure. */
  run?: (script: string, timeoutMs: number) => string;
  timeoutMs?: number;
}

const PROBE_SCRIPT = 'tell application "Things3" to count of areas';

function defaultIsAppRunning(): boolean {
  try {
    execFileSync("pgrep", ["-x", "Things3"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultRun(script: string, timeoutMs: number): string {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: timeoutMs });
}

export function probeAutomation(deps: AutomationProbeDeps = {}): AutomationProbeResult {
  if (!(deps.isAppRunning ?? defaultIsAppRunning)()) {
    return {
      status: "app-not-running",
      detail:
        "Things is not running — the probe was skipped so a diagnostic never launches the " +
        "app. Launch Things and re-run.",
    };
  }
  try {
    (deps.run ?? defaultRun)(PROBE_SCRIPT, deps.timeoutMs ?? 8000);
    return { status: "granted", detail: "automation of Things is authorized for this process." };
  } catch (err) {
    const e = err as { signal?: string | null; killed?: boolean; stderr?: unknown };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : err instanceof Error ? err.message : String(err);
    if (e.killed === true || e.signal === "SIGTERM") {
      return {
        status: "pending",
        detail:
          "the probe timed out — the shape of an unanswered macOS consent dialog. Check the " +
          "machine's screen for an Automation prompt and approve it.",
      };
    }
    if (/-1743|not authori[sz]ed to send apple events/i.test(stderr)) {
      return {
        status: "denied",
        detail:
          "macOS declined the Apple Event (-1743): Automation permission for this process " +
          "(or the app hosting it) is missing or was denied. Grant it under System Settings " +
          "> Privacy & Security > Automation, or see docs/setup.md for headless setups.",
      };
    }
    return {
      status: "inconclusive",
      detail: `the probe failed for another reason: ${stderr.trim() || "unknown error"}`,
    };
  }
}
