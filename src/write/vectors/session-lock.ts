/**
 * LOCKSCR1 — IS THE SCREEN LOCKED? (issue #732)
 *
 * The field report this module answers: on a LOCKED Mac, `area reorder
 * --dangerously-drive-gui` refused twice, 5.6 s each, with
 *
 *   "Things is running but has no open window — only the placeholder it keeps
 *    in the background. Open the Things window (click its Dock icon) and re-run."
 *
 * Every word of that was inference from a window inventory taken through a
 * window server that shows an AX-blind session ZERO windows (SESSGATE, #480).
 * The evidence established a locked screen; the sentence asserted a closed
 * window and sent the operator to click a Dock icon they could not see.
 *
 * THE ORDER IS THE FIX. Ask the session whether it is locked BEFORE inferring
 * anything from what the window inventory does or does not contain, and:
 *
 *  - LOCKED (or the screen saver is up): refuse before the first gesture, in the
 *    pre-gesture refusal family — `blocked`, exit 4, zero mutation. Not a
 *    verify failure: nothing was posted, so nothing can have silently no-opped.
 *  - UNKNOWN (the session dictionary did not resolve): the window-inventory
 *    sentence must state the uncertainty rather than assert a closed window
 *    (see `describeSnapshotFailure` in ui-drag.ts).
 *  - UNLOCKED: every existing path is unchanged.
 *
 * PROMPT-FREE (permissions doctrine, Article I). `CGSessionCopyCurrentDictionary`
 * is a CoreGraphics read of the caller's own login session and
 * `NSWorkspace.runningApplications` is an in-process list — neither is TCC-gated,
 * neither targets another application, and neither can raise a consent dialog.
 * The probe therefore runs on machines that have granted nothing, which is the
 * point: the answer it gives is what stops the AX-gated reads from being
 * misread.
 *
 * COST: one osascript hop, no Apple events, no AX round-trips (`axOps` 0).
 *
 * WHAT THE DICTIONARY ACTUALLY SAYS (LOCKSCR1 §2, measured on macOS 15.7.7):
 *
 * | screen state | `CGSSessionScreenIsLocked` | `CGSSessionScreenLockedTime` |
 * |---|---|---|
 * | unlocked | **absent** | absent |
 * | screen saver, no password gate | **true** | present |
 * | locked (`sysadminctl -screenLock` + `SACLockScreenImmediate`) | **true** | present |
 *
 * Two laws follow, and both are load-bearing here. First, ABSENCE IS THE
 * UNLOCKED READING — the key is added when the screen locks and dropped when it
 * unlocks, so `screenIsLocked: null` beside a dictionary that DID resolve is
 * evidence, not a gap. Second, the window server counts a bare screen saver as
 * locked whether or not a password is required, so the saver takes the lock
 * refusal and the distinct `screensaver` verdict below is only a fallback for a
 * session that reports no lock while the saver process is up.
 *
 * AND IT ANSWERS AN `ssh` LOGIN TOO. The probe was built expecting a process
 * with no window-server session of its own to get nothing back; measured, an
 * ssh-launched read returns the CONSOLE session's dictionary, byte-identical to
 * one taken inside the Aqua session, in every screen state (LOCKSCR1 cell P).
 * So `unknown` is a genuinely rare reading — but it is still the one this module
 * refuses to guess past, because the whole defect was a confident wrong answer.
 */
import type { HazardId } from "../guards.ts";
import { H_UI_SESSION_UNREACHABLE, type ReachabilityVerdict } from "./session-reachability.ts";
import type { UiCommand, UiRunResult } from "./ui.ts";

/** What the session said about itself. */
export type SessionLockState = "locked" | "screensaver" | "unlocked" | "unknown";

export interface SessionLockVerdict {
  state: SessionLockState;
  /** Every key the session dictionary carried, sorted — the evidence, for the trace. */
  keys: string[];
  /** `CGSSessionScreenIsLocked`; null when the key was absent or the dictionary did not resolve. */
  screenIsLocked: boolean | null;
  /** `kCGSSessionOnConsoleKey`; null when absent. */
  onConsole: boolean | null;
  /** Is `ScreenSaverEngine` running? null when the application list could not be read. */
  screenSaver: boolean | null;
  /** Where the verdict came from: the session dictionary, or nothing at all. */
  source: "session-dictionary" | "unavailable";
}

/** The verdict a probe that could not run at all produces. */
export const UNKNOWN_SESSION_LOCK: SessionLockVerdict = {
  state: "unknown",
  keys: [],
  screenIsLocked: null,
  onConsole: null,
  screenSaver: null,
  source: "unavailable",
};

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** A recognizable token in the probe script, so a test runner can key off it. */
export const SESSION_LOCK_MARKER = "lockscr1-session-lock probe";

/** The screen saver's bundle identifiers, oldest spelling last. */
const SCREEN_SAVER_BUNDLES = ["com.apple.ScreenSaver.Engine", "com.apple.screensaver.engine"];

/**
 * ONE STABLE JXA SHAPE returning the session's own account of itself as JSON.
 *
 * Every leg is individually wrapped: a bridge that does not answer degrades the
 * verdict to `unknown` (which has its own honest sentence) rather than failing
 * the hop and taking the drive with it.
 *
 * The three unwrap attempts are deliberate. `CGSessionCopyCurrentDictionary`
 * hands back a `CFDictionaryRef`, and which of the bridge's unwrappers accepts
 * it is a property of the macOS build, not of this code — measured working on
 * macOS 15 through `ObjC.deepUnwrap(ObjC.castRefToObject(d))`, with the other two
 * kept because a version that prefers them must not read as "no session".
 */
export function jxaSessionLockScript(): string {
  return `/* ${SESSION_LOCK_MARKER} */
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function lockDict(){
  var d = null;
  try { d = $.CGSessionCopyCurrentDictionary() } catch(e){ return null }
  if (!d) return null;
  var tries = [
    function(){ return ObjC.deepUnwrap(ObjC.castRefToObject(d)) },
    function(){ return ObjC.deepUnwrap(d) },
    function(){ return d.js }
  ];
  for (var i = 0; i < tries.length; i++){
    try { var v = tries[i](); if (v && typeof v === 'object' && !(v instanceof Array)) return v }
    catch(e){ /* try the next unwrapper */ }
  }
  return null }
function screenSaverRunning(){
  var want = ${JSON.stringify(SCREEN_SAVER_BUNDLES)};
  try {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications, n = Number(apps.count);
    for (var i = 0; i < n; i++){
      var b = null;
      try { b = ObjC.unwrap(apps.objectAtIndex(i).bundleIdentifier) } catch(e){ b = null }
      if (typeof b !== 'string') continue;
      for (var k = 0; k < want.length; k++) if (b.toLowerCase() === want[k].toLowerCase()) return true }
    return false;
  } catch(e){ return null } }
var out = { keys: [], screenIsLocked: null, onConsole: null, screenSaver: screenSaverRunning(),
            source: 'unavailable' };
var dict = lockDict();
if (dict !== null){
  out.source = 'session-dictionary';
  for (var k in dict) if (Object.prototype.hasOwnProperty.call(dict, k)) out.keys.push(k);
  out.keys.sort();
  if (out.keys.indexOf('CGSSessionScreenIsLocked') >= 0) out.screenIsLocked = !!dict['CGSSessionScreenIsLocked'];
  if (out.keys.indexOf('kCGSSessionOnConsoleKey') >= 0) out.onConsole = !!dict['kCGSSessionOnConsoleKey'];
}
JSON.stringify(out)`;
}

/**
 * Read the probe's JSON into a verdict. The classification, in order:
 *
 *  1. no session dictionary at all              -> `unknown` (state the uncertainty);
 *  2. `CGSSessionScreenIsLocked` true           -> `locked`;
 *  3. the screen saver is running               -> `screensaver`;
 *  4. otherwise                                 -> `unlocked`.
 *
 * Rung 3 is deliberate over-caution and it costs a re-run at worst: a screen
 * saver covers the display, so the first synthesized click dismisses the saver
 * instead of reaching Things, and on a Mac with "require password immediately"
 * the very next state is a locked one. The fail direction of every guard in this
 * vector is refuse-and-name (PTRGD1).
 *
 * Note that the ABSENCE of `CGSSessionScreenIsLocked` is the ordinary unlocked
 * reading: macOS adds the key when the screen locks and drops it when it
 * unlocks. So `screenIsLocked: null` with a dictionary present is not missing
 * evidence — it is the evidence.
 */
export function interpretSessionLock(raw: string): SessionLockVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return UNKNOWN_SESSION_LOCK;
  }
  if (parsed === null || typeof parsed !== "object") return UNKNOWN_SESSION_LOCK;
  const rec = parsed as Record<string, unknown>;
  const keys = Array.isArray(rec["keys"]) ? rec["keys"].filter((k) => typeof k === "string") : [];
  const screenIsLocked = bool(rec["screenIsLocked"]);
  const onConsole = bool(rec["onConsole"]);
  const screenSaver = bool(rec["screenSaver"]);
  const source = rec["source"] === "session-dictionary" ? "session-dictionary" : "unavailable";
  const state: SessionLockState =
    source === "unavailable"
      ? "unknown"
      : screenIsLocked === true
        ? "locked"
        : screenSaver === true
          ? "screensaver"
          : "unlocked";
  return { state, keys, screenIsLocked, onConsole, screenSaver, source };
}

/**
 * Run the probe through the injected runner. A transport failure is `unknown`,
 * never `unlocked`: this gate exists because a confident wrong answer is what
 * #732 shipped, so an unread session says so and the downstream copy hedges.
 */
export async function probeSessionLock(
  run: (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>,
  timeoutMs: number,
): Promise<SessionLockVerdict> {
  const res = await run(
    {
      primitive: "resolve",
      label: "session-lock probe",
      script: jxaSessionLockScript(),
      lang: "javascript",
    },
    timeoutMs,
  );
  if (!res.ok) return UNKNOWN_SESSION_LOCK;
  return interpretSessionLock(res.stdout);
}

/** Does this verdict forbid driving the GUI at all? */
export function blocksGuiDrive(verdict: SessionLockVerdict): boolean {
  return verdict.state === "locked" || verdict.state === "screensaver";
}

/**
 * The refusal, minus its tail. Both callers say the same thing about the screen
 * and differ only in what they promise was NOT done — the drive changed nothing,
 * the composite created nothing — so the clause is single-sourced and the tail
 * is the caller's.
 */
const LOCKED_CLAUSE =
  "Refused to drive the Things window: the screen is locked, so no window can be read or clicked.";
const LOCKED_REMEDIATION = "Unlock the Mac and re-run.";
const SAVER_CLAUSE =
  "Refused to drive the Things window: the screen saver is running, so a click would dismiss it " +
  "rather than reach Things.";
const SAVER_REMEDIATION = "Wake the Mac (unlock it if it asks) and re-run.";

/** The hazard a locked session is reported under — the same one SESSGATE uses. */
export const H_UI_SESSION_LOCKED: HazardId = H_UI_SESSION_UNREACHABLE;

/**
 * The refusal, in the shape the ui vector already blocks with (SESSGATE's
 * `blockedReachability`): `blocked`, exit 4, hazard H-UI-SESSION-UNREACHABLE,
 * zero mutation. A locked session IS an unreachable session — what changes here
 * is that we now KNOW that is why, and say so instead of guessing at the window.
 */
export function lockRefusal(
  verdict: SessionLockVerdict,
  /** What the caller can promise did not happen. The drive changed nothing; a
   * composite's pre-seed gate created nothing. */
  tail = "Nothing was changed.",
): Extract<ReachabilityVerdict, { reachable: false }> {
  return verdict.state === "screensaver"
    ? {
        reachable: false,
        scope: "session",
        detail: `${SAVER_CLAUSE} ${tail}`,
        remediation: SAVER_REMEDIATION,
      }
    : {
        reachable: false,
        scope: "session",
        detail: `${LOCKED_CLAUSE} ${tail}`,
        remediation: LOCKED_REMEDIATION,
      };
}

/** The one-line render for `things doctor --ui-state`. */
export function describeSessionLock(verdict: SessionLockVerdict): string {
  switch (verdict.state) {
    case "locked":
      return "locked — the screen is locked, so nothing on it can be read or clicked";
    case "screensaver":
      return "screen saver — the saver is covering the display; a click would dismiss it";
    case "unlocked":
      return "unlocked";
    case "unknown":
      return "unknown — this session did not answer, so a missing window cannot be told from a locked screen";
  }
}
