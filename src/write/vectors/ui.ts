/**
 * The Accessibility GUI ("ui") vector — the FOURTH write vector, for the
 * GUI-only transforms that have no headless spelling (make/reschedule/pause/
 * resume/stop a repeat, convert a to-do or heading to a project). It drives
 * the LOCAL Things app through the Accessibility API (the AXUIElement tree via
 * `osascript` + System Events), addressing SEMANTIC elements (`menu item
 * "Pause" …`, `button "Convert" of sheet 1 …`) — NEVER coordinates, never
 * screenshots. That semantic addressing is what makes it fail-closed:
 *
 *  - Recipe canary preflight: before ANY press, every statically-reachable
 *    element the recipe will touch is resolved; a single miss refuses the
 *    whole drive, naming the element (a Things update moved/renamed the menu,
 *    Accessibility is not granted, the app is not running, or the app is not
 *    in English). Nothing is pressed on a partial resolution.
 *  - Wait-for-element with timeout for async UI (sheets/popovers): the driver
 *    polls for the expected element and, on timeout, aborts (Escape) and
 *    reports partial state honestly — which steps ran, which did not.
 *
 * Two-key gated: the `ui.enabled` config (below — an unset config makes the
 * matrix report the op unsupported) AND a per-call `dangerouslyDriveGui`
 * acknowledgement (H-UI-DRIVE, enforced by the pipeline's guards). Every op
 * ships UNCERTIFIED (ui-certification.ts): the element paths are derived from
 * the known menu structure but not yet exercised on real hardware.
 *
 * A vendored native AXUIElement client is an explicitly-deferred follow-up;
 * v1 shells out to `osascript` with ONE stable command shape per primitive.
 */
import { execFile } from "node:child_process";

import type { ThingsApiConfig } from "../../config.ts";
import { UI_DRIVE_OPS } from "../operations.ts";
import { escapeAppleScript } from "./applescript.ts";
import { certificationOf } from "./ui-certification.ts";
import { driveSidebarAreaReorder, jxaSidebarSnapshotScript, type UiDriveAux } from "./ui-drag.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  UiPrimitive,
  UiRecipe,
  UiStep,
  VectorMatrix,
  WriteVector,
} from "./types.ts";

/** GUI driving can stall on an unanswered sheet; give each step headroom. */
const STEP_TIMEOUT_MS = 15_000;
/** Poll interval while waiting for a dynamic element (sheet/popover). */
const WAIT_POLL_MS = 300;
/**
 * How long `resolveStepPath` polls a candidate-addressed control before failing
 * closed. The full-vocabulary dialog reveals a pop-up/field a beat AFTER the
 * frequency/Ends switch that precedes it (UIC6: ~250 ms), so the effective-form
 * resolution must poll, not snap once.
 */
const RESOLVE_CANDIDATE_TIMEOUT_MS = 5_000;
/**
 * Settle after the reveal/activate preamble so the menu bar repopulates for the
 * newly-selected target before the canary reads it (UIC1: the Items ▸ Repeat
 * submenu appears only once a repeating item is selected, and the update is not
 * instantaneous).
 */
const SETTLE_AFTER_REVEAL_MS = 1500;

/**
 * Command-level primitives. Extends the recipe `UiPrimitive` set with the
 * INTERNAL sub-steps composite recipe steps decompose into: a `click-element`
 * step becomes read-the-frame (`resolve-frame`) + click-at-center
 * (`click-point`); a `drag-reorder` step becomes snapshot/scroll/drag cycles
 * (`sidebar-snapshot`, `sidebar-scroll`, `sidebar-drag` — ui-drag.ts). Keeping
 * every subprocess call behind the injectable `run` seam makes the
 * orchestration unit-testable without a GUI.
 */
export type UiCommandPrimitive =
  | UiPrimitive
  | "resolve-frame"
  | "click-point"
  | "sidebar-snapshot"
  | "sidebar-scroll"
  | "sidebar-drag"
  | "sidebar-held-drag";

/** A single primitive dispatch — one stable shape per primitive. */
export interface UiCommand {
  primitive: UiCommandPrimitive;
  label: string;
  /** osascript source (AX primitives); absent for reveal. */
  script?: string;
  /** reveal only: the things:/// URL opened to select the target. */
  url?: string;
  /** `script` language for the osascript hop; defaults to AppleScript. */
  lang?: "applescript" | "javascript";
  /** Structured command parameters (test-inspectable; never dispatched). */
  meta?: Record<string, unknown>;
}

export interface UiRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * Low-level dispatch seam. Injectable so the driver's recipe orchestration,
 * canary, and abort logic are unit-testable WITHOUT ever touching a real GUI
 * (CLAUDE.md safety rails — the production app is never a valid target).
 */
export type UiRunner = (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>;

const SE = `tell application "System Events" to tell process "Things3"`;

/** resolve-element: does the element exist right now? Returns "true"/"false". */
export function axResolveScript(path: string): string {
  return `${SE} to return (exists (${path}))`;
}
/** press: AXPress the element. */
export function axPressScript(path: string): string {
  return `${SE} to click (${path})`;
}
/**
 * set-field-value: enter a value into the dialog's numeric text field (interval,
 * ends-count, start-days-earlier). It FOCUSES the field, selects all, TYPES the
 * value, and Tabs to commit — because `set value of <field>` writes the field's
 * displayed text WITHOUT firing the edit, so the app's binding keeps the old
 * number (the field shows "5" but the rule stays interval 1 — a silent no-op
 * exactly like `set value` on a pop-up, UIC6; it went unnoticed while every base
 * case used the default interval 1). Real keystrokes fire the change the binding
 * needs; Tab (not Return, which would fire the default OK button) commits and
 * moves focus. Foreground-bound (keystrokes reach the frontmost app) — the
 * reveal/activate preamble puts Things there. One stable command shape.
 */
export function axSetValueScript(path: string, value: string): string {
  return `${SE}
  set tf to (${path})
  set focused of tf to true
  delay 0.15
  keystroke "a" using command down
  delay 0.1
  keystroke "${escapeAppleScript(value)}"
  delay 0.1
  key code 48
  delay 0.2
end tell`;
}
/**
 * select-popup: choose an item in a pop-up button by NAME. Setting `value` on a
 * Things pop-up button is a silent no-op (UIC1 / UI2-i) — the control must be
 * opened and the menu item clicked. The open-click is POLLED until the menu
 * actually renders: in the full-vocabulary dialog a preceding pop-up's menu is
 * still animating closed when the next select fires, and that first open-click
 * is ABSORBED (the pop-up stays closed, so `menu 1` is an invalid index and the
 * item click errors -1719, UIC6). Re-clicking only while the menu is absent
 * (never once it is open) opens it reliably without toggling it back shut. One
 * stable command shape per primitive.
 */
export function axSelectPopupScript(path: string, value: string): string {
  return `${SE}
  set pu to (${path})
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  click menu item "${escapeAppleScript(value)}" of menu 1 of pu
end tell`;
}
/**
 * select-row: select a PROJECT row by title, purely via AX (UIC4-a). Walks the
 * content table's rows, issues the row `select` action on each (which REPLACES
 * the table selection — single-select, UIC5), and reads back Things' `name of
 * selected to dos`; the first row whose readback equals the target title is LEFT
 * selected and the script returns "OK". Non-selectable rows (the area/Someday
 * header, the blank spacer) select nothing (readback count 0) and are skipped.
 * Returns "NOMATCH" if no row selects to the title — the readback is the
 * selection-landed verification, so a match guarantees the intended row is
 * selected. One stable command shape per primitive.
 *
 * UIC5 correction: the shipped form set the TABLE's `AXSelectedRows` attribute
 * to a one-row list, which is a SILENT NO-OP on Things' content table via System
 * Events (no error, selection never lands). The row `select` action is the
 * working pure-System-Events route and stays background-capable with no focus
 * steal (UIC5-e). (UIC4-a proved settability with the ObjC-bridge NSArray set —
 * a different API than the System Events attribute set the driver shells out to.)
 */
export function axSelectRowScript(tablePath: string, title: string): string {
  const t = escapeAppleScript(title);
  return `tell application "System Events" to tell process "Things3"
  set theTable to (${tablePath})
  set n to (count rows of theTable)
  repeat with i from 1 to n
    try
      select (row i of theTable)
      tell application "Things3" to set selNames to (name of selected to dos)
      if (count of selNames) is 1 and ((item 1 of selNames) as text) is "${t}" then
        return "OK"
      end if
    end try
  end repeat
end tell
return "NOMATCH"`;
}

/** activate: foreground Things (the fallback preamble step). */
export function axActivateScript(): string {
  return `tell application "Things3" to activate`;
}
/** key: a space-separated keystroke spec (e.g. "down down return"). */
export function axKeyScript(keys: string): string {
  const KEY_CODES: Record<string, number> = { return: 36, escape: 53, down: 125, up: 126, tab: 48 };
  const lines = keys
    .split(/\s+/)
    .filter((k) => k !== "")
    .map((k) =>
      KEY_CODES[k] !== undefined
        ? `key code ${KEY_CODES[k]}`
        : `keystroke "${escapeAppleScript(k)}"`,
    );
  return `tell application "System Events" to tell process "Things3"\n  ${lines.join("\n  ")}\nend tell`;
}
/** The abort keystroke sent to dismiss a half-open sheet/popover on failure. */
export function axAbortScript(): string {
  return `tell application "System Events" to key code 53`; // Escape
}

/**
 * resolve-frame: read the element's on-screen frame (top-left origin, points)
 * from the live AX tree and print "x y w h". Used by `click-element` to target
 * the frame CENTER — the position comes from AX (`position`/`size`), never a
 * guessed pixel, so a missing element errors (fail-closed) instead of clicking
 * a stale coordinate. Points map 1:1 to CGEvent coordinates (NATIVE1-b).
 */
export function axFrameScript(path: string): string {
  return `${SE}
  set _p to position of (${path})
  set _s to size of (${path})
  return ((item 1 of _p) as text) & " " & ((item 2 of _p) as text) & " " & ((item 1 of _s) as text) & " " & ((item 2 of _s) as text)
end tell`;
}

/**
 * click-point: synthesize a single left mouse click at (x, y) via the global
 * HID event tap (the NATIVE1 JXA ObjC-bridge path — `CGEventPostToPid` is inert
 * for Things' hit-testing; only `CGEventPost(kCGHIDEventTap)` lands). The HID
 * tap posts to the FOREGROUND surface, so the recipe must have activated Things
 * first. Event types are the stable CGEventType values (5 = mouse-moved,
 * 1 = left-down, 2 = left-up).
 */
export function jxaClickScript(x: number, y: number): string {
  const xi = Math.round(x);
  const yi = Math.round(y);
  return `ObjC.import('Foundation');
ObjC.import('CoreGraphics');
function sleep(ms){ $.NSThread.sleepForTimeInterval(ms/1000); }
function mev(t){ return $.CGEventCreateMouseEvent($(), t, $.CGPointMake(${xi}, ${yi}), 0); }
$.CGEventPost($.kCGHIDEventTap, mev(5)); sleep(20);
$.CGEventPost($.kCGHIDEventTap, mev(1)); sleep(15);
$.CGEventPost($.kCGHIDEventTap, mev(2));`;
}

/** The command that posts an AX-resolved mouse click (one stable JXA shape). */
function clickPointCommand(x: number, y: number, label: string): UiCommand {
  return { primitive: "click-point", label, lang: "javascript", script: jxaClickScript(x, y) };
}

/**
 * set-datetime: set the Repeat dialog's `AXDateTimeArea` (reminder time / "ends
 * on date" bound) via the ObjC AX bridge. Things' date/time control holds an
 * NSDate, and System Events cannot write it (`set value … to <date>` → -10000,
 * UIC6), so — like the mouse-synthesis primitive — this runs in JXA and calls
 * `AXUIElementSetAttributeValue(…, AXValue, <NSDate>)` directly. The control is
 * found by ROLE within Things' front dialog (there is exactly one during a
 * reminder/end-date step; the matrix never sets both at once), polled briefly
 * so it is caught right after the checkbox/pop-up that reveals it, and the
 * script THROWS when absent so the driver fails closed. `spec` is
 * `time:HH:mm` (keep the control's date, overwrite the time-of-day) or
 * `date:YYYY-MM-DD` (overwrite the date at midnight). One stable JXA shape.
 */
export function axSetDateTimeScript(spec: string): string {
  return `ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function rolestr(el){ var v=attr(el,'AXRole'); return v? v.js : ''; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function find(el,role,depth){ if(depth<0) return null; if(rolestr(el)===role) return el; var ks=kids(el); for(var i=0;i<ks.length;i++){ var r=find(ks[i],role,depth-1); if(r) return r;} return null; }
function run(){
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if(!apps || apps.count===0) throw new Error('Things not running');
  var pid=apps.objectAtIndex(0).processIdentifier;
  var app=$.AXUIElementCreateApplication(pid);
  var dt=null;
  for(var t=0;t<20 && !dt;t++){ dt=find(app,'AXDateTimeArea',16); if(!dt) $.NSThread.sleepForTimeInterval(0.1); }
  if(!dt) throw new Error('no AXDateTimeArea in the Repeat dialog');
  var spec=${JSON.stringify(spec)};
  var cal=$.NSCalendar.currentCalendar;
  var d;
  if(spec.indexOf('time:')===0){
    // Set the time-of-day on the control's own (today's) date via the purpose-
    // built calendar API — component-bag mutation via JXA silently drops the
    // hour, leaking the current wall-clock hour into the reminder (UIC6).
    var cur=attr(dt,'AXValue'); if(!cur) throw new Error('date/time control has no value');
    var hm=spec.slice(5).split(':');
    d=cal.dateBySettingHourMinuteSecondOfDateOptions(+hm[0], +hm[1], 0, cur, 0);
  } else if(spec.indexOf('date:')===0){
    var ymd=spec.slice(5).split('-');
    var comps=$.NSDateComponents.alloc.init;
    comps.year=+ymd[0]; comps.month=+ymd[1]; comps.day=+ymd[2]; comps.hour=0; comps.minute=0; comps.second=0;
    d=cal.dateFromComponents(comps);
  } else { throw new Error('bad datetime spec: '+spec); }
  if(!d) throw new Error('could not build date from '+spec);
  var err=$.AXUIElementSetAttributeValue(dt,$('AXValue'),d);
  if(err!==0) throw new Error('AXValue set failed err='+err);
  $.NSThread.sleepForTimeInterval(0.2);
  return 'OK';
}`;
}

/** Parse a resolve-frame "x y w h" line into the frame's center point. */
export function parseFrameCenter(stdout: string): { x: number; y: number } | null {
  const nums = stdout.trim().split(/\s+/).map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums as [number, number, number, number];
  return { x: x + w / 2, y: y + h / 2 };
}

function revealUrl(uuid: string): string {
  return `things:///show?id=${encodeURIComponent(uuid)}`;
}

function defaultRun(command: UiCommand, timeoutMs: number): Promise<UiRunResult> {
  return new Promise((resolve) => {
    let bin: string;
    let args: string[];
    if (command.primitive === "reveal") {
      [bin, args] = ["open", [command.url ?? ""]];
    } else if (command.lang === "javascript") {
      // JXA (ObjC bridge) for the mouse-synthesis primitive; one stable shape.
      [bin, args] = ["osascript", ["-l", "JavaScript", "-e", command.script ?? ""]];
    } else {
      [bin, args] = ["osascript", ["-e", command.script ?? ""]];
    }
    execFile(bin, [...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      const timedOut = err !== null && (err as { killed?: boolean }).killed === true;
      resolve({
        ok: err === null,
        stdout: String(stdout),
        stderr: String(stderr),
        ...(timedOut && { timedOut: true }),
      });
    });
  });
}

/** The element paths the preflight canary resolves (static steps only). */
function canaryPaths(recipe: UiRecipe): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  for (const step of recipe.steps) {
    if (step.dynamic === true) continue;
    if (
      step.primitive !== "press" &&
      step.primitive !== "set-value" &&
      step.primitive !== "resolve" &&
      step.primitive !== "click-element" &&
      step.primitive !== "select-row"
    ) {
      continue;
    }
    // A candidate-addressed step is resolved at run time (its element is
    // dynamic by construction), so it is never canaried here.
    if (step.pathCandidates !== undefined) continue;
    const path = step.canaryPath ?? step.path;
    if (path !== undefined) out.push({ path, label: step.label });
  }
  return out;
}

/**
 * Resolve a step's effective element path. A `pathCandidates` step dispatches
 * against the FIRST candidate that exists (the dialog-form disjunction — attached
 * sheet vs detached AXUnknown window, UIC4-a). The candidates are POLLED over a
 * bounded window because the full-vocabulary controls are REVEALED by the
 * preceding step: switching the frequency pop-up to weekly/monthly/yearly (or
 * ticking Ends=after) re-lays-out the cadence group, and the new pop-up/field
 * lands ~250 ms later (UIC6). A single immediate exists-check races that render
 * and would spuriously fail closed; polling matches the `dynamic` nature these
 * steps already declare. Returns null when none resolve within the window.
 */
async function resolveStepPath(step: UiStep, run: UiRunner): Promise<string | null> {
  if (step.pathCandidates === undefined) return step.path ?? null;
  const candidates = step.pathCandidates;
  const deadline = Date.now() + (step.timeoutMs ?? RESOLVE_CANDIDATE_TIMEOUT_MS);
  for (;;) {
    for (const candidate of candidates) {
      // candidates are tried in priority order; the first hit wins, so a race would blur which form matched
      const res = await run(
        { primitive: "resolve", label: step.label, script: axResolveScript(candidate) },
        STEP_TIMEOUT_MS,
      );
      if (res.ok && res.stdout.trim() === "true") return candidate;
    }
    if (Date.now() >= deadline) return null;
    // the revealed control lands a beat after the mode switch; poll until it does
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

function refusal(detail: string): ExecuteResult {
  return { exitCode: 1, stdout: "", stderr: detail };
}

/** Compile one recipe step into its primitive command (no dispatch). */
export function commandForStep(step: UiStep, targetUuid: string): UiCommand {
  switch (step.primitive) {
    case "reveal":
      return { primitive: "reveal", label: step.label, url: revealUrl(step.value ?? targetUuid) };
    case "activate":
      return { primitive: "activate", label: step.label, script: axActivateScript() };
    case "press":
      return { primitive: "press", label: step.label, script: axPressScript(step.path ?? "") };
    case "resolve":
      return { primitive: "resolve", label: step.label, script: axResolveScript(step.path ?? "") };
    case "set-value":
      return {
        primitive: "set-value",
        label: step.label,
        script: axSetValueScript(step.path ?? "", step.value ?? ""),
      };
    case "select-popup":
      return {
        primitive: "select-popup",
        label: step.label,
        script: axSelectPopupScript(step.path ?? "", step.value ?? ""),
      };
    case "set-datetime":
      return {
        primitive: "set-datetime",
        label: step.label,
        lang: "javascript",
        script: axSetDateTimeScript(step.value ?? ""),
      };
    case "wait":
      return { primitive: "wait", label: step.label, script: axResolveScript(step.path ?? "") };
    case "select-row":
      return {
        primitive: "select-row",
        label: step.label,
        script: axSelectRowScript(step.path ?? "", step.value ?? ""),
      };
    case "key":
      return { primitive: "key", label: step.label, script: axKeyScript(step.keys ?? "") };
    case "click-element":
      // Phase 1 of the click: read the target's frame. driveClickElement runs
      // this, then posts the click at the resolved center and asserts the outcome.
      return {
        primitive: "resolve-frame",
        label: step.label,
        lang: "applescript",
        script: axFrameScript(step.path ?? ""),
      };
    case "drag-reorder":
      // Composite step: drive() hands it to the sidebar drag driver, which
      // dispatches its own snapshot/scroll/drag commands through `run`. This
      // shape only exists so the step renders/compiles uniformly.
      return {
        primitive: "sidebar-snapshot",
        label: step.label,
        lang: "javascript",
        script: jxaSidebarSnapshotScript(),
      };
  }
}

/**
 * Execute a `click-element` step: resolve the target's AX frame, synthesize a
 * mouse click at its center, then verify the declared post-click outcome. Fails
 * closed at every stage — a missing frame aborts BEFORE any click (no guessed
 * pixel is ever clicked); a missing post-click element dismisses whatever opened
 * (Escape) and aborts.
 */
async function driveClickElement(
  step: UiStep,
  run: UiRunner,
): Promise<{ ok: boolean; why?: string; needsAbort?: boolean }> {
  const frameRes = await run(commandForStep(step, ""), STEP_TIMEOUT_MS);
  const center = frameRes.ok ? parseFrameCenter(frameRes.stdout) : null;
  if (center === null) {
    return {
      ok: false,
      why:
        "its on-screen position did not resolve — a Things update may have moved the control, " +
        "or the app is not in the expected state; no click was sent",
    };
  }
  const clickRes = await run(clickPointCommand(center.x, center.y, step.label), STEP_TIMEOUT_MS);
  if (!clickRes.ok) {
    return {
      ok: false,
      why:
        clickRes.timedOut === true
          ? "the click timed out"
          : clickRes.stderr.trim() || "the click failed",
      needsAbort: true,
    };
  }
  if (step.assertPath !== undefined) {
    const ok = await waitForElement(
      {
        primitive: "wait",
        label: step.assertLabel ?? step.label,
        script: axResolveScript(step.assertPath),
      },
      step.assertTimeoutMs ?? STEP_TIMEOUT_MS,
      run,
    );
    if (!ok) {
      return {
        ok: false,
        why: `${step.assertLabel ?? "the expected element"} did not appear after the click`,
        needsAbort: true,
      };
    }
  }
  return { ok: true };
}

async function drive(recipe: UiRecipe, run: UiRunner, aux: UiDriveAux): Promise<ExecuteResult> {
  const done: string[] = [];
  const abort = (): Promise<UiRunResult> =>
    run({ primitive: "key", label: "abort (Escape)", script: axAbortScript() }, STEP_TIMEOUT_MS);
  const partial = (failed: string, why: string, dismissed = true): ExecuteResult =>
    refusal(
      `ui drive stopped at "${failed}" (${why}). Completed: ${done.join(" → ") || "nothing"}.` +
        (dismissed ? " The open sheet/popover was dismissed (Escape)." : ""),
    );

  // 0. Run the leading reveal/activate preamble BEFORE the canary. The Items
  //    menu is context-dependent — its Repeat submenu (and the plain "Repeat…"
  //    item) only materialize once a matching item is SELECTED (UIC1). Resolving
  //    those menu paths in the canary is only meaningful after the reveal has
  //    selected the target, so the preamble must run first.
  let idx = 0;
  while (
    idx < recipe.steps.length &&
    (recipe.steps[idx]?.primitive === "reveal" || recipe.steps[idx]?.primitive === "activate")
  ) {
    const step = recipe.steps[idx] as UiStep;
    // the preamble steps are strictly sequential (select, then foreground) and each must land before the next
    const res = await run(commandForStep(step, recipe.targetUuid), STEP_TIMEOUT_MS);
    if (!res.ok) {
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
      );
    }
    done.push(step.label);
    idx += 1;
  }
  // Let the selection settle so the menu bar repopulates before the canary reads it.
  if (idx > 0) await new Promise((r) => setTimeout(r, SETTLE_AFTER_REVEAL_MS));

  // 1. Recipe canary: resolve every statically-reachable element (now that the
  //    target is selected). A miss refuses the whole drive before anything is
  //    pressed. (This is also the localization check: English titles must resolve.)
  for (const { path, label } of canaryPaths(recipe)) {
    // the canary resolves elements one at a time; a single miss aborts before anything is pressed, so parallelizing would waste work and blur which element failed
    const res = await run(
      { primitive: "resolve", label, script: axResolveScript(path) },
      STEP_TIMEOUT_MS,
    );
    if (!res.ok || res.stdout.trim() !== "true") {
      return refusal(
        `ui preflight refused: element for "${label}" did not resolve (${path}) — a Things ` +
          "update may have changed the menu, Accessibility may not be granted, Things may not " +
          "be running, or the app may not be in English. Nothing was pressed.",
      );
    }
  }

  // 2. Execute the remaining steps in order; a dynamic element is waited-for.
  for (let i = idx; i < recipe.steps.length; i += 1) {
    let step = recipe.steps[i] as UiStep;
    if (step.primitive === "wait") {
      // A candidate-addressed wait polls for ANY of its shapes to appear (the
      // dialog opening as an attached sheet OR a detached AXUnknown window).
      // steps are strictly sequential: this wait must resolve before the step that acts on the awaited element runs
      const ok = await waitForAnyElement(
        step.pathCandidates ?? [step.path ?? ""],
        step.label,
        step.timeoutMs ?? STEP_TIMEOUT_MS,
        run,
      );
      if (!ok) {
        // the abort keystroke must land before returning the partial-state report
        await abort();
        return partial(step.label, "the expected element never appeared within the timeout");
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "drag-reorder") {
      // The sidebar drag driver runs its own snapshot → scroll → drag →
      // DB-assert ladder (ui-drag.ts); every gesture anchors on frames it
      // resolves live, and a failed assert triggers a verified recovery drag.
      if (step.drag === undefined) return partial(step.label, "no drag spec compiled", false);
      // the drag ladder depends on the UI state the preamble produced
      const outcome = await driveSidebarAreaReorder(step.drag, run, aux);
      if (!outcome.ok) return partial(step.label, outcome.detail, false);
      done.push(`${step.label} (${outcome.detail})`);
      continue;
    }
    // Resolve a candidate-addressed step's effective element before dispatch
    // (the sheet-vs-detached-window disjunction). A miss fails closed.
    if (step.pathCandidates !== undefined) {
      // the effective form must be resolved before this step can act on it
      const effective = await resolveStepPath(step, run);
      if (effective === null) {
        // dismiss whatever opened before reporting
        await abort();
        return partial(
          step.label,
          "none of its expected element shapes resolved (neither the attached sheet nor the " +
            "detached repeat editor window)",
        );
      }
      step = { ...step, path: effective };
    }
    const command = commandForStep(step, recipe.targetUuid);
    if (step.primitive === "select-row") {
      // Pure-AX row selection with readback verification (UIC4-a): "OK" only
      // when a row selected to the target title.
      // the selection must land before the menu that acts on it is pressed
      const res = await run(command, STEP_TIMEOUT_MS);
      if (!res.ok || res.stdout.trim() !== "OK") {
        // clear any transient state before reporting
        await abort();
        return partial(
          step.label,
          res.ok
            ? "no content-table row selected to the target project's title — it may not be a " +
                "selectable row in this view, or its title changed"
            : res.timedOut === true
              ? "the row-selection step timed out"
              : res.stderr.trim() || "the row-selection step failed",
        );
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "click-element") {
      // A mouse click at an AX-resolved frame center (the NATIVE1 primitive),
      // used only where AXPress is inert (Things' custom `…`/repeat-bar popover).
      // the click depends on the UI state the previous step produced
      const outcome = await driveClickElement(step, run);
      if (!outcome.ok) {
        // dismiss whatever the click opened before reporting
        if (outcome.needsAbort === true) await abort();
        return partial(step.label, outcome.why ?? "the click failed");
      }
      done.push(step.label);
      continue;
    }
    // each recipe step depends on the UI state the previous step produced; they cannot be parallelized
    const res = await run(command, STEP_TIMEOUT_MS);
    if (!res.ok) {
      // dismiss the half-open sheet/popover before reporting partial state
      if (step.primitive !== "reveal" && step.primitive !== "activate") await abort();
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
      );
    }
    done.push(step.label);
  }
  return { exitCode: 0, stdout: `drove ${done.length} step(s): ${done.join(" → ")}`, stderr: "" };
}

async function waitForElement(
  command: UiCommand,
  timeoutMs: number,
  run: UiRunner,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // polling the same element until it appears is inherently sequential
    const res = await run(command, STEP_TIMEOUT_MS);
    if (res.ok && res.stdout.trim() === "true") return true;
    if (Date.now() >= deadline) return false;
    // inter-poll delay between sequential existence checks
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

/** Poll until ANY of the candidate element shapes exists (the sheet-vs-detached-window disjunction). */
async function waitForAnyElement(
  paths: string[],
  label: string,
  timeoutMs: number,
  run: UiRunner,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const path of paths) {
      // Emitted as the `wait` primitive (not `resolve`) so the command stream a
      // caller observes is unchanged from the single-path waitForElement.
      // candidates checked in priority order; the first present shape ends the wait
      const res = await run(
        { primitive: "wait", label, script: axResolveScript(path) },
        STEP_TIMEOUT_MS,
      );
      if (res.ok && res.stdout.trim() === "true") return true;
    }
    if (Date.now() >= deadline) return false;
    // inter-poll delay between sequential existence checks
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

function enabledMatrix(): VectorMatrix {
  const matrix: VectorMatrix = {};
  for (const op of UI_DRIVE_OPS) {
    const cert = certificationOf(op);
    matrix[op] = {
      support: "yes",
      // The most-disruptive tier: the drive foregrounds Things and takes over
      // UI focus. The `dangerouslyDriveGui` ack lifts the disruption ceiling.
      disruption: 3,
      // The RECIPE is wired and lab-derived (validated for planning); on-device
      // CERTIFICATION is a separate axis surfaced by `things capabilities`.
      validation: "validated",
      ...(cert !== undefined && { evidence: cert.evidence }),
      notes:
        `drives the Things app through the Accessibility API (${cert?.status ?? "uncertified"}` +
        " — recipe element paths pending on-device confirmation); menu-path element presses do not " +
        "steal focus and work under a locked session (AXVM1), while ops that open Things' custom " +
        "repeat menus additionally move the pointer, bring the app to the foreground, and need an " +
        "unlocked session with the display awake (NATIVE1)",
    };
  }
  return matrix;
}

function disabledMatrix(): VectorMatrix {
  const matrix: VectorMatrix = {};
  for (const op of UI_DRIVE_OPS) {
    matrix[op] = {
      support: "no",
      disruption: 3,
      validation: "validated",
      notes:
        "the Accessibility GUI vector is off on this machine — enable it with `things config " +
        "set ui-enabled true`, then grant Accessibility to this process (see docs/setup.md). " +
        "It drives the local Things GUI and is intended for a dedicated always-on Mac.",
    };
  }
  return matrix;
}

/**
 * The ui vector. Config-gated: when `ui.enabled` is false the matrix reports
 * every op unsupported (with a remediation naming the config key + setup doc),
 * so the operation is never dispatched. When enabled, `execute` runs the
 * compiled recipe fail-closed.
 */
export function createUiVector(
  config: ThingsApiConfig,
  run: UiRunner = defaultRun,
  aux: UiDriveAux = {},
): WriteVector {
  const enabled = config.ui.enabled;
  return {
    id: "ui",
    matrix: enabled ? enabledMatrix() : disabledMatrix(),
    async execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      if (!enabled) {
        return refusal(
          "the ui vector is disabled (`things config set ui-enabled true` to enable it).",
        );
      }
      if (invocation.recipe === undefined) {
        return refusal("ui invocation carried no recipe (compile bug).");
      }
      return drive(invocation.recipe, run, aux);
    },
  };
}
