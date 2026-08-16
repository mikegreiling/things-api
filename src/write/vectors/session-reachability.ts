/**
 * Session-reachability preflight for the dialog-class ui-drive ops (SESSGATE,
 * issue #480). A dialog-class op (make/reschedule a repeat, convert a to-do or
 * heading to a project, move a heading) opens a SHEET on the main Things window
 * and then waits for that sheet through the Accessibility tree. When the Mac's
 * screen is LOCKED, or the user is in a FULL-SCREEN app whose Space hides all
 * ordinary windows, System Events enumerates ZERO windows for every process
 * (it sees only the current Space) — so the sheet opens on an AX-UNREACHABLE
 * window and the dialog-wait times out. Worse, the still-open modal sheet then
 * blocks AppleScript mutations app-wide (a seed auto-trash silently no-ops), and
 * the AX-blind Escape cleanup cannot even confirm the sheet is gone.
 *
 * Proven live on the maintainer's host (2026-08-16): System Events reported 0
 * windows for Things, Finder, AND Safari while Things' own AppleScript dictionary
 * reported 1 visible normal window. This module reproduces that discriminator
 * cheaply BEFORE any mutation, so a locked/fullscreen session refuses fast
 * (`blocked`, exit 4) with zero side effects instead of cascading.
 *
 * The signals (one stable osascript shape):
 *   - `thingsAs`  — Things' own AppleScript window count (`count windows`);
 *   - `thingsAx`  — the System Events (AX) window count for the Things process;
 *   - `allAx`     — the AX window count summed across every foreground app.
 *
 * The discriminator (interpretReachability):
 *   - thingsAx >= 1                      -> reachable (a Things window is AX-visible);
 *   - thingsAx = 0 AND allAx = 0         -> "session": the screen is locked or a
 *                                          full-screen app hides every window;
 *   - thingsAx = 0 AND allAx > 0         -> "window": Things' window is on another
 *                                          Space (thingsAs >= 1) or there is none
 *                                          (thingsAs <= 0);
 *   - anything unparseable (probe error) -> reachable (fail-OPEN: the gate is an
 *                                          EARLY guard, never a replacement for the
 *                                          drive's own fail-closed canary/waits —
 *                                          a flaky probe must not block valid ops).
 */
import type { HazardId } from "../guards.ts";
import type { UiCommand, UiRunResult } from "./ui.ts";

/** Runtime signal from a live probe (or a test seam). -1 = the count could not be read. */
export interface ReachabilityCounts {
  thingsAs: number;
  thingsAx: number;
  allAx: number;
}

export type ReachabilityVerdict =
  | { reachable: true }
  | {
      reachable: false;
      /**
       * "session" — the whole session is AX-blind (locked screen / full-screen
       * app): the HIGH-CONFIDENCE certain-failure case, blocked by BOTH the
       * orchestrator pre-seed gate and the ui-vector in-drive gate. "window" —
       * only Things' window is unreachable (another Space / no window): blocked
       * by the in-drive gate (after the reveal, which would have surfaced a
       * window in a healthy session), but NOT by the pre-seed gate (the reveal
       * may still resolve it, so refusing before seeding would be a false
       * positive).
       */
      scope: "session" | "window";
      detail: string;
      remediation: string;
    };

/** The runtime hazard the gate reports (enforced in the ui vector / orchestrators, not a pre-read guard). */
export const H_UI_SESSION_UNREACHABLE: HazardId = "H-UI-SESSION-UNREACHABLE";

/** A recognizable token in the probe script so a test runner can key off the reachability command. */
const PROBE_MARKER = "-- sessgate-reachability probe";

/**
 * One stable osascript shape returning the three window counts as "AS AX ALL".
 * Every count is wrapped so a lock-time error (a window lookup that throws on an
 * AX-blind session) degrades to -1 rather than failing the whole script.
 */
export function axSessionReachabilityScript(): string {
  return `${PROBE_MARKER}
set thingsAs to -1
try
	tell application "Things3" to set thingsAs to count windows
end try
set thingsAx to -1
set allAx to -1
tell application "System Events"
	try
		set thingsAx to count (windows of process "Things3")
	end try
	try
		set allAx to 0
		repeat with proc in (application processes whose background only is false)
			try
				set allAx to allAx + (count (windows of proc))
			end try
		end repeat
	end try
end tell
return ((thingsAs as integer) as text) & " " & ((thingsAx as integer) as text) & " " & ((allAx as integer) as text)`;
}

/** Parse the "AS AX ALL" line into counts; null when the shape is unrecognizable (probe error). */
export function parseReachabilityCounts(stdout: string): ReachabilityCounts | null {
  const parts = stdout.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [thingsAs, thingsAx, allAx] = parts as [number, number, number];
  return { thingsAs, thingsAx, allAx };
}

const SESSION_DETAIL =
  "Things has no window available on the screen you're viewing — the Mac's screen is locked, or a " +
  "full-screen app is covering the desktop. This operation opens a dialog in Things, which cannot " +
  "appear in that state.";
const SESSION_REMEDIATION =
  "Unlock the Mac, or leave the full-screen app so a Things window is visible on the current " +
  "desktop, then run this again.";
const OTHER_SPACE_DETAIL =
  "The Things window is on another desktop. This operation opens a dialog in Things, which cannot " +
  "appear on the screen you're viewing.";
const OTHER_SPACE_REMEDIATION =
  "Switch to the desktop showing Things (or move its window to the current desktop), then run this " +
  "again.";
const NO_WINDOW_DETAIL =
  "Things has no open window. This operation opens a dialog in Things, which has nowhere to appear.";
const NO_WINDOW_REMEDIATION =
  "Open a Things window (click Things so a list is showing), then run this again.";

/**
 * Turn raw counts (or a probe error, `null`) into a verdict. Fail-OPEN on an
 * unreadable probe: the gate is an early guard, not the sole line of defense.
 */
export function interpretReachability(counts: ReachabilityCounts | null): ReachabilityVerdict {
  // Probe error, or the AX count itself could not be read (Accessibility not
  // granted / System Events hiccup) — do not block; the drive's own canary and
  // dialog-wait remain fail-closed downstream.
  if (counts === null || counts.thingsAx < 0) return { reachable: true };
  if (counts.thingsAx >= 1) return { reachable: true };
  // thingsAx === 0: no Things window is AX-visible on the current Space.
  if (counts.allAx === 0) {
    // Every foreground app reports zero windows -> the whole session is AX-blind
    // (locked screen or a full-screen Space hiding all windows).
    return {
      reachable: false,
      scope: "session",
      detail: SESSION_DETAIL,
      remediation: SESSION_REMEDIATION,
    };
  }
  // Other apps DO have windows, so the session is not locked — only Things'
  // window is unreachable: it is on another Space (thingsAs >= 1) or absent.
  if (counts.thingsAs >= 1) {
    return {
      reachable: false,
      scope: "window",
      detail: OTHER_SPACE_DETAIL,
      remediation: OTHER_SPACE_REMEDIATION,
    };
  }
  return {
    reachable: false,
    scope: "window",
    detail: NO_WINDOW_DETAIL,
    remediation: NO_WINDOW_REMEDIATION,
  };
}

/** Run the probe through the injected runner and interpret it (fail-open on transport error). */
export async function probeSessionReachability(
  run: (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>,
  timeoutMs: number,
): Promise<ReachabilityVerdict> {
  const res = await run(
    {
      primitive: "resolve",
      label: "session-reachability probe",
      script: axSessionReachabilityScript(),
    },
    timeoutMs,
  );
  if (!res.ok) return { reachable: true }; // fail-open: a probe transport error never blocks
  return interpretReachability(parseReachabilityCounts(res.stdout));
}
