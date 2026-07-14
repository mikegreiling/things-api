/**
 * Active Accessibility-consent probe for the ui vector: ask System Events for
 * one element of the Things process's UI tree and classify the outcome. This
 * is a DIFFERENT permission from Automation (which automation-probe.ts covers)
 * — driving the Accessibility tree needs the process running things-api to
 * hold Accessibility (System Settings ▸ Privacy & Security ▸ Accessibility).
 *
 * OPT-IN, exactly like the Automation probe: the query itself is a
 * consent-requiring call, so on an ungranted machine it makes macOS show the
 * Accessibility prompt. Skipped when Things is not running so a diagnostic
 * never launches the app. The probe doubles as a light recipe canary: it
 * resolves the "Items" menu every recipe enters through, so a missing menu
 * (a Things update, or a non-English app) surfaces here too.
 */
import { execFileSync } from "node:child_process";

import { isThingsRunning } from "./automation-probe.ts";

export type AccessibilityProbeStatus =
  | "granted"
  | "denied"
  | "app-not-running"
  | "menu-missing"
  | "inconclusive";

export interface AccessibilityProbeResult {
  status: AccessibilityProbeStatus;
  detail: string;
}

export interface AccessibilityProbeDeps {
  isAppRunning?: () => boolean;
  /** Test seam: run the osascript probe; throws like execFileSync on failure. */
  run?: (script: string, timeoutMs: number) => string;
  timeoutMs?: number;
}

// Resolve the "Items" menu — the entry point of every ui recipe. Returns
// "true"/"false"; a permission failure throws before it can answer.
const PROBE_SCRIPT =
  'tell application "System Events" to tell process "Things3" to return (exists menu "Items" of menu bar 1)';

function defaultRun(script: string, timeoutMs: number): string {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: timeoutMs });
}

export function probeAccessibility(deps: AccessibilityProbeDeps = {}): AccessibilityProbeResult {
  if (!(deps.isAppRunning ?? isThingsRunning)()) {
    return {
      status: "app-not-running",
      detail:
        "Things is not running — the probe was skipped so a diagnostic never launches the " +
        "app. Launch Things and re-run with --probe-accessibility.",
    };
  }
  try {
    const out = (deps.run ?? defaultRun)(PROBE_SCRIPT, deps.timeoutMs ?? 8000).trim();
    if (out === "true") {
      return {
        status: "granted",
        detail: "Accessibility is granted and the Things 'Items' menu resolves.",
      };
    }
    return {
      status: "menu-missing",
      detail:
        "Accessibility appears granted but the 'Items' menu did not resolve — a Things update " +
        "may have changed the menu, or the app may not be in English. The ui recipes would " +
        "refuse (fail-closed) until re-certified.",
    };
  } catch (err) {
    const e = err as { stderr?: unknown };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : err instanceof Error ? err.message : String(err);
    if (/-25211|-1719|not allowed assistive access|accessibility/i.test(stderr)) {
      return {
        status: "denied",
        detail:
          "macOS declined the Accessibility query: the process running things-api is not granted " +
          "Accessibility. Grant it under System Settings > Privacy & Security > Accessibility " +
          "(see docs/setup.md for the closet-mini setup).",
      };
    }
    return {
      status: "inconclusive",
      detail: `the probe failed for another reason: ${stderr.trim() || "unknown error"}`,
    };
  }
}
