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
${SESSION_LOCK_JXA_BODY}
JSON.stringify(sessionLock())`;
}

/**
 * The body every session-reading script shares: `sessionLock()` returns the
 * payload {@link interpretSessionLock} parses, and `blocksDrive()` is the same
 * decision {@link blocksGuiDrive} takes in TypeScript — in-script, so a script
 * that must ACT on the verdict (activate, or nudge the saver) does not need a
 * round trip to be told what it just read.
 */
const SESSION_LOCK_JXA_BODY = `ObjC.import('CoreGraphics');
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
function sessionLock(){
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
  return out }
function blocksDrive(o){ return o.screenIsLocked === true || o.screenSaver === true }`;

/**
 * THE ZERO-HOP GATE (LOCKSCR2). The lock question used to cost its own osascript
 * spawn — 221–289 ms of it, measured (LOCKSCR1 §2), essentially all transport:
 * the dictionary read itself is microseconds. That spawn stood in front of every
 * GUI-driven workflow, paid on the HAPPY path, to answer a question whose answer
 * is almost always "unlocked".
 *
 * So it is not a hop any more. Every recipe this gate applies to runs an
 * `activate` step in its preamble — the first SCRIPT the drive executes — and
 * this is that step with the session read folded in ahead of it. The answer
 * comes back on the stdout the activate was going to produce anyway, and the
 * happy path pays microseconds inside a spawn it was already paying for.
 *
 * THE ACTIVATE IS UNCONDITIONAL, deliberately. Foregrounding Things behind a
 * lock screen is a no-op that changes no data and posts no input, while making
 * it conditional would silently change what an UNGATED recipe does on a locked
 * Mac. The gate decision stays in TypeScript, where it can see whether this
 * recipe asked for it.
 */
export function jxaActivateWithSessionLockScript(): string {
  return `/* ${SESSION_LOCK_MARKER} */
${SESSION_LOCK_JXA_BODY}
var lock = sessionLock();
Application('Things3').activate();
JSON.stringify({ lock: lock, activated: true })`;
}

/** How long the saver nudge waits for the window server to drop the lock key. */
const SAVER_WAKE_BUDGET_MS = 4000;

/**
 * NUDGE THE SCREEN SAVER (LOCKSCR2 — the maintainer's second question: "do we
 * have any way to wake up a screensaver that doesn't have a password protected
 * unlock enabled without requiring direct user input?").
 *
 * The answer is yes, and the mechanism is narrower than it looks. MEASURED on
 * macOS 15.7.7 against a bare `open -a ScreenSaverEngine`
 * (docs/lab/lockscr2-session-normalization.md §1):
 *
 *  - IOKit's `IOPMAssertionDeclareUserActivity` returns `kIOReturnSuccess` and
 *    changes nothing — the saver stays up, the session stays locked;
 *  - `caffeinate -u` (the same API through the shipped tool) likewise;
 *  - a synthesized `CGEventMouseMoved` DOES reach the input path — the pointer
 *    teleports while the saver is up, which is how we know synthetic input is
 *    not being swallowed — and still does not dismiss the saver;
 *  - killing `ScreenSaverEngine` removes the process and leaves
 *    `CGSSessionScreenIsLocked` set for the rest of that login;
 *  - a synthesized KEY event dismisses it. One left-Shift down/up pair clears
 *    `CGSSessionScreenIsLocked`, `CGSSessionScreenLockedTime` and
 *    `kCGSSessionSecureInputPID` together, and Things is AX-readable again.
 *
 * WHY SHIFT. It is the safest key there is: a lone modifier press types nothing,
 * presses nothing and cancels nothing, so it is inert in the one case that
 * matters — the saver having gone between the read and the post. (Escape works
 * too and is not used: it would cancel a dialog if it ever landed on a desktop.)
 *
 * AND IT CANNOT DEFEAT A PASSWORD. With "require password immediately" on, the
 * same Shift — and an Escape after it — leaves the saver running and the session
 * locked, with nothing else changed. No reading tells the two apart in advance:
 * `kCGSSessionSecureInputPID` is present under BOTH (it discriminates a saver
 * from a hard lock, which is what LOCKSCR1 measured; it does not discriminate a
 * password gate). So the nudge is CLOSED-LOOP by necessity rather than taste:
 * post once, re-read the session, and believe only the re-read.
 *
 * THE LOOP WATCHES THE DICTIONARY, NOT THE PROCESS LIST, and that distinction
 * cost a certification run to find (LOCKSCR2 §2, cell c). `NSWorkspace`'s
 * `runningApplications` is a KVO-backed CACHE that refreshes when the process
 * returns to its run loop — which an osascript that sits in a polling loop never
 * does. So `screenSaverRunning()` answers `true` for the whole life of THIS
 * script no matter what happens on screen, and a loop that waited for it to go
 * false waited out its entire budget while the saver was already gone. The
 * session dictionary has no such problem: `CGSessionCopyCurrentDictionary` is a
 * fresh window-server read every call. It is also the authoritative signal —
 * macOS keeps `CGSSessionScreenIsLocked` set for exactly as long as the saver
 * covers the screen (measured in every state of every LOCKSCR2 round) — so once
 * it clears, the stale `screenSaver` bit is corrected rather than believed.
 */
export function jxaWakeScreenSaverScript(budgetMs: number = SAVER_WAKE_BUDGET_MS): string {
  return `/* ${SESSION_LOCK_MARKER} wake */
${SESSION_LOCK_JXA_BODY}
function tapShift(){
  try {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateKeyboardEvent($(), 56, true));
    $.NSThread.sleepForTimeInterval(0.05);
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateKeyboardEvent($(), 56, false));
    return true } catch(e){ return false } }
var before = sessionLock();
var posted = false;
if (before.screenSaver === true){
  posted = tapShift();
  var deadline = Date.now() + ${Math.max(0, Math.trunc(budgetMs))};
  while (Date.now() < deadline){
    $.NSThread.sleepForTimeInterval(0.2);
    if (sessionLock().screenIsLocked !== true) break }
}
var after = sessionLock();
if (posted && after.screenIsLocked !== true) after.screenSaver = false;
var activated = false;
if (!blocksDrive(after)) { Application('Things3').activate(); activated = true }
JSON.stringify({ lock: after, activated: activated, posted: posted })`;
}

/** What a fused script (the activate, or the saver nudge) hands back. */
export interface FusedSessionLock {
  lock: SessionLockVerdict;
  /** Things was foregrounded by this hop. */
  activated: boolean;
  /** The saver nudge posted its key (the wake script only). */
  posted: boolean;
}

/**
 * Read a fused script's JSON. A shape this cannot read degrades to `unknown` —
 * never to `unlocked` — for the same reason {@link probeSessionLock} does: a
 * confident wrong answer is the whole defect.
 */
export function interpretFusedSessionLock(raw: string): FusedSessionLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { lock: UNKNOWN_SESSION_LOCK, activated: false, posted: false };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { lock: UNKNOWN_SESSION_LOCK, activated: false, posted: false };
  }
  const rec = parsed as Record<string, unknown>;
  const lock =
    rec["lock"] === undefined
      ? UNKNOWN_SESSION_LOCK
      : interpretSessionLock(JSON.stringify(rec["lock"]));
  return { lock, activated: rec["activated"] === true, posted: rec["posted"] === true };
}

/**
 * Read the probe's JSON into a verdict. The classification, in order:
 *
 *  1. no session dictionary at all              -> `unknown` (state the uncertainty);
 *  2. `ScreenSaverEngine` is running            -> `screensaver`;
 *  3. `CGSSessionScreenIsLocked` true           -> `locked`;
 *  4. otherwise                                 -> `unlocked`.
 *
 * THE SAVER OUTRANKS THE LOCK KEY, and that ordering is the LOCKSCR2 change. The
 * window server sets `CGSSessionScreenIsLocked` for a bare screen saver as
 * readily as for a real lock (LOCKSCR1 §1 law 2), so the two used to arrive as
 * one verdict and one refusal — "unlock the Mac" — which told a user whose Mac
 * was not asking for anything to do the wrong thing. They are separated here on
 * the one signal that does separate them, `ScreenSaverEngine` being up, and the
 * saver earns its own rung because it has its OWN ANSWER: it can be nudged awake
 * ({@link jxaWakeScreenSaverScript}), and only when the nudge fails is the Mac
 * actually asking for a password.
 *
 * Both verdicts still BLOCK a drive ({@link blocksGuiDrive}); what differs is
 * what happens next, not whether it is safe to proceed. The fail direction of
 * every guard in this vector is refuse-and-name (PTRGD1).
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
      : screenSaver === true
        ? "screensaver"
        : screenIsLocked === true
          ? "locked"
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

/**
 * `reopen` + `activate`, through Things' OWN scripting dictionary (LOCKSCR2).
 *
 * The same two commands the SESSGATE rescue maneuver leans on
 * (`axCloseReopenActivateScript` in ui.ts) — minus its `close window 1`, which
 * exists there to take a stuck sheet down with the window and would be exactly
 * wrong here, where the problem is that there is no window to close.
 *
 * It is app-level AppleScript, not Accessibility, so it works in the state that
 * needs it: `reopen` restores the default window on the CURRENT Space whether or
 * not the AX tree can see anything, and `activate` brings it forward.
 *
 * It lives beside the session verdict because that verdict is its ONLY licence:
 * an empty window inventory means "closed window" only once the session is
 * PROVEN unlocked, and reopening on an `unknown` session would be acting on a
 * guess — the mistake #732 was. Both callers (the sidebar drive's normalization
 * rung and the promote composites' pre-seed preflight) apply that guard.
 */
export function axReopenActivateScript(): string {
  return `tell application "Things3"
  reopen
  activate
end tell
return "OK"`;
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
  "Refused to drive the Things window: the screen saver is up, so no window can be read or " +
  "clicked.";
const SAVER_REMEDIATION = "Wake the Mac (unlock it if it asks) and re-run.";
/**
 * The saver sentence AFTER the nudge failed. It is a different fact and gets a
 * different sentence: the saver was asked to clear, it did not, and the only
 * thing measured to keep it up is a Mac that wants a password (LOCKSCR2 §1).
 */
const SAVER_STUCK_CLAUSE =
  "Refused to drive the Things window: the screen saver is up and did not clear when the Mac was " +
  "nudged, so the Mac is asking for a password.";
const SAVER_STUCK_REMEDIATION = "Unlock the Mac and re-run.";

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
  /**
   * Was the saver nudge tried on this path? Only the in-drive gate has a wake
   * rung; a pre-seed gate that merely ASKED must not claim the Mac was nudged.
   */
  wakeAttempted = false,
): Extract<ReachabilityVerdict, { reachable: false }> {
  if (verdict.state !== "screensaver") {
    return {
      reachable: false,
      scope: "session",
      detail: `${LOCKED_CLAUSE} ${tail}`,
      remediation: LOCKED_REMEDIATION,
    };
  }
  return wakeAttempted
    ? {
        reachable: false,
        scope: "session",
        detail: `${SAVER_STUCK_CLAUSE} ${tail}`,
        remediation: SAVER_STUCK_REMEDIATION,
      }
    : {
        reachable: false,
        scope: "session",
        detail: `${SAVER_CLAUSE} ${tail}`,
        remediation: SAVER_REMEDIATION,
      };
}

/**
 * The note a SUCCESSFUL wake owes the caller. The saver was up, we dismissed it,
 * and the screen is now awake and will stay that way — a durable change to the
 * state the user left the Mac in, which is exactly the disclosure bar.
 */
export const SAVER_DISMISSED_NOTE =
  "the screen saver was up and was dismissed to run this — the Mac did not ask for a password, " +
  "and the screen is awake now";

/**
 * Run the saver nudge through the injected runner. CLOSED-LOOP by construction:
 * the verdict returned is a RE-READ of the session dictionary taken after the
 * key was posted, never an assumption that posting it worked. A transport
 * failure leaves the caller with the verdict it already had.
 */
export async function wakeScreenSaver(
  run: (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>,
  timeoutMs: number,
  before: SessionLockVerdict,
): Promise<FusedSessionLock> {
  const res = await run(
    {
      primitive: "resolve",
      label: "nudge the screen saver",
      script: jxaWakeScreenSaverScript(),
      lang: "javascript",
    },
    timeoutMs,
  );
  if (!res.ok) return { lock: before, activated: false, posted: false };
  return interpretFusedSessionLock(res.stdout);
}

/** The one-line render for `things doctor --ui-state`. */
export function describeSessionLock(verdict: SessionLockVerdict): string {
  switch (verdict.state) {
    case "locked":
      return "locked — the screen is locked, so nothing on it can be read or clicked";
    case "screensaver":
      return "screen saver — the saver is covering the display; a drive nudges it awake first";
    case "unlocked":
      return "unlocked";
    case "unknown":
      return "unknown — this session did not answer, so a missing window cannot be told from a locked screen";
  }
}
