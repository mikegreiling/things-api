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

import { DEFAULT_UI_DRIVE_BUDGET_MS, type ThingsApiConfig } from "../../config.ts";
import { osaExec } from "../../deputy/osa.ts";
import { noteInflightStep, trace, traceActive, tracePath } from "../../trace/tracer.ts";
import { UI_DRIVE_OPS } from "../operations.ts";
import { escapeAppleScript } from "./applescript.ts";
import {
  createReachabilityCache,
  H_UI_SESSION_UNREACHABLE,
  probeSessionReachability,
  type ReachabilityProbeCache,
  type ReachabilityVerdict,
} from "./session-reachability.ts";
import { certificationOf } from "./ui-certification.ts";
import { driveSidebarAreaReorder, jxaSidebarSnapshotScript, type UiDriveAux } from "./ui-drag.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  RepeatDialogShape,
  UiPrimitive,
  UiRecipe,
  UiStep,
  VectorMatrix,
  WriteVector,
} from "./types.ts";

/** GUI driving can stall on an unanswered sheet; give each step headroom. */
const STEP_TIMEOUT_MS = 15_000;
/**
 * Poll interval while waiting for a dynamic element (sheet/popover). KEPT at 300ms
 * after the PERF2 audit: the control a mode switch reveals takes ~462ms to appear
 * on the golden (S5b, [docs/lab/perf2-step-latency.md]), which EXCEEDS this
 * interval — so a 300ms poll catches it on its second round; a finer interval
 * would only add osascript hops for a marginal detection gain (UIC6 confirmed).
 */
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
 * instantaneous). TRIMMED 1500 → 1000 by the PERF2 audit (S5a,
 * [docs/lab/perf2-step-latency.md]): on a warm running app under DEFAULT macOS
 * animations the menu repopulates in ~92ms median / 116ms max (N=10) — a ~13×
 * margin at 1500. Menu-bar repopulation is a LOCAL UI operation (not a DB-commit /
 * sync-bound one), so it does not scale with DB size the way the OK commit does;
 * 1000ms keeps ~8.6× the golden max as host headroom. Under-margining only ever
 * costs a fail-closed spurious drive refusal (the canary miss), never a bad write.
 */
const SETTLE_AFTER_REVEAL_MS = 1000;

/**
 * A shape-dependent step reached without the dialog having been measured — a
 * recipe bug (the `probe-dialog-shape` step is missing or ran after its
 * dependants). Refused, never guessed: the two shapes address DIFFERENT controls
 * at the same index.
 */
const SHAPE_UNPROBED =
  "the Repeat dialog's shape was never measured, so this control's address is unknown (recipe bug)";

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
export function axSetValueScript(path: string, value: string, attempts = 3): string {
  const v = escapeAppleScript(value);
  const n = Math.max(1, Math.trunc(attempts));
  // CLOSED-LOOP (determinism doctrine): type, Tab-commit, then READ THE FIELD
  // BACK and retry if it did not hold — the interval field, when it is the first
  // numeric field after a frequency/type switch, races the dialog's group
  // re-layout and reverts to 1 (UIC7, oddities §8l). Re-focus + re-type after a
  // settle lands it once the re-layout has finished. Fail-closed (an `error`,
  // i.e. a transport failure the pipeline re-verifies) if it never holds — the
  // create/reschedule delta's rule assertion is the final DB-level authority.
  return `${SE}
  set tf to (${path})
  repeat ${n} times
    set focused of tf to true
    delay 0.15
    keystroke "a" using command down
    delay 0.1
    keystroke "${v}"
    delay 0.1
    key code 48
    delay 0.2
    try
      if ((value of tf) as text) is "${v}" then return "OK"
    end try
    delay 0.3
  end repeat
  error "field did not hold value \\"${v}\\" after ${n} attempt(s); last shown: " & ((value of tf) as text)
end tell`;
}
/**
 * ensure-checkbox: converge a dialog checkbox to a target state through a
 * DETERMINISTIC CLOSED LOOP (RRD1, determinism doctrine) — never a blind toggle.
 * It reads the checkbox's `AXValue` (0 = unchecked, 1 = checked), presses it ONLY
 * when the observed value differs from `target`, then RE-READS to confirm the new
 * value equals `target`. A press that did not register (or a value that has not
 * settled) is retried a bounded number of times; if it never converges the script
 * FAILS CLOSED (an `error`, i.e. a transport failure the pipeline re-verifies).
 *
 * This is what makes the "Add deadlines" / "Add reminders" checkboxes safe on a
 * PRE-POPULATED reschedule dialog: the dialog opens with the item's CURRENT
 * deadline/reminder state already ticked, so the old unconditional `click`
 * FLIPPED an already-correct box the wrong way — the live #493-adjacent bug where
 * a blind "Add deadlines" press UNCHECKED an already-deadlined rule and hid the
 * "start N days earlier" field, collapsing the drive. Reading before pressing
 * makes an already-correct box a no-op. One stable command shape per primitive.
 */
export function axEnsureCheckboxScript(path: string, target: boolean, attempts = 3): string {
  const want = target ? 1 : 0;
  const n = Math.max(1, Math.trunc(attempts));
  return `${SE}
  set cb to (${path})
  repeat ${n} times
    set cur to (value of cb) as integer
    if cur is ${want} then return "OK"
    click cb
    delay 0.2
  end repeat
  set cur to (value of cb) as integer
  if cur is ${want} then return "OK"
  error "checkbox did not converge to ${want} after ${n} attempt(s); still " & cur
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
  return axSelectPopupCandidatesScript(path, [value]);
}
/**
 * select-popup with a CANDIDATE LABEL LIST: open the pop-up (self-healing, as
 * above), then click the FIRST candidate menu item that EXISTS, failing closed
 * (an `error`, so the step reports transport failure) when none do. This is how
 * the after-completion cadence unit is driven: its label is SINGULAR at interval
 * 1 (`week`) but PLURAL at interval > 1 (`weeks`), and a reschedule opens the
 * dialog pre-populated with the item's current interval — so a biweekly
 * repeater's unit pop-up reads `weeks` before the interval field is ever touched
 * (0½ defect (c): the field report's drive died on `menu item "week" not
 * found`). Trying both labels makes the selection order-independent and
 * plural-safe. One stable command shape per primitive.
 */
export function axSelectPopupCandidatesScript(path: string, values: string[]): string {
  const list = values.map((v) => `"${escapeAppleScript(v)}"`).join(", ");
  return `${SE}
  set pu to (${path})
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  repeat with candidate in {${list}}
    if (exists menu item candidate of menu 1 of pu) then
      click menu item candidate of menu 1 of pu
      return
    end if
  end repeat
  error "none of the candidate menu items exist: " & {${list}}
end tell`;
}
/**
 * probe-dialog-shape: MEASURE which Repeat dialog is open (RDLG2) — the whole
 * version fork, decided by STRUCTURE rather than by the app version, so the
 * recipe self-selects on any host and a future redesign refuses instead of
 * silently pressing the wrong control:
 *
 *  - `next-popup` (Things 3.23+) — the first occurrence is an `AXPopUpButton`
 *    listing the rule's own upcoming occurrences. It sits between Ends and every
 *    per-frequency control, so weekday / monthly / yearly pop-ups are one index
 *    further along.
 *  - `legacy` (Things ≤ 3.22) — the first occurrence is a free-form
 *    `AXDateTimeArea`, and the per-frequency controls follow Ends directly.
 *
 * The discriminator is the CONTROL CLASS on the `Next:` row, not the presence of
 * the label: RDLG2d measured Things 3.22.14 and found it carries the same
 * `Next:` static text (and the same occurrence-preview line) as 3.23 — only the
 * control beside it changed. So the probe reads the label's row position and asks
 * what kind of control shares that row, which also keeps it independent of the
 * dialog's Ends state (an `Ends: on date` bound adds a SECOND date area, on a
 * different row, in both shapes). Each branch is a POSITIVE match, so an
 * unrecognized third dialog returns "unknown" and the driver refuses. Labels are
 * pinned English, exactly like every other selector here.
 */
export function axProbeDialogShapeScript(groupPath: string, rowTolerance = 8): string {
  const tol = Math.max(1, Math.trunc(rowTolerance));
  return `${SE}
  set g to (${groupPath})
  set nextY to missing value
  set nStatic to (count of static texts of g)
  repeat with i from 1 to nStatic
    set v to ""
    try
      set v to (value of static text i of g) as text
    end try
    if v is "Next:" then
      set p to position of static text i of g
      set nextY to item 2 of p
    end if
  end repeat
  if nextY is missing value then return "unknown"
  set nPop to (count of pop up buttons of g)
  repeat with i from 1 to nPop
    set p to position of pop up button i of g
    set dy to (item 2 of p) - nextY
    if dy < 0 then set dy to -dy
    if dy <= ${tol} then return "next-popup"
  end repeat
  try
    set areas to (every UI element of g whose role is "AXDateTimeArea")
    repeat with i from 1 to (count of areas)
      set p to position of (item i of areas)
      set dy to (item 2 of p) - nextY
      if dy < 0 then set dy to -dy
      if dy <= ${tol} then return "legacy"
    end repeat
  end try
  return "unknown"
end tell`;
}

/**
 * select-next-occurrence: set the first occurrence through the Things 3.23
 * `Next:` POP-UP (RDLG2). 3.23 replaced the free-form first-occurrence date area
 * with a bounded MENU — `Today`, then the rule's own upcoming occurrences, then a
 * `More…` item whose submenu carries the next hundred, cascading further the same
 * way. Two consequences this script encodes:
 *
 *  - a requested date is reachable ONLY if the rule itself produces it (or it is
 *    today): the menu offers nothing else, so an OFF-RULE first occurrence — free
 *    to set on ≤3.22 — is UNEXPRESSIBLE in this dialog and must fail closed with
 *    a named reason rather than land some neighbouring date;
 *  - item titles are localized (`Sun, Jul 12, 2026`), so the match is made by
 *    PARSING each title to a date (with a leading-weekday retry) and comparing
 *    calendar components — never by rebuilding the app's display string.
 *
 * The cascade is walked to a bounded depth; the click is verified by reading the
 * pop-up's value back and requiring it to equal the clicked item's own title
 * (the fail-closed read-back the ANCH2/YANCH1 date drives established).
 */
export function axSelectNextOccurrenceScript(
  popupPath: string,
  isoDate: string,
  maxLevels = 6,
): string {
  const [y, m, d] = isoDate.split("-").map((part) => Number(part));
  const levels = Math.max(1, Math.trunc(maxLevels));
  return `on parsedYMD(t)
  set s to t as text
  try
    set theDate to date s
    return {year of theDate, (month of theDate) as integer, day of theDate}
  end try
  try
    set ofs to offset of ", " in s
    if ofs > 0 then
      set theDate to date (text (ofs + 2) thru -1 of s)
      return {year of theDate, (month of theDate) as integer, day of theDate}
    end if
  end try
  return missing value
end parsedYMD

set wantY to ${y}
set wantM to ${m}
set wantD to ${d}
set rightNow to current date
set isToday to ((year of rightNow) is wantY and ((month of rightNow) as integer) is wantM and (day of rightNow) is wantD)
${SE}
  set pu to (${popupPath})
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  set theMenu to menu 1 of pu
  set clickedTitle to ""
  set levelsSeen to 0
  if isToday then
    set nms to name of every menu item of theMenu
    if (count of nms) > 0 then
      set t1 to item 1 of nms
      if t1 is not missing value then
        if (my parsedYMD(t1)) is missing value then
          set clickedTitle to t1 as text
          click menu item 1 of theMenu
        end if
      end if
    end if
  end if
  repeat ${levels} times
    if clickedTitle is not "" then exit repeat
    set levelsSeen to levelsSeen + 1
    set nms to name of every menu item of theMenu
    set hit to 0
    repeat with i from 1 to (count of nms)
      set nm to item i of nms
      if nm is not missing value then
        set ymd to my parsedYMD(nm)
        if ymd is not missing value then
          if (item 1 of ymd) is wantY and (item 2 of ymd) is wantM and (item 3 of ymd) is wantD then
            set hit to i
            exit repeat
          end if
        end if
      end if
    end repeat
    if hit > 0 then
      set clickedTitle to (item hit of nms) as text
      click menu item hit of theMenu
      exit repeat
    end if
    set lastI to (count of nms)
    if lastI is 0 then exit repeat
    if (item lastI of nms) is missing value then exit repeat
    set deeper to missing value
    try
      set deeper to menu 1 of menu item lastI of theMenu
    end try
    if deeper is missing value then
      try
        click menu item lastI of theMenu
        delay 0.5
        set deeper to menu 1 of menu item lastI of theMenu
      end try
    end if
    if deeper is missing value then exit repeat
    set theMenu to deeper
  end repeat
  if clickedTitle is "" then
    key code 53
    error "select-next-occurrence: this Repeat dialog offers only the rule's own upcoming occurrences (and today) as the first occurrence, and ${isoDate} is not one of them — searched " & levelsSeen & " level(s) of the Next: menu. Ask for a date the rule actually produces, or change the rule."
  end if
  delay 0.4
  set shown to (value of pu) as text
  if shown is not clickedTitle then
    error "select-next-occurrence: the Next: pop-up committed \\"" & shown & "\\", not the requested \\"" & clickedTitle & "\\" — the selection did not take"
  end if
  return "OK"
end tell`;
}

/**
 * converge-weekdays: drive the weekly dialog's weekday ROWS onto an exact target
 * set through a deterministic closed loop (RDLG2 — the RRD1 fix).
 *
 * The shipped drive set the FIRST weekday row and then pressed "+" and re-drove
 * THE SAME row index per extra weekday, which on a PRE-POPULATED reschedule
 * dialog left the rule's existing weekdays untouched: `{mon,wed}` retargeted to
 * `{tue,thu,sat}` committed `{mon,tue,thu,sat}` (VMQ1 cell 2Tb — caught only by
 * the write pipeline's verify). It also had no way to SHRINK a set.
 *
 * The loop instead: (1) read the live row count; (2) press the row-add button —
 * the smaller-x button of a weekday row, resolved from live geometry rather than
 * a pinned index, because the row buttons enumerate in an unstable order — until
 * there are at least as many rows as target weekdays; (3) assign EVERY row from
 * the target set, cycling, so a surplus row duplicates a target weekday instead
 * of keeping a stale one (the app stores the weekdays as a SET, so duplicates
 * collapse on commit — this is what makes shrinking possible without the
 * remove button); (4) read every row back and require the set to match exactly.
 * Anything else errors — the pipeline re-verifies against the DB regardless.
 *
 * `base` is the 1-based group pop-up index of the first weekday row (2 on the
 * legacy dialog, 3 once the 3.23 `Next:` pop-up sits in front of them).
 */
export function axConvergeWeekdaysScript(
  groupPath: string,
  base: number,
  titles: string[],
): string {
  const list = titles.map((t) => `"${escapeAppleScript(t)}"`).join(", ");
  const b = Math.max(1, Math.trunc(base));
  return `set wantList to {${list}}
set baseIx to ${b}
${SE}
  set g to (${groupPath})
  set k to (count of wantList)
  repeat 14 times
    set n to (count of pop up buttons of g) - baseIx + 1
    if n >= k then exit repeat
    set nb to (count of buttons of g)
    if nb is 0 then error "converge-weekdays: the dialog exposes no weekday row button, so a second weekday cannot be added"
    set bestI to 0
    set bestX to 1000000
    repeat with i from 1 to nb
      set p to position of button i of g
      set px to item 1 of p
      if px < bestX then
        set bestX to px
        set bestI to i
      end if
    end repeat
    click button bestI of g
    delay 0.5
  end repeat
  set n to (count of pop up buttons of g) - baseIx + 1
  if n < k then error "converge-weekdays: the dialog would not grow to " & k & " weekday row(s) — it stopped at " & n
  repeat with i from 1 to n
    set wi to ((i - 1) mod k) + 1
    set wantVal to item wi of wantList
    set pu to pop up button (baseIx + i - 1) of g
    if ((value of pu) as text) is not wantVal then
      repeat 20 times
        if (exists menu 1 of pu) then exit repeat
        click pu
        delay 0.3
      end repeat
      if not (exists menu item wantVal of menu 1 of pu) then
        key code 53
        error "converge-weekdays: the weekday pop-up offers no item \\"" & wantVal & "\\" (the app may not be in English)"
      end if
      click menu item wantVal of menu 1 of pu
      delay 0.4
    end if
  end repeat
  set absent to ""
  repeat with wi from 1 to k
    set wantVal to item wi of wantList
    set seen to false
    repeat with i from 1 to n
      if ((value of pop up button (baseIx + i - 1) of g) as text) is wantVal then set seen to true
    end repeat
    if not seen then set absent to absent & wantVal & " "
  end repeat
  set strays to ""
  repeat with i from 1 to n
    set v to (value of pop up button (baseIx + i - 1) of g) as text
    if wantList does not contain v then set strays to strays & v & " "
  end repeat
  if absent is not "" or strays is not "" then
    error "converge-weekdays: the weekday rows did not converge — missing: " & absent & "| unexpected: " & strays
  end if
  return "OK"
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
 * VMRES1 correction (2026-08-23, golden-v4 / Things 3.23): the readback LAGS the
 * `select` action, so reading `name of selected to dos` immediately after it can
 * return the PREVIOUS iteration's selection. A row whose `select` lands nothing
 * (the blank spacer that follows the project rows) then matched the prior row's
 * title, the loop returned "OK" one row LATE, and the table was left with NOTHING
 * selected — `Items ▸ Repeat…` never materialized and the drive died at its wait
 * (`verify-failed:silent-noop`). It reproduced 3/3 on the second project-repeat
 * drive of a Things session and 0/2 on the first, which is the signature of a
 * race, not of app state. Fixed the way the heading sibling below already does
 * it: settle after `select`, then require `selected of (row i)` — the row THIS
 * iteration targeted must itself hold the selection — before trusting the title
 * readback. Evidence: [docs/lab/vmres1-residuals.md](../../../docs/lab/vmres1-residuals.md) §2.
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
      delay 0.25
      if (selected of (row i of theTable)) then
        tell application "Things3" to set selNames to (name of selected to dos)
        if (count of selNames) is 1 and ((item 1 of selNames) as text) is "${t}" then
          return "OK"
        end if
      end if
    end try
  end repeat
end tell
return "NOMATCH"`;
}

/**
 * select-heading-row: select a HEADING as a content-table row by POSITION,
 * purely via AX (HEADCERT1). A heading is not `things:///show`-selectable and
 * its row carries no stable AX title handle, so identity is positional. Walks
 * the revealed project view's content table; for each row it issues the row
 * `select` action, then checks two things: the row genuinely took the selection
 * (`selected of row` — header/spacer rows do not) AND `Things3 → name of
 * selected to dos` is EMPTY (a heading is not a to-do; a to-do row's readback is
 * its title). The Nth such heading row (0-based `ordinal`, in top-to-bottom =
 * `index` order) is LEFT selected and the script returns "OK"; "NOMATCH" if the
 * project has fewer headings. With the heading selected, `Items ▸ Convert to
 * Project…` enables. Pure System Events, background-capable, no focus steal.
 * One stable command shape per primitive.
 */
export function axSelectHeadingRowScript(tablePath: string, ordinal: number): string {
  const n = Math.max(0, Math.trunc(ordinal));
  return `tell application "System Events" to tell process "Things3"
  set theTable to (${tablePath})
  set rowCount to (count rows of theTable)
  set headingSeen to 0
  repeat with i from 1 to rowCount
    try
      select (row i of theTable)
      delay 0.25
      if (selected of (row i of theTable)) then
        tell application "Things3" to set selNames to (name of selected to dos)
        if (count of selNames) is 0 then
          if headingSeen is ${n} then return "OK"
          set headingSeen to headingSeen + 1
        end if
      end if
    end try
  end repeat
end tell
return "NOMATCH"`;
}

/**
 * assert-eligible: after a `things:///show?id=` reveal, VERIFY the target to-do
 * is genuinely the sole selection AND that the menu item that acts on it is
 * enabled — before the menu is pressed (ADR1, issue #480). The reveal is assumed
 * to select the row, but on some surfaces it can navigate without selecting; an
 * AXPress on the resulting DISABLED `Items ▸ Repeat…` is a silent no-op, so the
 * dialog never opens and the drive dies far downstream at the dialog-wait timeout
 * with no hint of the real cause. Reading `Things3 → id of selected to dos` is
 * uuid-precise (never a fuzzy title match), so a match GUARANTEES the intended row
 * is selected. Returns "OK" only when exactly the target is selected and the menu
 * item is enabled; otherwise a diagnostic (`NOTSEL…`/`WRONGSEL…`/`DISABLED…`)
 * naming expected vs observed. Pure System Events + Things scripting, background-
 * capable. One stable command shape per primitive.
 */
export function axAssertEligibleScript(targetUuid: string, menuItemPath: string): string {
  const u = escapeAppleScript(targetUuid);
  return `set selIds to {}
tell application "Things3"
  try
    set selIds to id of selected to dos
  end try
end tell
if (count of selIds) is 0 then return "NOTSEL no to-do is selected after the reveal (expected ${u}) — the show URL navigated without selecting an eligible row"
if (count of selIds) is greater than 1 then return "NOTSEL " & (count of selIds) & " to-dos are selected, expected exactly the target ${u}"
set theId to (item 1 of selIds) as text
if theId is not "${u}" then return "WRONGSEL the selected to-do is " & theId & ", expected the target ${u}"
set repEnabled to false
tell application "System Events" to tell process "Things3"
  try
    set repEnabled to enabled of ${menuItemPath}
  end try
end tell
if repEnabled is false then return "DISABLED the target ${u} is selected but its Repeat menu item is disabled (not an eligible row for this action)"
return "OK"`;
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
 * The PROVEN app-level clearance / relocation maneuver (SESSGATE, #480, live-host
 * recovery): close the front Things window — which takes an attached modal sheet
 * with it — then reopen and activate. Runs entirely through Things' own
 * AppleScript dictionary, so it works WITHOUT the Accessibility tree (the exact
 * property needed when the session is AX-blind). Two uses:
 *   - CLEANUP: clear a stuck modal sheet a failed drive left open (unblocks the
 *     app-wide AppleScript-mutation freeze that sheet imposes);
 *   - RELOCATION: pull a window that was on another Space back to the current one
 *     so its dialog can open AX-reachably (the wrong-Space recovery branch).
 * `reopen` restores the default window on the CURRENT Space; `activate` foregrounds
 * it. Returns "OK".
 */
export function axCloseReopenActivateScript(): string {
  return `tell application "Things3"
  try
    close window 1
  end try
  reopen
  activate
end tell
return "OK"`;
}

/**
 * sheet-open probe: is a modal SHEET attached to the Things standard window, OR
 * a detached repeat-editor / popover window (an `AXUnknown` that is not the
 * 40×40 utility window) present right now? Returns "true"/"false". Used to (d)
 * VERIFY an abort actually dismissed the sheet before claiming it did, and (e)
 * DIAGNOSE a canary miss that is really a leftover sheet from an earlier aborted
 * drive disabling the menu bar. Wrapped in `try` blocks so a missing standard
 * window (a rare transient) reads as "no sheet" rather than erroring. One stable
 * command shape.
 */
export function axSheetOpenScript(): string {
  return `${SE}
  set sheetOpen to false
  try
    if (exists sheet 1 of (first window whose subrole is "AXStandardWindow")) then set sheetOpen to true
  end try
  try
    if ((count of (windows whose subrole is "AXUnknown" and size is not {40, 40})) > 0) then set sheetOpen to true
  end try
  return sheetOpen
end tell`;
}

/** Is a modal sheet / detached editor currently open? Fail-closed: an errored probe reads as "still open". */
async function sheetStillOpen(run: UiRunner): Promise<boolean> {
  const res = await run(
    { primitive: "resolve", label: "sheet-open probe", script: axSheetOpenScript() },
    STEP_TIMEOUT_MS,
  );
  // Only a clean "false" clears the sheet; a probe error is treated as "may
  // still be open" (fail-closed doctrine — never claim dismissal we can't see).
  return !(res.ok && res.stdout.trim() === "false");
}

/**
 * The outcome of clearing a half-open dialog after a failed drive:
 *   - "dismissed"     — Escape dismissed it and the (AX-reachable) sheet probe
 *                       CONFIRMED it gone;
 *   - "cleared-blind" — the session was AX-blind (locked / off-Space), so Escape
 *                       and the sheet probe are untrustworthy; the PROVEN
 *                       app-level close+reopen ran to clear it (cannot be
 *                       AX-confirmed, but the maneuver works blind — SESSGATE);
 *   - "may-remain"    — a reachable but stubborn sheet that Escape would not
 *                       dismiss (fail-closed: warn it may still be open).
 */
type ClearResult = { state: "dismissed" | "cleared-blind" | "may-remain" };

/**
 * Clear a half-open sheet/popover a failed drive left behind — HONESTLY (SESSGATE
 * #480 fix; supersedes the old verifiedAbort, whose AX-blind sheet probe returned
 * "gone" it could not actually see, letting the still-open modal freeze the
 * app-wide AppleScript mutations the caller then attempted — the auto-trash
 * silent-noop). Escape first; then:
 *   - AX-BLIND (a not-reachable probe): Escape may never have reached the sheet
 *     and the sheet probe cannot see it, so run the app-level close+reopen that
 *     works blind (it takes the stuck sheet with the window). Reported as
 *     "cleared-blind" — never falsely "confirmed gone".
 *   - REACHABLE: the sheet probe is trustworthy — confirm the dismissal (retry
 *     Escape once), and if it will not go, warn "may remain".
 */
async function clearDialog(run: UiRunner): Promise<ClearResult> {
  const escape = (): Promise<UiRunResult> =>
    run({ primitive: "key", label: "abort (Escape)", script: axAbortScript() }, STEP_TIMEOUT_MS);
  await escape();
  const reach = await probeSessionReachability(run, STEP_TIMEOUT_MS);
  if (!reach.reachable) {
    // Cannot trust Escape or the sheet probe while AX-blind — use the proven
    // app-level maneuver, which clears a stuck sheet without the Accessibility tree.
    await run(
      {
        primitive: "resolve",
        label: "clear a stuck dialog (close the Things window and reopen it)",
        script: axCloseReopenActivateScript(),
      },
      STEP_TIMEOUT_MS,
    );
    return { state: "cleared-blind" };
  }
  if (!(await sheetStillOpen(run))) return { state: "dismissed" };
  await escape(); // one retry
  return { state: (await sheetStillOpen(run)) ? "may-remain" : "dismissed" };
}

/**
 * The dialog-class reachability GATE (SESSGATE, #480), run AFTER the reveal/
 * activate preamble (which surfaces a window in a healthy session) and BEFORE any
 * menu press. Three outcomes matched to the live session state:
 *   - reachable                  → proceed;
 *   - not reachable, "session"   → REFUSE (locked screen / full-screen Space —
 *                                  the certain-failure case): block, zero mutation;
 *   - not reachable, "window"    → RELOCATE: only Things' window is off the
 *                                  current Space, so run the app-level close+reopen
 *                                  that pulls it back, then RE-PROBE closed-loop.
 *                                  Reachable now → proceed (disclosed); still not →
 *                                  block with the Space remediation.
 */
async function ensureWindowReachable(
  run: UiRunner,
  reachCache: ReachabilityProbeCache,
): Promise<
  | { ok: true; relocated: boolean }
  | { ok: false; verdict: Extract<ReachabilityVerdict, { reachable: false }> }
> {
  // First probe MAY be served from the pre-seed gate's memo (PERF1) — but only a
  // reachable verdict is ever memoized, so every refusal/relocation below is still
  // decided on a fresh probe (see ReachabilityProbeCache).
  const first = await reachCache.probe(run, STEP_TIMEOUT_MS);
  if (first.reachable) return { ok: true, relocated: false };
  if (first.scope === "session") return { ok: false, verdict: first };
  // scope "window": Things' window is on another Space (or absent) while the
  // session is otherwise fine — try to bring it to the current Space, then re-probe.
  await run(
    {
      primitive: "resolve",
      label: "move the Things window to the current desktop",
      script: axCloseReopenActivateScript(),
    },
    STEP_TIMEOUT_MS,
  );
  // The relocation just changed window state — drop any memo and re-probe LIVE
  // (a closed-loop verify of the maneuver, never a cached verdict).
  reachCache.invalidate();
  const second = await probeSessionReachability(run, STEP_TIMEOUT_MS);
  if (second.reachable) return { ok: true, relocated: true };
  return { ok: false, verdict: second.reachable ? first : second };
}

/** The blocked ExecuteResult a dialog-class op returns when the session is unreachable. */
function blockedReachability(
  verdict: Extract<ReachabilityVerdict, { reachable: false }>,
): ExecuteResult {
  return {
    exitCode: 4,
    stdout: "",
    stderr: `${verdict.detail} ${verdict.remediation}`,
    blocked: {
      hazard: H_UI_SESSION_UNREACHABLE,
      detail: verdict.detail,
      remediation: verdict.remediation,
    },
  };
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
 * set-datetime: set ONE of the Repeat dialog's `AXDateTimeArea` controls via the
 * ObjC AX bridge. Things' date/time controls hold an NSDate, and System Events
 * cannot write them (`set value … to <date>` → -10000, UIC6), so — like the
 * mouse-synthesis primitive — this runs in JXA and calls
 * `AXUIElementSetAttributeValue(…, AXValue, <NSDate>)` directly.
 *
 * A fixed rule can expose up to THREE date areas at once — "Next:" (first
 * occurrence), "Ends: on date", and the reminder time (ANCH2 census). Targeting
 * "the first AXDateTimeArea by role" is therefore AMBIGUOUS — that ambiguity
 * collapsed the series when `--ends-on` added a second area (oddities §8v, now
 * retracted) and made the reminder look undrivable (UIC6-g, now retracted). This
 * driver selects DETERMINISTICALLY by `target` (ANCH2, docs/lab/anch2-next-field.md):
 *   - `reminder` — the only area carrying a time-of-day (the date pickers sit at
 *     midnight); falls back to the bottom-most area if none carry a time.
 *   - `next` — the TOP (smallest-y) midnight date picker.
 *   - `ends` — the BOTTOM (largest-y) midnight date picker (present only once
 *     "Ends: on date" is selected).
 * The areas are polled briefly (revealed a beat after the checkbox/pop-up), and
 * the script THROWS a NAMED, structured error when the addressed control is
 * absent — reporting which target was sought and the FULL date-area inventory of
 * the current dialog state (count + per-area y / time-of-day) — so a dialog shape
 * that does not present the target (e.g. the deadline-mode variant, YANCH1 #493)
 * fails closed with an actionable message, never an uncaught `-[__NSArray0
 * objectAtIndex:]` (-2700) from indexing an empty collection. It then READS THE
 * CONTROL BACK after the write and throws if the committed value differs from the
 * request: a control that silently rejects the write (the macOS error beep the
 * user hears) must fail the step loudly, never leave a garbled/default value to be
 * verified as ok (YANCH1; UIC6-g refuse-rather-than-commit precedent). `spec` is
 * `time:HH:mm` (keep the date, set the time-of-day) or `date:YYYY-MM-DD` (set the
 * calendar date at midnight). One stable JXA shape.
 */
export function axSetDateTimeScript(spec: string, target: "next" | "ends" | "reminder"): string {
  return `ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices');
function attr(el,name){ var out=Ref(); if($.AXUIElementCopyAttributeValue(el,$(name),out)!==0) return null; return ObjC.castRefToObject(out[0]); }
function rolestr(el){ var v=attr(el,'AXRole'); return v? v.js : ''; }
function kids(el){ var c=attr(el,'AXChildren'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function collect(el,role,depth,out){ if(depth<0) return; if(rolestr(el)===role) out.push(el); var ks=kids(el); for(var i=0;i<ks.length;i++) collect(ks[i],role,depth-1,out); }
function subrole(el){ var v=attr(el,'AXSubrole'); return v? v.js : ''; }
function windowsOf(el){ var c=attr(el,'AXWindows'); if(!c) return []; var a=[]; for(var i=0;i<c.count;i++) a.push(c.objectAtIndex(i)); return a; }
function sizeWH(el){ var s=attr(el,'AXSize'); if(!s) return null; var d=ObjC.castRefToObject($.CFCopyDescription(s)).js; var mw=String(d).match(/w:([-0-9.]+)/); var mh=String(d).match(/h:([-0-9.]+)/); return (mw&&mh)? {w:+mw[1], h:+mh[1]} : null; }
// Resolve the Repeat-dialog SHELL so the AXDateTimeArea collect walks only its
// small subtree — never the app-wide tree, whose main-window list content is the
// 4.4s app-root descent PERF2 removed (docs/lab/perf2-step-latency.md). The dialog
// presents in TWO shapes (ui-recipes DIALOG_SHELLS, UIC4-a), tried in the SAME
// priority order the System-Events pathCandidates use: an attached AXSheet on the
// standard window (Things frontmost), then a detached top-level AXUnknown window
// that is not the 40x40 utility window (Things backgrounded). null when neither is
// present — the caller then falls through to the same named "presents 0 date
// area(s)" error the app-root walk threw when the dialog was absent.
function findShell(app){
  var wins=windowsOf(app);
  for(var i=0;i<wins.length;i++){ if(subrole(wins[i])==='AXStandardWindow'){ var sh=[]; collect(wins[i],'AXSheet',3,sh); if(sh.length) return sh[0]; } }
  for(var i=0;i<wins.length;i++){ if(subrole(wins[i])==='AXUnknown'){ var wh=sizeWH(wins[i]); if(!wh || !(wh.w===40 && wh.h===40)) return wins[i]; } }
  return null;
}
function posY(el){ var p=attr(el,'AXPosition'); if(!p) return 0; var d=ObjC.castRefToObject($.CFCopyDescription(p)).js; var m=String(d).match(/y:([-0-9.]+)/); return m? +m[1] : 0; }
function timeOfDay(el){ var v=attr(el,'AXValue'); if(!v) return -1; var cal=$.NSCalendar.currentCalendar; return cal.componentFromDate($.NSCalendarUnitHour,v)*60 + cal.componentFromDate($.NSCalendarUnitMinute,v); }
function pick(areas,target){
  if(areas.length===0) return null;
  var sorted=areas.slice().sort(function(a,b){ return posY(a)-posY(b); });
  if(target==='reminder'){
    var timed=sorted.filter(function(a){ return timeOfDay(a)>0; });
    return timed.length? timed[timed.length-1] : sorted[sorted.length-1];
  }
  var midnight=sorted.filter(function(a){ return timeOfDay(a)===0; });
  if(midnight.length===0) midnight=sorted;
  return target==='ends' ? midnight[midnight.length-1] : midnight[0];
}
function inv(areas){ var s=[]; for(var i=0;i<areas.length;i++){ s.push('#'+i+'(y='+Math.round(posY(areas[i]))+',tod='+timeOfDay(areas[i])+')'); } return areas.length? s.join(' ') : '(none)'; }
function ymdStr(el,cal){ var v=attr(el,'AXValue'); if(!v) return null; var y=cal.componentFromDate($.NSCalendarUnitYear,v), m=cal.componentFromDate($.NSCalendarUnitMonth,v), dd=cal.componentFromDate($.NSCalendarUnitDay,v); return y+'-'+('0'+m).slice(-2)+'-'+('0'+dd).slice(-2); }
function hmStr(el,cal){ var v=attr(el,'AXValue'); if(!v) return null; var h=cal.componentFromDate($.NSCalendarUnitHour,v), mi=cal.componentFromDate($.NSCalendarUnitMinute,v); return h+':'+('0'+mi).slice(-2); }
function run(){
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if(!apps || apps.count===0) throw new Error('Things not running');
  var app=$.AXUIElementCreateApplication(apps.objectAtIndex(0).processIdentifier);
  var target=${JSON.stringify(target)};
  var spec=${JSON.stringify(spec)};
  // Poll for the addressed area WITHIN THE DIALOG SHELL (PERF2): resolve the sheet
  // / detached editor first, then collect only its subtree — the app-root descent
  // this replaced cost ~4.4s on the busy host by walking the main window's list
  // content. collect is wrapped so a stale-element ObjC exception during traversal
  // cannot bubble as a raw -2700; pick guards the empty set, so dt is null (never a
  // crash) when the target is absent. When no shell resolves (dialog absent), areas
  // stays empty and the loop falls through to the SAME named error below.
  var areas=[]; var dt=null;
  for(var t=0;t<20 && !dt;t++){ areas=[]; try{ var shell=findShell(app); if(shell) collect(shell,'AXDateTimeArea',16,areas); }catch(e){ areas=[]; } dt=pick(areas,target); if(!dt) $.NSThread.sleepForTimeInterval(0.1); }
  if(!dt) throw new Error('set-datetime '+target+': this Repeat-dialog state presents '+areas.length+' date area(s) ['+inv(areas)+'] but none is the '+target+' control — the requested first occurrence / bound cannot be set in this dialog shape');
  var cal=$.NSCalendar.currentCalendar;
  var d;
  if(spec.indexOf('time:')===0){
    // Set the time-of-day on the control's own date via the purpose-built
    // calendar API — component-bag mutation via JXA silently drops the hour,
    // leaking the current wall-clock hour into the reminder (UIC6).
    var cur=attr(dt,'AXValue'); if(!cur) throw new Error('set-datetime '+target+': the date/time control has no value to anchor the time on');
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
  if(err!==0) throw new Error('set-datetime '+target+': the control refused the write (AX err='+err+')');
  $.NSThread.sleepForTimeInterval(0.2);
  // READ-BACK: a control can accept the AX write (err 0) yet reject the value —
  // the macOS error beep — leaving its prior/default value. Fail the step loudly
  // rather than let a garbled commit verify as ok (YANCH1 #493).
  if(spec.indexOf('date:')===0){
    var got=ymdStr(dt,cal); var want=spec.slice(5);
    if(got!==want) throw new Error('set-datetime '+target+' rejected: the control committed '+(got||'(no value)')+', not the requested '+want+' — the write did not take');
  } else {
    var gott=hmStr(dt,cal); var wanth=spec.slice(5).split(':'); var wantt=(+wanth[0])+':'+('0'+(+wanth[1])).slice(-2);
    if(gott!==wantt) throw new Error('set-datetime '+target+' rejected: the control committed '+(gott||'(no value)')+', not the requested '+wantt+' — the write did not take');
  }
  return 'OK';
}`;
}

/**
 * The converge-weekdays step encodes both of its inputs in `value` as
 * `"<base>|<Weekday>,<Weekday>…"`: the base is the group pop-up index of the
 * FIRST weekday row, which the dialog SHAPE decides (2 legacy / 3 next-popup),
 * so it rides the same shape-selected `value` the driver merges in.
 */
export function weekdayBaseOf(value: string): number {
  const base = Number(value.split("|", 1)[0]);
  return Number.isFinite(base) && base > 0 ? Math.trunc(base) : 2;
}
export function weekdayTitlesOf(value: string): string[] {
  const rest = value.slice(value.indexOf("|") + 1);
  return rest.split(",").filter((t) => t !== "");
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

async function defaultRun(command: UiCommand, timeoutMs: number): Promise<UiRunResult> {
  if (command.primitive === "reveal") {
    // `open` is consent-free (LaunchServices, no AppleEvent) — never routed.
    return new Promise((resolve) => {
      execFile("open", [command.url ?? ""], { timeout: timeoutMs }, (err, stdout, stderr) => {
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
  // JXA (ObjC bridge) for the mouse-synthesis primitive; one stable shape.
  const lang = command.lang === "javascript" ? ("javascript" as const) : ("applescript" as const);
  const res = await osaExec(command.script ?? "", { lang, timeoutMs });
  return {
    ok: res.exitCode === 0 && res.timedOut !== true,
    stdout: res.stdout,
    stderr: res.stderr,
    ...(res.timedOut === true && { timedOut: true }),
  };
}

/**
 * Wrap the dispatch seam so every osascript hop is recorded. The last-dispatched
 * step is noted on the in-flight-write marker (so a SIGTERM/SIGINT can name it,
 * even with tracing off), and — when tracing is on — a `ui-dispatch` start/end
 * pair lands in the trace carrying the hop's duration and outcome. This
 * per-osascript granularity is exactly what reconstructs a hang: the timeline
 * shows which step's osascript was in flight, and for how long, when it stopped
 * (TRACE1 #487). Overhead when tracing is off is one boolean check + a field write.
 */
function tracingRun(inner: UiRunner): UiRunner {
  return async (command, timeoutMs) => {
    noteInflightStep(command.label);
    if (!traceActive()) return inner(command, timeoutMs);
    const started = Date.now();
    trace(() => ({
      phase: "ui-dispatch",
      event: "start",
      primitive: command.primitive,
      label: command.label,
    }));
    const res = await inner(command, timeoutMs);
    trace(() => ({
      phase: "ui-dispatch",
      event: "end",
      primitive: command.primitive,
      label: command.label,
      durationMs: Date.now() - started,
      ok: res.ok,
      timedOut: res.timedOut === true,
    }));
    return res;
  };
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
      step.primitive !== "select-row" &&
      step.primitive !== "select-heading-row"
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
        script:
          step.valueCandidates !== undefined
            ? axSelectPopupCandidatesScript(step.path ?? "", step.valueCandidates)
            : axSelectPopupScript(step.path ?? "", step.value ?? ""),
      };
    case "set-datetime":
      return {
        primitive: "set-datetime",
        label: step.label,
        lang: "javascript",
        script: axSetDateTimeScript(step.value ?? "", step.dtTarget ?? "next"),
      };
    case "ensure-checkbox":
      return {
        primitive: "ensure-checkbox",
        label: step.label,
        script: axEnsureCheckboxScript(step.path ?? "", step.checkboxTarget === true),
      };
    case "probe-dialog-shape":
      return {
        primitive: "probe-dialog-shape",
        label: step.label,
        script: axProbeDialogShapeScript(step.path ?? ""),
      };
    case "select-next-occurrence":
      return {
        primitive: "select-next-occurrence",
        label: step.label,
        script: axSelectNextOccurrenceScript(step.path ?? "", step.value ?? ""),
      };
    case "converge-weekdays":
      return {
        primitive: "converge-weekdays",
        label: step.label,
        // `value` is "<base index>|<Weekday>,<Weekday>…" — the base index is the
        // shape-selected group pop-up index of the first weekday row (RDLG2).
        script: axConvergeWeekdaysScript(
          step.path ?? "",
          weekdayBaseOf(step.value ?? ""),
          weekdayTitlesOf(step.value ?? ""),
        ),
      };
    case "wait":
      return { primitive: "wait", label: step.label, script: axResolveScript(step.path ?? "") };
    case "select-row":
      return {
        primitive: "select-row",
        label: step.label,
        script: axSelectRowScript(step.path ?? "", step.value ?? ""),
      };
    case "select-heading-row":
      return {
        primitive: "select-heading-row",
        label: step.label,
        script: axSelectHeadingRowScript(step.path ?? "", Number(step.value ?? "0")),
      };
    case "assert-eligible":
      return {
        primitive: "assert-eligible",
        label: step.label,
        script: axAssertEligibleScript(step.value ?? targetUuid, step.path ?? ""),
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

async function drive(
  recipe: UiRecipe,
  run: UiRunner,
  aux: UiDriveAux,
  budgetMs: number = DEFAULT_UI_DRIVE_BUDGET_MS,
  reachCache: ReachabilityProbeCache = createReachabilityCache(),
): Promise<ExecuteResult> {
  const done: string[] = [];
  // The overall-drive WATCHDOG (TRACE1 #487). A drive can outlast the caller's
  // own timeout on a slow production database (large + Things-Cloud syncing
  // commits the Repeat dialog several times slower than the lab golden), which
  // is how #487 fired: the caller's 30s kill left empty stdout and no retained
  // exit code. This budget lets the CLI give up FIRST — clearing any open dialog
  // and returning an honest, uncertain-outcome timeout — so the caller always
  // receives structured output. Checked between steps (per-step execFile
  // timeouts bound each osascript, so a step boundary is never far off).
  const driveStart = Date.now();
  const driveDeadline = driveStart + budgetMs;
  const overBudget = (): boolean => Date.now() >= driveDeadline;
  const watchdogResult = async (lastStep: string): Promise<ExecuteResult> => {
    // Attempt the SESSGATE dialog clearance so the watchdog never leaves a stuck
    // modal behind (#485), then report honestly. The outcome is UNCERTAIN: a rule
    // whose OK press was mid-commit could still land — the pipeline re-verifies
    // and shapes the final result accordingly.
    const clear = await clearDialog(run);
    trace(() => ({
      phase: "watchdog",
      budgetMs,
      elapsedMs: Date.now() - driveStart,
      lastStep,
      clear: clear.state,
      completed: done,
    }));
    return {
      exitCode: 1,
      stdout: `ui drive watchdog stopped after ${done.length} step(s): ${done.join(" → ") || "nothing"}`,
      stderr: `ui drive exceeded its ${Math.round(budgetMs / 1000)}s budget at "${lastStep}"`,
      timedOut: true,
      watchdog: {
        budgetMs,
        elapsedMs: Date.now() - driveStart,
        lastStep,
        clear: clear.state,
        tracePath: tracePath(),
      },
    };
  };
  // A note prepended to the success summary when the drive had to RELOCATE the
  // Things window to the current Space to open its dialog (SESSGATE wrong-Space
  // recovery) — surfaced to the caller as a disclosure warning.
  let relocationNote = "";
  // `clear`: how a half-open sheet was cleaned up after a failure (honest — never
  // claim a dismissal we could not see, SESSGATE #480); undefined = no sheet was
  // opened / no cleanup ran (a benign preamble/canary failure).
  const partial = (failed: string, why: string, clear?: ClearResult): ExecuteResult => {
    const base = `ui drive stopped at "${failed}" (${why}). Completed: ${done.join(" → ") || "nothing"}.`;
    const cleanup =
      clear === undefined
        ? ""
        : clear.state === "dismissed"
          ? " The open sheet/popover was dismissed (Escape, confirmed gone)."
          : clear.state === "cleared-blind"
            ? " Things had no window reachable on the current screen (the Mac may be locked, or a" +
              " full-screen app is covering the desktop), so the open dialog could not be confirmed" +
              " through the on-screen layer — the Things window was closed and reopened to clear it," +
              " discarding any partially-entered rule. Unlock the Mac or leave the full-screen app" +
              " before retrying."
            : " WARNING: a sheet or popover may still be open in Things — Escape did not dismiss it." +
              " Dismiss it manually before retrying (a leftover sheet disables the menu bar and will" +
              " make the next drive's preflight fail).";
    return refusal(base + cleanup);
  };

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

  // 0½. Session-reachability GATE for dialog-class ops (SESSGATE, #480). A recipe
  //     that opens a sheet on the main window needs that window AX-reachable on
  //     the current Space. Probed AFTER the preamble (which surfaces a window in a
  //     healthy session) and BEFORE the canary/press (no mutation yet): a locked /
  //     full-screen session REFUSES (blocked, zero mutation); a window merely on
  //     another Space is RELOCATED back and disclosed. Menu-only recipes skip this.
  if (recipe.needsWindowReachability === true) {
    const reach = await ensureWindowReachable(run, reachCache);
    if (!reach.ok) return blockedReachability(reach.verdict);
    if (reach.relocated) {
      relocationNote =
        "the Things window was on another desktop, so it was moved to the desktop you're viewing " +
        "to open the dialog. ";
    }
  }

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
      // (e) A leftover modal sheet/popover from an earlier aborted drive disables
      // the menu bar, so the Items ▸ Repeat path cannot resolve. Detect that
      // FIRST and name it as the likely cause, ahead of the generic
      // update/Accessibility/language guesses. Not auto-dismissed on a preflight:
      // the leftover sheet may hold a half-entered rule, and this refusal already
      // carries a clean remediation (the drive's own aborts DO dismiss+verify).
      if (await sheetStillOpen(run)) {
        return refusal(
          `ui preflight refused: element for "${label}" did not resolve (${path}). A modal sheet ` +
            "or popover is currently open in Things — most likely left over from an earlier drive " +
            "that aborted without dismissing it. An open sheet disables the menu bar, so the Repeat " +
            "menu path cannot resolve. Dismiss the open sheet in Things (Escape or Cancel), then " +
            "retry. Nothing was pressed.",
        );
      }
      return refusal(
        `ui preflight refused: element for "${label}" did not resolve (${path}) — a Things ` +
          "update may have changed the menu, Accessibility may not be granted, Things may not " +
          "be running, or the app may not be in English. Nothing was pressed.",
      );
    }
  }

  // 2. Execute the remaining steps in order; a dynamic element is waited-for.
  //
  // `dialogShape` is the Repeat dialog's MEASURED structure (RDLG2), set by the
  // recipe's `probe-dialog-shape` step and consumed by the steps that address a
  // control the 3.23 redesign moved or replaced. It stays null on every recipe
  // that never probes (no shape-dependent step), and any step that needs it while
  // it is null fails closed rather than guessing an index.
  let dialogShape: RepeatDialogShape | null = null;
  for (let i = idx; i < recipe.steps.length; i += 1) {
    let step = recipe.steps[i] as UiStep;
    // Shape-gated step: the recipe emits BOTH the legacy and the 3.23 drive for a
    // control whose CLASS changed, and only the matching one runs.
    if (step.onlyShape !== undefined) {
      if (dialogShape === null) {
        const clear = await clearDialog(run);
        return partial(step.label, SHAPE_UNPROBED, clear);
      }
      if (step.onlyShape !== dialogShape) continue;
    }
    // Shape-selected paths/values (the +1 index shift the 3.23 "Next:" pop-up
    // introduced, and the weekday-row base index).
    if (step.shaped !== undefined) {
      if (dialogShape === null) {
        const clear = await clearDialog(run);
        return partial(step.label, SHAPE_UNPROBED, clear);
      }
      const override = step.shaped[dialogShape];
      if (override === undefined) {
        const clear = await clearDialog(run);
        return partial(
          step.label,
          `this step has no drive for the "${dialogShape}" Repeat dialog (recipe bug)`,
          clear,
        );
      }
      step = { ...step, ...override };
    }
    // Overall-drive watchdog: if the budget is spent, stop at THIS step boundary
    // (the per-step execFile timeouts keep the boundary close), clear any open
    // dialog, and return the honest uncertain-outcome timeout (TRACE1 #487).
    if (overBudget()) return watchdogResult(step.label);
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
        // the abort keystroke must land (and be verified) before returning the partial-state report
        const clear = await clearDialog(run);
        return partial(step.label, "the expected element never appeared within the timeout", clear);
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "drag-reorder") {
      // The sidebar drag driver runs its own snapshot → scroll → drag →
      // DB-assert ladder (ui-drag.ts); every gesture anchors on frames it
      // resolves live, and a failed assert triggers a verified recovery drag.
      // No sheet is involved in a drag, so no dismissal clause.
      if (step.drag === undefined) return partial(step.label, "no drag spec compiled");
      // the drag ladder depends on the UI state the preamble produced
      const outcome = await driveSidebarAreaReorder(step.drag, run, aux);
      if (!outcome.ok) return partial(step.label, outcome.detail);
      done.push(`${step.label} (${outcome.detail})`);
      continue;
    }
    // Resolve a candidate-addressed step's effective element before dispatch
    // (the sheet-vs-detached-window disjunction). A miss fails closed.
    if (step.pathCandidates !== undefined) {
      // the effective form must be resolved before this step can act on it
      const effective = await resolveStepPath(step, run);
      if (effective === null) {
        // dismiss whatever opened (and verify) before reporting
        const clear = await clearDialog(run);
        return partial(
          step.label,
          "none of its expected element shapes resolved (neither the attached sheet nor the " +
            "detached repeat editor window)",
          clear,
        );
      }
      step = { ...step, path: effective };
    }
    const command = commandForStep(step, recipe.targetUuid);
    if (step.primitive === "probe-dialog-shape") {
      // MEASURE the dialog (RDLG2) before any shape-dependent control is touched.
      // A shape we do not recognize refuses the drive with the dialog cleared —
      // the same fail-closed posture as a canary miss, and for the same reason:
      // pressing a structural index into an unknown tree is how a GUI driver
      // writes the wrong rule.
      const res = await run(command, STEP_TIMEOUT_MS);
      const verdict = res.stdout.trim();
      if (!res.ok || (verdict !== "next-popup" && verdict !== "legacy")) {
        const clear = await clearDialog(run);
        return partial(
          step.label,
          res.ok
            ? 'its first-occurrence row ("Next:") holds neither an occurrence pop-up nor a date ' +
                "field, so the dialog matched neither known shape — a Things update has redesigned " +
                "it again; nothing was entered into the rule"
            : res.timedOut === true
              ? "the dialog-shape probe timed out"
              : res.stderr.trim() || "the dialog-shape probe failed",
          clear,
        );
      }
      dialogShape = verdict;
      done.push(`${step.label} (${verdict})`);
      continue;
    }
    if (step.primitive === "select-row" || step.primitive === "select-heading-row") {
      // Pure-AX row selection with readback verification (UIC4-a / HEADCERT1):
      // "OK" only when the intended row selected (title readback for a project
      // row; the Nth empty-readback heading row for a heading).
      // the selection must land before the menu that acts on it is pressed
      const res = await run(command, STEP_TIMEOUT_MS);
      if (!res.ok || res.stdout.trim() !== "OK") {
        // clear any transient state (and verify) before reporting
        const clear = await clearDialog(run);
        const noMatch =
          step.primitive === "select-heading-row"
            ? "the project view exposed no selectable heading row at the target position — the " +
              "heading may have been converted/deleted already, or the project's headings changed"
            : "no content-table row selected to the target project's title — it may not be a " +
              "selectable row in this view, or its title changed";
        return partial(
          step.label,
          res.ok
            ? noMatch
            : res.timedOut === true
              ? "the row-selection step timed out"
              : res.stderr.trim() || "the row-selection step failed",
          clear,
        );
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "assert-eligible") {
      // ADR1 (#480): fail EARLY + NAMED when the reveal did not land an eligible
      // selection, rather than letting a disabled-menu no-op surface downstream
      // as an opaque dialog-wait timeout. The script returns "OK" or a diagnostic
      // (NOTSEL…/WRONGSEL…/DISABLED…) that IS the human-readable failure reason.
      // the selection/enabled state must be confirmed before the menu is pressed
      const res = await run(command, STEP_TIMEOUT_MS);
      const verdict = res.stdout.trim();
      if (!res.ok || verdict !== "OK") {
        // clear any transient state (and verify) before reporting
        const clear = await clearDialog(run);
        return partial(
          step.label,
          res.ok
            ? verdict !== ""
              ? verdict
              : "the target to-do was not confirmed selected/eligible after the reveal"
            : res.timedOut === true
              ? "the eligibility check timed out"
              : res.stderr.trim() || "the eligibility check failed",
          clear,
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
        // clear whatever the click opened (honest cleanup) before reporting
        const clear = outcome.needsAbort === true ? await clearDialog(run) : undefined;
        return partial(step.label, outcome.why ?? "the click failed", clear);
      }
      done.push(step.label);
      continue;
    }
    // each recipe step depends on the UI state the previous step produced; they cannot be parallelized
    const res = await run(command, STEP_TIMEOUT_MS);
    if (!res.ok) {
      // clear the half-open sheet/popover (honest — never claim an unconfirmed
      // dismissal) before reporting partial state
      const clear =
        step.primitive !== "reveal" && step.primitive !== "activate"
          ? await clearDialog(run)
          : undefined;
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
        clear,
      );
    }
    done.push(step.label);
  }
  return {
    exitCode: 0,
    stdout: `${relocationNote}drove ${done.length} step(s): ${done.join(" → ")}`,
    stderr: "",
  };
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
  const budgetMs = config.ui.driveBudgetMs ?? DEFAULT_UI_DRIVE_BUDGET_MS;
  // Every osascript hop runs through the tracing seam: it notes the step on the
  // in-flight marker (for the signal handler) and, when tracing is on, records a
  // start/end pair with timing/outcome (TRACE1 #487).
  const tracedRun = tracingRun(run);
  // Intra-invocation reachability memo (PERF1), shared between the pre-seed gate
  // (probeReachability) and the in-drive gate (ensureWindowReachable) so a promote
  // composite does not probe the session — seconds-long on a busy desktop — twice.
  // The vector is rebuilt per client-open, so this is naturally scoped to one CLI
  // invocation; the memo's own TTL bounds reuse for a long-lived programmatic client.
  const reachCache = createReachabilityCache();
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
      return drive(invocation.recipe, tracedRun, aux, budgetMs, reachCache);
    },
    // Pre-seed gate seam for the promote orchestrators (SESSGATE, #480): probe the
    // live session BEFORE they seed a row, so a locked/full-screen session refuses
    // with zero mutation. Present regardless of `enabled` (the orchestrator has
    // already cleared the H-UI-DRIVE ack by the time it consults this). Populates
    // the memo the in-drive gate reuses (PERF1).
    probeReachability: () => reachCache.probe(tracedRun, STEP_TIMEOUT_MS),
  };
}
