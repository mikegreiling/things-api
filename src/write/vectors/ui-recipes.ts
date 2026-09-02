/**
 * Accessibility recipes for the ui vector — SEMANTIC element paths (System
 * Events), never coordinates. Each recipe is the ordered sequence of steps the
 * driver performs to effect one GUI-only transform.
 *
 * PROVISIONAL: every element path here is derived from the KNOWN Things menu
 * structure (UI1 / UI2 / UI2-i lab verdicts) but is UNCERTIFIED — not yet
 * confirmed against a live Accessibility tree. The one-time certification
 * sitting (docs/lab/ui-certification-runbook.md) confirms each path with the
 * Accessibility Inspector and records any AXIdentifier to prefer over the
 * pinned English title. Addressing is title-pinned English unless a step names
 * "axidentifier"; the driver resolves the STATIC (non-dynamic) paths in its
 * preflight canary and refuses if any is missing.
 *
 * Selection: every recipe starts by REVEALING its target via the documented
 * `things:///show?id=<uuid>` URL (navigation only — the GUI exposes no uuids to
 * address a row directly), then optionally ACTIVATES Things (a fallback skipped
 * once certification proves background AXPress works), then drives the menus /
 * dialogs / popovers with the Accessibility API.
 *
 * POSITIONAL ADDRESSING IS FENCED (CGRD1). Things' Accessibility tree is an
 * undocumented private surface that may be re-laid-out in any release, and #589
 * showed what a structural index costs when it is: the Repeat dialog INSERTS the
 * ends-count field ahead of the interval when an ends bound is selected, so
 * `text field 1 of group 1` silently wrote the requested interval into the count,
 * and the step's own read-back reported OK because it re-read the field it had
 * addressed. Every `<class> <N>` selector in this file therefore either carries a
 * `// positional-ok:` comment giving the measured reason it is safe, or it does
 * not exist — a value-bearing field is addressed by the LABEL ROW it sits on
 * (`set-group-number` / `set-row-field`), fail-closed on anything but exactly one
 * match. `test/unit/positional-addressing.test.ts` scans this file, ui.ts and
 * ui-drag.ts and fails on any new unjustified one. The marker is a claim about
 * MEASURED structure, not a silencer: it must name what was measured and where.
 */
import type {
  MonthlyAnchor,
  RepeatEnds,
  RepeatFrequency,
  Weekday,
  WeekdayOrdinal,
  YearlyAnchor,
} from "../operations.ts";
import type { HeadingChordSpec } from "./ui-chord.ts";
import type { SidebarPlacement } from "./ui-drag.ts";
import type { DialogAuditControl, UiRecipe, UiStep } from "./types.ts";

/**
 * The rule the Repeat dialog encodes — `frequency` + `interval` plus every
 * optional field of the UIC1 field map. A bare `{ frequency, interval }` drives
 * exactly the original two-control path (backward compatible). See operations.ts
 * `RepeatRuleParams` for the field semantics.
 */
export interface RepeatDialogRule {
  frequency: RepeatFrequency;
  interval: number;
  afterCompletion?: boolean;
  weekdays?: Weekday[];
  monthly?: MonthlyAnchor;
  yearly?: YearlyAnchor;
  ends?: RepeatEnds;
  reminder?: string;
  deadline?: boolean;
  startDaysEarlier?: number;
  /**
   * The requested FIRST occurrence (ISO `YYYY-MM-DD`), driven into the dialog's
   * "Next:" date field (ANCH2, issue #476). The default value of Next is the
   * app's today-anchored first match; overwriting it makes the series start on
   * the requested date verbatim (subsequent occurrences follow the rule). Omit
   * to accept the app default. Not applicable to after-completion (no calendar).
   */
  next?: string;
}

const ITEMS_MENU = `menu "Items" of menu bar 1`;

/**
 * The main Things window. Sheets (confirm dialogs, the Repeat dialog) attach
 * here — NOT to `window 1`, which is a 40×40 AXUnknown utility window that sits
 * at index 1 (UIC1). Address by subrole so it survives window-title changes as
 * the user navigates between lists.
 */
const MAIN_WINDOW = `(first window whose subrole is "AXStandardWindow")`;

/** Reveal + (fallback) activate — the common preamble of every recipe. */
function preamble(targetUuid: string): UiStep[] {
  return [
    {
      primitive: "reveal",
      label: "reveal the target in Things (things:///show?id=)",
      value: targetUuid,
    },
    {
      // MEASURED, and it stays (DRVLAT1 §5, issue #633). Background press IS
      // certified — with Finder frontmost the reveal selects, the Repeat menu
      // item reads enabled, AXPress opens the dialog and an element-addressed
      // pop-up drive lands. What does NOT work backgrounded is everything that
      // needs the screen: a `keystroke` into the interval field goes to whoever
      // owns it (measured: the field takes focus, the digit never arrives), and
      // the dialog the app opens in that state is the DETACHED editor, which
      // resisted every dismissal this project has — its own Cancel, Escape, ⌘W
      // and a real click at its Cancel frame (oddities §26). So the foreground is
      // needed both to type and to be able to abort.
      primitive: "activate",
      label: "bring Things to the foreground (its dialog takes keystrokes only in front)",
      activateFallback: true,
    },
  ];
}

/** A static menu-item press (canary-resolvable up front). */
function menuPress(label: string, path: string, canaryPath?: string): UiStep {
  return {
    primitive: "press",
    label,
    path,
    ...(canaryPath !== undefined && { canaryPath }),
    addressing: "title",
  };
}

const REPEAT_SUBMENU_ANCHOR = `menu item "Repeat" of ${ITEMS_MENU}`;

/**
 * Assert the reveal landed an eligible selection before pressing a menu item
 * (ADR1, issue #480). `menuItemPath` is the item whose `AXEnabled` gates the
 * action. Dynamic (its verdict depends on the runtime selection the reveal
 * produced), so it is never canaried; the driver surfaces a non-OK verdict as an
 * early, named failure instead of a downstream dialog-wait timeout.
 */
function assertEligible(targetUuid: string, menuItemPath: string): UiStep {
  return {
    primitive: "assert-eligible",
    label: "confirm the target to-do is selected and Items ▸ Repeat… is enabled",
    value: targetUuid,
    path: menuItemPath,
    dynamic: true,
    addressing: "title",
  };
}

/** Wait for a dynamic element (sheet/popover) to appear, then abort on timeout. */
function waitFor(label: string, path: string, timeoutMs = 5000): UiStep {
  return { primitive: "wait", label, path, timeoutMs, dynamic: true, addressing: "title" };
}

// --------------------------------------------------------------- tier 1

export function pauseRepeatRecipe(targetUuid: string): UiRecipe {
  return {
    op: "todo.pause-repeat",
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      menuPress(
        "Items ▸ Repeat ▸ Pause",
        `menu item "Pause" of menu 1 of menu item "Repeat" of ${ITEMS_MENU}`,
        REPEAT_SUBMENU_ANCHOR,
      ),
    ],
  };
}

/**
 * `Items ▸ Repeat ▸ Create Next Copy` — Things 3.23's "spawn the pending
 * occurrence now" command, and the first half of every template mutation we
 * ship (CNC1, docs/lab/cnc1-template-mutations.md).
 *
 * One press materializes the instance the projection cursor points at AND
 * advances the series, and the template delta is FIELD FOR FIELD what the app's
 * own `Make Exception` writes (`rt1_instanceCreationCount +1`,
 * `rt1_instanceCreationStartDate` → consumed slot + 1, `rt1_nextInstanceStartDate`
 * → the next rule date, `todayIndexReferenceDate` → the cursor, `umd` silent,
 * rule blob untouched) — measured on a fixed weekly rule against REPX3 §1.2 and
 * on a daily rule against §2.1. Mutating the minted instance afterwards is
 * therefore the exception the chooser withholds from automation.
 *
 * Template-only, like every verb in this submenu: with an INSTANCE selected the
 * `Items` menu carries no `Repeat` item at all (REPX1 §5.1), which is what the
 * eligibility assert catches before the press.
 */
export function createNextCopyRecipe(targetUuid: string): UiRecipe {
  const item = `menu item "Create Next Copy" of menu 1 of menu item "Repeat" of ${ITEMS_MENU}`;
  return {
    op: "todo.create-next-copy",
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      assertEligible(targetUuid, item),
      menuPress("Items ▸ Repeat ▸ Create Next Copy", item, REPEAT_SUBMENU_ANCHOR),
    ],
  };
}

export function resumeRepeatRecipe(targetUuid: string): UiRecipe {
  return {
    op: "todo.resume-repeat",
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      menuPress(
        "Items ▸ Repeat ▸ Resume",
        `menu item "Resume" of menu 1 of menu item "Repeat" of ${ITEMS_MENU}`,
        REPEAT_SUBMENU_ANCHOR,
      ),
    ],
  };
}

export function convertToProjectRecipe(
  op: "todo.convert-to-project" | "project.promote-heading",
  targetUuid: string,
): UiRecipe {
  return {
    op,
    targetUuid,
    needsWindowReachability: true,
    steps: [
      ...preamble(targetUuid),
      menuPress("Items ▸ Convert to Project…", `menu item "Convert to Project…" of ${ITEMS_MENU}`),
      // positional-ok: a window presents at most ONE attached sheet at a time, so
      // `sheet 1` is a uniqueness statement, not an index among peers. It is also
      // only ever a WAIT target here — the control acted on inside it is
      // AXIdentifier-addressed below.
      waitFor("the confirmation sheet", `sheet 1 of ${MAIN_WINDOW}`),
      {
        // The alert's primary button carries a stable, locale-proof
        // AXIdentifier "action-button-1" (UIC1); prefer it over the English title.
        // positional-ok: the `sheet 1` container is the one-sheet-per-window law
        // above; the BUTTON is discriminated by AXIdentifier, never by position.
        primitive: "press",
        label: 'confirm — press "Convert"',
        // positional-ok: `sheet 1` is the one attached sheet a window can present;
        // the BUTTON inside it is AXIdentifier-discriminated, never positional.
        path: `(first button of sheet 1 of ${MAIN_WINDOW} whose value of attribute "AXIdentifier" is "action-button-1")`,
        dynamic: true,
        addressing: "axidentifier",
      },
    ],
  };
}

/**
 * Convert a HEADING to a project (HEADCERT1). Unlike the to-do path, a heading
 * is not `things:///show`-selectable (the UIC1 blocker); instead the recipe
 * reveals the heading's PARENT PROJECT (whose view shows the heading as a
 * content-table row), selects the heading row by POSITION (the select-heading-
 * row primitive — positional because heading rows expose no stable AX title
 * handle), then drives the same `Items ▸ Convert to Project…` + confirm sheet
 * the to-do path uses. `projectUuid` is the owning project's uuid; `ordinal` is
 * the heading's 0-based position among the project's headings (`index` order).
 * DB effect (UI2-d / HEADCERT1): the heading uuid dies, a new type=1 project is
 * promoted into the parent project's area, its children reparent (heading→NULL).
 */
/**
 * Reorder a project's HEADINGS with the arrow chords (CHORDMH1, on the HEADORD1
 * law). Things exposes heading order through four bare keybindings and nothing
 * else — no menu item, no context-menu item, no AX action anywhere carries the
 * equivalent — so the recipe has no element to press: it reveals the project,
 * confirms the content table is there, and hands the whole move to the chord
 * driver, which selects each heading positionally and posts one verified chord
 * at a time (src/write/vectors/ui-chord.ts).
 *
 * NO `activate` step, deliberately. The reveal is a background `open -g`, the
 * row selection is pure System Events, and the chord is posted to the Things
 * PROCESS rather than to the focused surface — so the entire gesture runs with
 * Things behind whatever the user is looking at. Measured end to end on Things
 * 3.23 / golden-v4 with Finder frontmost at every stage and Things never
 * activated at all (docs/lab/chordmh1-move-heading-build.md §1).
 *
 * `needsWindowReachability` is set even though no sheet opens: the heading rows
 * only exist in a rendered project view, so a locked screen or a full-screen
 * Space must refuse (SESSGATE) rather than post chords at a window nothing can
 * read back.
 */
export function moveHeadingChordRecipe(
  projectUuid: string,
  targetOrder: string[],
  movees: string[],
): UiRecipe {
  const spec: HeadingChordSpec = {
    projectUuid,
    targetOrder,
    movees,
    tablePath: PROJECT_CONTENT_TABLE,
  };
  return {
    op: "project.move-heading",
    targetUuid: spec.projectUuid,
    needsWindowReachability: true,
    steps: [
      {
        primitive: "reveal",
        label: "reveal the project in Things (things:///show?id=<project>)",
        value: spec.projectUuid,
      },
      {
        // Canaried: if the project view's content table is not there, the drive
        // refuses before a single chord is posted.
        primitive: "resolve",
        label: "confirm the project view's content table is present",
        path: PROJECT_CONTENT_TABLE,
        addressing: "title",
      },
      {
        primitive: "chord-reorder",
        label: `reorder ${spec.movees.length} heading(s) with the arrow chords`,
        chord: spec,
      },
    ],
  };
}

export function headingConvertToProjectRecipe(projectUuid: string, ordinal: number): UiRecipe {
  return {
    op: "project.promote-heading",
    targetUuid: projectUuid,
    needsWindowReachability: true,
    steps: [
      {
        primitive: "reveal",
        label: "reveal the heading's project in Things (things:///show?id=<project>)",
        value: projectUuid,
      },
      {
        // Not needed for correctness (pure-AX row select + menu press are
        // background-capable, no focus steal) — a fallback only.
        primitive: "activate",
        label: "bring Things to the foreground (skipped once background AX is certified)",
        activateFallback: true,
      },
      {
        primitive: "select-heading-row",
        label: `select the heading row (position ${ordinal + 1} among the project's headings)`,
        path: PROJECT_CONTENT_TABLE,
        value: String(ordinal),
        addressing: "title",
      },
      // With the heading selected, Convert to Project… is enabled (it exists
      // regardless, so the canary resolves it; the press lands post-selection).
      menuPress("Items ▸ Convert to Project…", `menu item "Convert to Project…" of ${ITEMS_MENU}`),
      // positional-ok: one attached sheet per window (see convertToProjectRecipe).
      waitFor("the confirmation sheet", `sheet 1 of ${MAIN_WINDOW}`),
      {
        // The alert's primary button carries the locale-proof AXIdentifier
        // "action-button-1" (UIC1); prefer it over the English title.
        // positional-ok: one attached sheet per window; the button itself is
        // AXIdentifier-discriminated.
        primitive: "press",
        label: 'confirm — press "Convert"',
        // positional-ok: `sheet 1` is the one attached sheet a window can present;
        // the BUTTON inside it is AXIdentifier-discriminated, never positional.
        path: `(first button of sheet 1 of ${MAIN_WINDOW} whose value of attribute "AXIdentifier" is "action-button-1")`,
        dynamic: true,
        addressing: "axidentifier",
      },
    ],
  };
}

// The to-do stop-repeat recipe was REMOVED (roadmap build item 4): it never
// certified (its Stop popover lives only on the open card, reachable only by a
// mouse double-click — UIC1/UIC2-d) and no project.stop-repeat is built either
// (the project Stop then selecting the demoted project crashes Things — CRASH1
// / oddities §7 C5). See docs/design/ax-initiative.md and docs/design/ui-vector.md.

// --------------------------------------------------------------- tier 2
//
// The Repeat dialog is the SAME editor for a to-do and a project, and it
// presents in TWO forms: an attached `AXSheet` when Things is frontmost, and a
// DETACHED top-level `AXUnknown` window when backgrounded (UIC4-a). Its controls
// sit at the same container depth in both (UIC5-e), so every control is
// addressed by BOTH shapes (`pathCandidates`) and the driver dispatches against
// whichever resolves. The frequency pop-up + interval field + OK button were
// LAB-CERTIFIED (UIC1/UIC5); the full-vocabulary controls below (weekday set,
// monthly/yearly anchors, Ends bound, reminders/deadlines) are now LAB-CERTIFIED
// too (UIC6, 2026-07-15) — the sitting corrected their structural indices
// wholesale (the field-map best-guess was wrong; see docs/lab/uic6-rule-vocabulary.md).
// The reminder-time control is undrivable (its AXDateTimeArea ignores AX writes),
// so `--reminder` is refused upstream in assertRepeatRule; its recipe step is
// retained but unreachable.

/** The content list's table (row 0 = area/Someday header, then projects/to-dos). Confirmed UIC5.
 *  positional-ok: a CONTAINER handle only — the main window's list area holds one
 *  scroll area holding one table (UIC5), and no value is read or written through
 *  this path. Every step that uses it resolves its target WITHIN the table by
 *  title readback (select-row), by selection-readback ordinal (select-heading-row)
 *  or by exact AXDescription (click-element's rowCellDescription walk, HXPC1 §B0). */
const PROJECT_CONTENT_TABLE = `table 1 of scroll area 1 of ${MAIN_WINDOW}`;
/** The Repeat editor when Things is frontmost — an attached sheet (interval nested in group 1, UIC1).
 *  positional-ok: a window presents at most ONE attached sheet at a time, so
 *  `sheet 1` names the only sheet there can be rather than picking among peers. */
const REPEAT_SHEET = `sheet 1 of ${MAIN_WINDOW}`;
/** The Repeat editor when Things is backgrounded — a detached AXUnknown window (UIC4-a). Its
 *  controls sit at the SAME depth as the sheet's (frequency a direct child, interval in group 1) — UIC5-e. */
const REPEAT_DETACHED = `(first window whose subrole is "AXUnknown" and size is not {40, 40})`;

/** The two dialog shells (sheet | detached window), in priority order. */
const DIALOG_SHELLS = [REPEAT_SHEET, REPEAT_DETACHED];

/** Address `inner` (an element specifier) inside BOTH dialog shells. */
function dualForm(inner: string): string[] {
  return DIALOG_SHELLS.map((shell) => `${inner} of ${shell}`);
}

// --- CERTIFIED controls (UIC1/UIC5) --------------------------------------
//
// WHY THE POP-UPS BELOW MAY STAY POSITIONAL WHILE THE TEXT FIELDS MAY NOT.
// A pop-up drive is SELF-DISCRIMINATING: `select-popup` opens the control and
// clicks a menu item matched by its pinned English NAME, so a mis-addressed
// pop-up has no such item and the step fails closed ("none of the candidate menu
// items exist"). A text field accepts any string silently — which is precisely
// how #589 wrote an interval into the ends-count field. The pop-up label sets are
// also disjoint across the cadence group (`never`/`after`/`on date` for the ends
// bound; `day(s)`…`year(s)` for the after-completion unit; weekday names, ordinals
// and month names for the anchors), so a swapped index cannot land a plausible
// value. Belt and braces: the PRE-COMMIT AUDIT re-reads every one of them by value
// before the OK press, so a pop-up that took a wrong-but-existing item is caught
// before anything is committed.
/** Frequency pop-up — a direct child of the dialog.
 *  positional-ok: MEASURED sole direct-child pop-up of the dialog shell in every
 *  reachable state — the shell carries `popups=1`, every other pop-up living in the
 *  cadence group (CGRD1 §B census, all four frequencies + after-completion). Its
 *  menu items are matched by name, and the pre-commit audit re-reads its value. */
const DIALOG_FREQUENCY = dualForm("pop up button 1");
/** OK button. */
const DIALOG_OK = dualForm(`button "OK"`);

// --- UIC6-CERTIFIED controls, RE-INDEXED PER DIALOG SHAPE (RDLG2) ----------
// The dialog's rule controls (except the reminder/end-date pickers) all live in
// the cadence AXGroup (`group 1`); UIC6 sat the live tree and fixed the
// provisional structural indices, and RDLG2 re-derived them for Things 3.23.
// The invariant that makes them addressable is unchanged — the "Ends" pop-up is
// ALWAYS `pop up button 1 of group 1` and the per-frequency pop-ups follow it —
// but 3.23 inserted the new `Next:` occurrence pop-up between the two, shifting
// every per-frequency index by +1. Both index sets ship, keyed to the SHAPE the
// driver measures in the open dialog (`probe-dialog-shape`), never to the app
// version. Titles/`_NS:` ids are never used (both drift). Evidence:
// docs/lab/uic6-rule-vocabulary.md (≤3.22) and docs/lab/rdlg2-323-recipe-cert.md.
/** After-completion cadence unit pop-up — the ONLY group pop-up in that mode (both shapes).
 *  positional-ok: this and DIALOG_ENDS are the SAME spelling because they are the
 *  same slot in two MUTUALLY EXCLUSIVE dialog states, and the recipe emits exactly
 *  one of them per drive. Measured (CGRD1 §A census): an after-completion cadence
 *  group has `popups=1` and no `Ends:` label at all, while every fixed frequency
 *  puts the ends bound at group pop-up 1. Their menu-item sets are disjoint
 *  (`day(s)`…`year(s)` vs `never`/`after`/`on date`), so a wrong-state drive fails
 *  closed on the item name; the pre-commit audit re-reads whichever one ran. */
const DIALOG_AC_UNIT = dualForm("pop up button 1 of group 1");
/** "Ends" bound pop-up (`never` · `after` · `on date`) — always pop up button 1 of the group.
 *  positional-ok: see DIALOG_AC_UNIT — one slot, two exclusive states, name-matched
 *  items, audited before the commit. */
const DIALOG_ENDS = dualForm("pop up button 1 of group 1");
/** The cadence group itself — the handle the shape probe and the weekday converge address.
 *  positional-ok: MEASURED sole group of the dialog shell (`groups=1` in every
 *  state, CGRD1 §B), and a CONTAINER handle only — every primitive that takes it
 *  (set-group-number, probe-dialog-shape, converge-weekdays, audit-dialog)
 *  discriminates WITHIN it by label row or control class and fails closed on
 *  anything but exactly one match. */
const DIALOG_GROUP = dualForm("group 1");
/** The 3.23 `Next:` first-occurrence pop-up — group pop-up 2 (this shape only).
 *  positional-ok: reachable ONLY under a MEASURED dialog shape — the recipe's
 *  probe-dialog-shape step must have returned `next-popup` (a positive match on the
 *  control class occupying the `Next:` row) before this step runs, and an
 *  unrecognized shape refuses the drive. The drive then matches a menu item by
 *  PARSED DATE and reads the pop-up back; the pre-commit audit re-parses it. */
const DIALOG_NEXT_POPUP = dualForm("pop up button 2 of group 1");

/** A group pop-up addressed at DIFFERENT indices in the two dialog shapes (RDLG2).
 *  positional-ok: the index is not a guess but the MEASURED consequence of the
 *  shape the drive probed — CGRD1 §A counts the cadence group's pop-ups per
 *  frequency on 3.23 (daily 2 · weekly 3 · monthly 4 · yearly 5, i.e. Ends + Next +
 *  the per-frequency controls), which is the +1 fork these two index sets encode.
 *  A step carrying `shaped` with no shape probed fails closed. Every one of these
 *  is a name-matched pop-up, and all of them are re-read by the pre-commit audit. */
function shapedPopup(nextPopupIndex: number, legacyIndex: number): NonNullable<UiStep["shaped"]> {
  return {
    // positional-ok: shape-MEASURED index, per this function's contract above.
    "next-popup": { pathCandidates: dualForm(`pop up button ${nextPopupIndex} of group 1`) },
    // positional-ok: shape-MEASURED index, per this function's contract above.
    legacy: { pathCandidates: dualForm(`pop up button ${legacyIndex} of group 1`) },
  };
}

/** Monthly MODE pop-up (`day` · Sunday…Saturday) — after Ends (+ Next on 3.23). */
const DIALOG_MONTH_MODE = shapedPopup(3, 2);
/** Monthly ORDINAL pop-up (`last` · 1st…31st). */
const DIALOG_MONTH_ORDINAL = shapedPopup(4, 3);
/** Yearly MONTH pop-up, then its mode + ordinal. */
const DIALOG_YEAR_MONTH = shapedPopup(3, 2);
const DIALOG_YEAR_MODE = shapedPopup(4, 3);
const DIALOG_YEAR_ORDINAL = shapedPopup(5, 4);
/**
 * The group pop-up index of the FIRST weekday row, per shape — the one input the
 * weekday-converge loop needs beyond the target set (it derives the row count and
 * the add button from live structure).
 */
const WEEKDAY_BASE: Record<"next-popup" | "legacy", number> = { "next-popup": 3, legacy: 2 };
/** "Add reminders" checkbox (sheet-level, title-pinned). The time is an AXDateTimeArea driven by set-datetime. */
const DIALOG_ADD_REMINDERS = dualForm(`checkbox "Add reminders"`);
/** "Add deadlines" checkbox + the "and start [n] days earlier" offset field it reveals. */
const DIALOG_ADD_DEADLINES = dualForm(`checkbox "Add deadlines"`);
/**
 * The pinned English static text whose ROW the start-offset field sits on. The
 * field shipped as `text field 1` of the dialog shell — a value-bearing numeric
 * field picked by index out of a tree whose shape depends on the "Add deadlines"
 * checkbox, verified only by re-reading the same index it wrote. That is the #589
 * error class, and it happened to be right rather than provably right: measured on
 * 3.23, the shell carries 0 direct text fields with deadlines OFF and exactly 1
 * with them ON — `[and start] [ 0 ] [days earlier]`, the field at y=409 against the
 * label's y=413 — whether or not reminders are also on (CGRD1 §B census). Now the
 * field is found by that label's row, exactly like the cadence numbers, and
 * anything but one match on it fails closed with the shell's field inventory.
 */
const DIALOG_START_EARLIER_LABEL = "days earlier";

/**
 * After-completion cadence-unit pop-up labels. The options are NOT the frequency
 * word (`weekly`) — they are the time unit, and the app PLURALIZES them by the
 * interval: `week` at interval 1, `weeks` at interval > 1 (0½ defect (c)). The
 * reschedule dialog opens pre-populated with the item's CURRENT interval, so a
 * biweekly template's unit pop-up already reads the plural before the interval
 * field is touched. Both labels are offered as select-popup candidates so the
 * drive is plural-safe and order-independent (the driver clicks whichever
 * exists). Singular first — the interval-1 case and the make-repeating default.
 */
const FREQ_TO_AC_UNIT: Record<RepeatFrequency, [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

/** English display titles for the weekday / ordinal / month pop-ups (title-pinned, locale fail-closed). */
const WEEKDAY_TITLE: Record<Weekday, string> = {
  sunday: "Sunday",
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
};
const ORDINAL_TITLE: Record<Exclude<WeekdayOrdinal, "last">, string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
  4: "4th",
  5: "5th",
};
const MONTH_TITLE = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function ordinalTitle(ordinal: WeekdayOrdinal): string {
  return ordinal === "last" ? "last" : ORDINAL_TITLE[ordinal];
}

function selectPopup(label: string, pathCandidates: string[], value: string): UiStep {
  return {
    primitive: "select-popup",
    label,
    pathCandidates,
    value,
    dynamic: true,
    addressing: "title",
  };
}
/**
 * A select-popup whose group INDEX depends on the dialog shape (RDLG2) — the
 * driver substitutes the measured shape's candidates before dispatch, and refuses
 * if the shape was never measured.
 */
function selectPopupShaped(
  label: string,
  shaped: NonNullable<UiStep["shaped"]>,
  value: string,
): UiStep {
  return { primitive: "select-popup", label, shaped, value, dynamic: true, addressing: "title" };
}
/**
 * A select-popup that clicks the FIRST of several candidate menu-item LABELS
 * that exists (the after-completion unit's singular/plural pair — defect (c)).
 */
function selectPopupAny(
  label: string,
  pathCandidates: string[],
  valueCandidates: string[],
): UiStep {
  return {
    primitive: "select-popup",
    label,
    pathCandidates,
    valueCandidates,
    dynamic: true,
    addressing: "title",
  };
}
/**
 * Drive a dialog-SHELL text field addressed by the pinned English label sharing
 * its row — the {@link setGroupNumber} discrimination law, applied outside the
 * cadence group. Its one caller is the start-days-earlier offset; see
 * {@link DIALOG_START_EARLIER_LABEL} for why the old `text field 1` spelling had
 * to go even though it resolved correctly on 3.23.
 */
function setRowField(label: string, rowLabel: string, value: string): UiStep {
  return {
    primitive: "set-row-field",
    label,
    pathCandidates: DIALOG_SHELLS,
    rowLabel,
    value,
    dynamic: true,
    addressing: "title",
  };
}
/**
 * Drive one of the Repeat dialog's TWO numeric fields — the cadence interval
 * ("Every [n] days") or the "Ends: after [n] times" count. Both are text fields
 * of the cadence group, and WHICH INDEX each holds depends on the dialog's
 * state rather than on which one the caller means. Measured on Things 3.23
 * (HXPC1, docs/lab/hxpc1-picker-assert.md §A):
 *
 *   Ends: never   →  1 text field  ·  #1 interval @[311,283]
 *   Ends: after N →  2 text fields ·  #1 COUNT    @[402,372]  (`Ends:` label y=375)
 *                                     #2 interval @[311,283]  (`Every` label y=286)
 *
 * Both used to be spelled `text field 1 of group 1`, which the create path
 * survived only because it drives the interval BEFORE selecting the ends bound,
 * while it is still the sole field. A RESCHEDULE opens the dialog PRE-POPULATED:
 * a rule that already ends after N presents both fields from the first step, so
 * the interval drive wrote the requested interval into the count field and the
 * count drive then overwrote it — the interval never changed. The driver now
 * resolves each field by the ROW it sits on (the count shares the `Ends:`
 * label's row, the interval does not), which is order-independent and covers the
 * after-completion dialog too: that one offers no ends bound at all, so the
 * interval is again the only field. See ui.ts `axSetGroupNumberScript`.
 */
function setGroupNumber(
  label: string,
  numberTarget: "interval" | "ends-count",
  value: string,
  cadence?: { afterCompletion: boolean; endsAfter: boolean },
): UiStep {
  return {
    primitive: "set-group-number",
    label,
    pathCandidates: DIALOG_GROUP,
    numberTarget,
    value,
    ...(cadence !== undefined && { cadence }),
    dynamic: true,
    addressing: "title",
  };
}
function pressControl(label: string, pathCandidates: string[]): UiStep {
  return { primitive: "press", label, pathCandidates, dynamic: true, addressing: "title" };
}
/**
 * Converge a dialog checkbox to `target` via the deterministic closed-loop
 * ensure-checkbox primitive (RRD1) — read, press only on a mismatch, confirm.
 * Replaces the old blind `pressControl`, which flipped an already-correct box on a
 * PRE-POPULATED reschedule dialog (the live bug: a blind "Add deadlines" press
 * unchecked an already-deadlined rule, hiding the start-earlier field). Emitted
 * ONLY for a checkbox the caller actually addressed; an unspecified deadline/
 * reminder emits no step, so the pre-populated state is preserved (#492).
 */
function ensureCheckbox(label: string, pathCandidates: string[], target: boolean): UiStep {
  return {
    primitive: "ensure-checkbox",
    label,
    pathCandidates,
    checkboxTarget: target,
    dynamic: true,
    addressing: "title",
  };
}
/**
 * Set ONE of the dialog's date/time pickers (Next first-occurrence / end-date
 * bound / reminder time). Each is an `AXDateTimeArea` located by role within the
 * front dialog, so it carries no element path — the driver's set-datetime
 * primitive selects DETERMINISTICALLY by `target` (ANCH2: reminder = the
 * time-bearing area; next = top midnight picker; ends = bottom midnight picker),
 * never "the first area by role". `spec` is `time:HH:mm` or `date:YYYY-MM-DD`.
 */
function setDateTime(label: string, spec: string, target: "next" | "ends" | "reminder"): UiStep {
  return {
    primitive: "set-datetime",
    label,
    value: spec,
    dtTarget: target,
    dynamic: true,
    addressing: "title",
  };
}

/** Steps that drive the day anchor of a monthly rule into the mode + ordinal pop-ups. */
function monthlyAnchorSteps(
  anchor: MonthlyAnchor,
  mode: NonNullable<UiStep["shaped"]>,
  ordinal: NonNullable<UiStep["shaped"]>,
): UiStep[] {
  if ("day" in anchor) {
    // mode = "day"; ordinal names the day-of-month (or "last").
    return [
      selectPopupShaped("monthly mode = day", mode, "day"),
      selectPopupShaped(
        `monthly day = ${anchor.day}`,
        ordinal,
        anchor.day === "last" ? "last" : ORDINAL_TITLE_ANY(anchor.day),
      ),
    ];
  }
  return [
    selectPopupShaped(`monthly weekday = ${anchor.weekday}`, mode, WEEKDAY_TITLE[anchor.weekday]),
    selectPopupShaped(`monthly ordinal = ${anchor.ordinal}`, ordinal, ordinalTitle(anchor.ordinal)),
  ];
}

/** Day-of-month ordinal display (1st…31st). */
function ORDINAL_TITLE_ANY(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * Build the ordered dialog-entry steps for the FULL rule vocabulary, every
 * control addressed in BOTH dialog forms. A bare `{ frequency, interval }`
 * emits exactly the certified frequency → interval → OK path; each optional
 * field appends its own control steps before OK.
 */
function repeatDialogEntry(rule: RepeatDialogRule): UiStep[] {
  // WAIT FOR THE DIALOG AND CENSUS IT IN THE SAME HOP (RDLAT2). The step used to
  // wait on one control resolving; it now reports WHICH shell opened (so no later
  // step re-discovers that, and the pre-commit audit needs no resolution hop) and
  // the shell's control census, which the shape manifest checks before anything is
  // pressed. It is addressed at the SHELLS rather than at a control inside one —
  // the census is a property of the shell.
  const steps: UiStep[] = [
    {
      primitive: "dialog-open",
      label: "the Repeat dialog",
      pathCandidates: DIALOG_SHELLS,
      dynamic: true,
      timeoutMs: 5000,
      addressing: "title",
    },
  ];

  if (rule.afterCompletion === true) {
    // "after completion" is the first frequency-pop-up option; picking it reveals
    // a secondary unit pop-up ("after completion, every N <unit>").
    steps.push(selectPopup("frequency = after completion", DIALOG_FREQUENCY, "after completion"));
    steps.push(
      selectPopupAny(
        `after-completion unit = ${rule.frequency}`,
        DIALOG_AC_UNIT,
        FREQ_TO_AC_UNIT[rule.frequency],
      ),
    );
  } else {
    steps.push(selectPopup(`frequency = ${rule.frequency}`, DIALOG_FREQUENCY, rule.frequency));
  }

  // The interval runs BEFORE any ends bound is selected, so the cadence group is
  // expected to hold exactly one numeric field here — and the frequency step just
  // above has rebuilt it, which is precisely the transition the manifest lets the
  // settle wait for positively (RDLAT2).
  steps.push(
    setGroupNumber(`interval = ${rule.interval}`, "interval", String(rule.interval), {
      afterCompletion: rule.afterCompletion === true,
      endsAfter: false,
    }),
  );

  // MEASURE the dialog before touching any control the 3.23 redesign moved
  // (RDLG2). Emitted only when such a control is actually addressed, so the
  // certified two-control path (frequency + interval + OK) costs no extra hop —
  // and so an after-completion rule, whose cadence group has neither an Ends nor
  // a Next label to measure, never runs a probe that could only say "unknown".
  const needsShape =
    rule.afterCompletion !== true &&
    ((rule.weekdays !== undefined && rule.weekdays.length > 0) ||
      rule.monthly !== undefined ||
      rule.yearly !== undefined ||
      rule.next !== undefined);
  if (needsShape) {
    steps.push({
      primitive: "probe-dialog-shape",
      label:
        "measure the Repeat dialog's shape (an occurrence pop-up on the Next: row, or a date field)",
      pathCandidates: DIALOG_GROUP,
      dynamic: true,
      addressing: "title",
    });
  }

  if (rule.weekdays !== undefined && rule.weekdays.length > 0) {
    // ONE closed-loop converge (RRD1 fix) rather than "set row 1, then press +
    // and re-drive the same index": the old shape left a PRE-POPULATED dialog's
    // existing weekdays in the rule and could never shrink a set. The driver
    // reads the live rows, grows to the target count, assigns every row from the
    // target set (cycling), and reads them all back. See ui.ts
    // axConvergeWeekdaysScript for the loop and its evidence.
    const titles = rule.weekdays.map((day) => WEEKDAY_TITLE[day]).join(",");
    steps.push({
      primitive: "converge-weekdays",
      label: `weekdays = ${rule.weekdays.join(", ")}`,
      pathCandidates: DIALOG_GROUP,
      shaped: {
        "next-popup": { value: `${WEEKDAY_BASE["next-popup"]}|${titles}` },
        legacy: { value: `${WEEKDAY_BASE.legacy}|${titles}` },
      },
      dynamic: true,
      addressing: "title",
    });
  }

  if (rule.monthly !== undefined) {
    steps.push(...monthlyAnchorSteps(rule.monthly, DIALOG_MONTH_MODE, DIALOG_MONTH_ORDINAL));
  }

  if (rule.yearly !== undefined) {
    const y: YearlyAnchor = rule.yearly;
    steps.push(
      selectPopupShaped(
        `yearly month = ${y.month}`,
        DIALOG_YEAR_MONTH,
        MONTH_TITLE[y.month - 1] ?? "",
      ),
    );
    steps.push(...monthlyAnchorSteps(y, DIALOG_YEAR_MODE, DIALOG_YEAR_ORDINAL));
  }

  // LET THE `Next:` POP-UP ABSORB THE RULE (NEXTPOP1) before any further input.
  //
  // The 3.23 dialog recomputes its first-occurrence pop-up — the displayed date
  // AND the menu of occurrences behind it — ASYNCHRONOUSLY, ~0.4s after the
  // calendar anchor moves, and an input that lands inside that window CANCELS
  // the recompute permanently: the control keeps describing the PREVIOUS rule.
  // The very next thing this recipe drives is the deadline checkbox, which is
  // exactly such an input, so every deadlined monthly/yearly promote reached
  // `select-next-occurrence` with the SEED's occurrence series in the menu and
  // failed closed on a date the rule really does produce (VMRES1 §4.3).
  //
  // Emitted for the pop-up shape only — the ≤3.22 `Next:` is a free date area
  // with no menu to recompute — and never for after-completion, which has no
  // first-occurrence control at all. It is a WAIT, not a setter, so it
  // contributes no control to the pre-commit audit.
  if (needsShape && rule.afterCompletion !== true) {
    steps.push({
      primitive: "settle-occurrences",
      label: "let the first-occurrence pop-up absorb the rule",
      pathCandidates: DIALOG_NEXT_POPUP,
      onlyShape: "next-popup",
      dynamic: true,
      addressing: "title",
    });
  }

  // "Add deadlines" / "start N days earlier" — DEADLINE MODE, converged (RRD1)
  // BEFORE the "Next:" field is driven below. In deadline mode the "Next:" field IS
  // the deadline date and the instance start = deadline − startDaysEarlier (YANCH1
  // #493), so the deadline-date shift `deadlineDriveNext` computes must be applied
  // against the CONVERGED checkbox state; a box flipped AFTER Next was driven (the
  // old order) changed Next's meaning under an already-committed value — the live
  // bug where a blind press on an already-deadlined reschedule dialog UNCHECKED the
  // box and hid the start-earlier field. Converging the checkbox reveals only a
  // NUMBER field ("start N days earlier"), never a date area (YANCH1 census), so it
  // does not perturb the date-area targeting the ends/Next drives below rely on.
  //
  // Target (requested-fields-only, #492): an explicit `deadline` converges to it; a
  // bare `startDaysEarlier > 0` implies deadline:true; an UNSPECIFIED deadline emits
  // NO step, PRESERVING the pre-populated checkbox state (a reschedule that does not
  // address the deadline leaves it exactly as it was).
  const deadlineTarget: boolean | undefined =
    rule.deadline !== undefined
      ? rule.deadline
      : (rule.startDaysEarlier ?? 0) > 0
        ? true
        : undefined;
  if (deadlineTarget !== undefined) {
    steps.push(ensureCheckbox("Add deadlines", DIALOG_ADD_DEADLINES, deadlineTarget));
    // startDaysEarlier is requested-fields-only too: drive the offset field only
    // when it was given (>0), else leave it at its pre-populated value.
    if (deadlineTarget && (rule.startDaysEarlier ?? 0) > 0) {
      steps.push(
        setRowField(
          `start ${rule.startDaysEarlier} days earlier`,
          DIALOG_START_EARLIER_LABEL,
          String(rule.startDaysEarlier),
        ),
      );
    }
  }

  // Ends bound + "Next:" first-occurrence field (ANCH2, issue #476). ORDER MATTERS:
  // select "Ends: on date" FIRST (revealing its date area) BEFORE driving Next, so
  // both date areas already exist when each is set through its own deterministic
  // target. Driving Next while it is the SOLE date area and THEN adding the ends
  // area collapses the whole series to the ends date (ANCH2 RC4); selecting the
  // ends bound first — the proven-clean order (cell d) — keeps them distinct.
  const endsOnDate = rule.ends !== undefined && rule.ends.kind === "on-date" ? rule.ends : null;
  if (rule.ends !== undefined && rule.ends.kind === "after") {
    steps.push(selectPopup("ends = after", DIALOG_ENDS, "after"));
    // The `after` bound INSERTS the count ahead of the interval (HXPC1/#589), so
    // the group is expected to hold TWO numeric fields from here on — the exact
    // transition whose completion the settle can now wait for positively.
    steps.push(
      setGroupNumber(`ends after = ${rule.ends.count}`, "ends-count", String(rule.ends.count), {
        afterCompletion: false,
        endsAfter: true,
      }),
    );
  } else if (endsOnDate !== null) {
    steps.push(selectPopup("ends = on date", DIALOG_ENDS, "on date"));
  }

  // After-completion has no calendar, so no Next. The control's CLASS differs by
  // dialog shape, so BOTH drives are emitted and the driver runs the one that
  // matches what it measured (RDLG2):
  //   - legacy (≤3.22): a free-form `AXDateTimeArea` — ANY date, on-rule or not;
  //   - next-popup (3.23+): a bounded MENU of the rule's own occurrences, so an
  //     off-rule first occurrence is UNREACHABLE and the step fails closed with
  //     the reason (the app removed the affordance; we do not fake it by picking
  //     a neighbouring date).
  if (rule.next !== undefined && rule.afterCompletion !== true) {
    steps.push({
      ...setDateTime(`Next (first occurrence) = ${rule.next}`, `date:${rule.next}`, "next"),
      onlyShape: "legacy",
    });
    steps.push({
      primitive: "select-next-occurrence",
      label: `Next (first occurrence) = ${rule.next}`,
      pathCandidates: DIALOG_NEXT_POPUP,
      value: rule.next,
      onlyShape: "next-popup",
      dynamic: true,
      addressing: "title",
    });
  }

  if (endsOnDate !== null) {
    steps.push(setDateTime(`ends on = ${endsOnDate.date}`, `date:${endsOnDate.date}`, "ends"));
  }

  // "Add reminders" — converged (RRD1), then its time driven. Kept AFTER the Next/
  // ends date drives (its ANCH2-certified position): a freshly-checked reminder
  // area defaults to a NON-midnight 12:00 (ANCH2 census), so the set-datetime
  // tod discriminator never confuses it with the midnight Next/ends pickers,
  // whatever the creation order. Requested-fields-only (#492): an unspecified
  // reminder emits NO step, PRESERVING the pre-populated checkbox + time. (The rule
  // vocabulary carries no "reminder off", so the only requested target is checked.)
  if (rule.reminder !== undefined) {
    steps.push(ensureCheckbox("Add reminders", DIALOG_ADD_REMINDERS, true));
    steps.push(setDateTime(`reminder = ${rule.reminder}`, `time:${rule.reminder}`, "reminder"));
  }

  // The pre-commit audit COMMITS for itself when there is one (RDLAT2): the OK
  // press is still a step of the recipe — it is named in the trail and it is what
  // the driver reports — but it runs inside the audit's own script, so nothing can
  // change between the last read and the press. A recipe that drove no control has
  // no audit, and its press stays a hop of its own.
  const audit = dialogAuditStep(steps, {
    afterCompletion: rule.afterCompletion === true,
    endsAfter: rule.ends !== undefined && rule.ends.kind === "after",
  });
  if (audit !== null) steps.push(audit);
  steps.push(pressControl('press "OK"', DIALOG_OK));
  return steps;
}

/**
 * Build the PRE-COMMIT FULL-DIALOG AUDIT step from the drive's OWN step list
 * (CGRD1) — the last thing that runs before the OK press.
 *
 * Derivation from the steps, rather than a second hand-written list of controls,
 * is the point: every setter the recipe emits contributes exactly one audit
 * control, so a rule field added to `repeatDialogEntry` is audited the moment it
 * is driven, and a control can never be silently left out. It also means the audit
 * addresses each control through the SAME candidate paths / shape overrides / row
 * anchors the drive used, so the two can never disagree about what was touched.
 *
 * Why it is needed at all: each setter's own read-back is SELF-REFERENTIAL — it
 * re-reads the element it addressed, so it proves the keystrokes landed where they
 * were aimed and nothing more. #589 was a wrong ADDRESS, invisible to that check.
 * The audit is the outside view; any mismatch aborts the drive fail-closed before
 * anything is committed.
 *
 * Steps that set nothing (waits, the menu press, the shape probe, the OK press)
 * contribute nothing; a recipe that drove no control at all yields no audit step.
 */
function weekdayBaseOfEncoded(value: string): number {
  const base = Number(value.split("|", 1)[0]);
  return Number.isFinite(base) && base > 0 ? Math.trunc(base) : 2;
}

/** The per-shape PATH overrides of a step, in the audit control's shape. */
function shapedPaths(
  step: UiStep,
): Partial<Record<"next-popup" | "legacy", { pathCandidates?: string[] }>> | undefined {
  if (step.shaped === undefined) return undefined;
  return {
    ...(step.shaped["next-popup"]?.pathCandidates !== undefined && {
      "next-popup": { pathCandidates: step.shaped["next-popup"].pathCandidates },
    }),
    ...(step.shaped.legacy?.pathCandidates !== undefined && {
      legacy: { pathCandidates: step.shaped.legacy.pathCandidates },
    }),
  };
}

function dialogAuditStep(
  steps: UiStep[],
  cadence?: { afterCompletion: boolean; endsAfter: boolean },
): UiStep | null {
  const controls: DialogAuditControl[] = [];
  for (const step of steps) {
    const base = {
      label: step.label,
      ...(step.onlyShape !== undefined && { onlyShape: step.onlyShape }),
    };
    switch (step.primitive) {
      case "select-popup": {
        const shaped = shapedPaths(step);
        controls.push({
          ...base,
          kind: "popup",
          ...(step.pathCandidates !== undefined && { pathCandidates: step.pathCandidates }),
          ...(shaped !== undefined && { shaped }),
          // valueCandidates carries the singular/plural pair the app pluralizes by
          // interval; ANY of them satisfies, exactly as the drive accepted any.
          expected: step.valueCandidates ?? [step.value ?? ""],
        });
        break;
      }
      case "set-group-number":
        controls.push({
          ...base,
          kind: "group-number",
          numberTarget: step.numberTarget ?? "interval",
          expected: [step.value ?? ""],
        });
        break;
      case "set-row-field":
        controls.push({
          ...base,
          kind: "row-field",
          rowLabel: step.rowLabel ?? "",
          expected: [step.value ?? ""],
        });
        break;
      case "ensure-checkbox":
        controls.push({
          ...base,
          kind: "checkbox",
          ...(step.pathCandidates !== undefined && { pathCandidates: step.pathCandidates }),
          expected: [step.checkboxTarget === true ? "1" : "0"],
          expectedLabel: step.checkboxTarget === true ? "checked" : "unchecked",
        });
        break;
      case "converge-weekdays": {
        // The weekday step encodes "<base>|<Weekday>,<Weekday>…" per dialog shape
        // (the base is the group pop-up index of the first weekday row, which the
        // +1 fork moves). The audit reads every row pop-up from that base and
        // compares as a SET: the converge law assigns EVERY row from the target set
        // cycling, so a surplus row duplicates a target weekday rather than keeping
        // a stale one, and set equality is the exact property to check.
        const nextValue = step.shaped?.["next-popup"]?.value;
        const legacyValue = step.shaped?.legacy?.value;
        const encoded = nextValue ?? legacyValue;
        if (encoded === undefined) break;
        const titles = encoded
          .slice(encoded.indexOf("|") + 1)
          .split(",")
          .filter((t) => t !== "");
        if (titles.length === 0) break;
        controls.push({
          ...base,
          kind: "weekdays",
          expected: titles,
          expectedLabel: titles.join(" + "),
          shaped: {
            ...(nextValue !== undefined && {
              "next-popup": { weekdayBase: weekdayBaseOfEncoded(nextValue) },
            }),
            ...(legacyValue !== undefined && {
              legacy: { weekdayBase: weekdayBaseOfEncoded(legacyValue) },
            }),
          },
        });
        break;
      }
      case "select-next-occurrence":
        controls.push({
          ...base,
          kind: "occurrence-popup",
          ...(step.pathCandidates !== undefined && { pathCandidates: step.pathCandidates }),
          expected: [step.value ?? ""],
        });
        break;
      case "set-datetime":
        controls.push({
          ...base,
          kind: "date-area",
          dtTarget: step.dtTarget ?? "next",
          dtSpec: step.value ?? "",
        });
        break;
      default:
        break;
    }
  }
  if (controls.length === 0) return null;
  return {
    primitive: "audit-dialog",
    label: "audit the Repeat dialog against the requested rule (before committing)",
    audit: {
      shells: DIALOG_SHELLS,
      groups: DIALOG_GROUP,
      controls,
      commits: DIALOG_OK,
      ...(cadence !== undefined && { cadence }),
    },
    dynamic: true,
    addressing: "title",
  };
}

/** The optional extended-vocabulary fields a recipe threads into the dialog. */
export type RepeatRuleExtras = Omit<RepeatDialogRule, "frequency" | "interval">;

export function makeRepeatingRecipe(
  targetUuid: string,
  frequency: RepeatFrequency,
  interval: number,
  extras: RepeatRuleExtras = {},
): UiRecipe {
  return {
    op: "todo.make-repeating",
    targetUuid,
    needsWindowReachability: true,
    steps: [
      ...preamble(targetUuid),
      // ADR1 (#480): the reveal is assumed to select the to-do row, but on some
      // surfaces it can navigate without selecting — and an AXPress on the
      // resulting DISABLED Repeat… item silently no-ops, so the dialog never
      // opens and the drive died opaquely at the dialog-wait timeout. Assert the
      // eligible selection FIRST, failing early + named on a miss.
      assertEligible(targetUuid, `menu item "Repeat…" of ${ITEMS_MENU}`),
      menuPress("Items ▸ Repeat…", `menu item "Repeat…" of ${ITEMS_MENU}`),
      ...repeatDialogEntry({ frequency, interval, ...extras }),
    ],
  };
}

// ------------------------------------------------- make-repeating a PROJECT
//
// A project has no things:///show handle that selects it as a to-do (the reveal
// URL selects to-dos only, UIC1). UIC4 found the pure-AX path: reveal the
// project's CONTAINER (its AREA view, or the SOMEDAY view for an area-less
// someday project), then select the project as a content-table ROW (UIC4-a) —
// coordinate-free, background-capable, no focus steal. With the row selected,
// `Items ▸ Repeat…` is present + enabled and opens the SAME Repeat dialog as the
// to-do op. An area-less ANYTIME project has no selectable row (it renders as a
// header, UIC4-d) — the orchestrator coerces it to Someday first, so the recipe
// only ever handles the area / someday cases.

/**
 * Make a PROJECT repeating (UIC4-f). `containerReveal` is the AREA uuid whose
 * view renders the project as a row, or the literal "someday" for an area-less
 * someday project; `title` is matched against the row's selection readback.
 * The area-less-anytime case is handled by the orchestrator (Someday coercion)
 * BEFORE this recipe runs, so it always reveals an area or the Someday view.
 */
export function projectMakeRepeatingRecipe(
  containerReveal: string,
  projectUuid: string,
  title: string,
  frequency: RepeatFrequency,
  interval: number,
  extras: RepeatRuleExtras = {},
): UiRecipe {
  return {
    op: "project.make-repeating",
    targetUuid: projectUuid,
    needsWindowReachability: true,
    steps: [
      {
        primitive: "reveal",
        label: `reveal the container in Things (things:///show?id=${containerReveal})`,
        value: containerReveal,
      },
      {
        // Not needed for correctness (pure AX is background-capable), a fallback only.
        primitive: "activate",
        label: "bring Things to the foreground (skipped once background AX is certified)",
        activateFallback: true,
      },
      {
        primitive: "select-row",
        label: `select the project row for "${title}" (AXSelectedRows)`,
        path: PROJECT_CONTENT_TABLE,
        value: title,
        addressing: "title",
      },
      // Items ▸ Repeat… materializes only once the row is selected (UIC1) — so it
      // is waited-for + pressed dynamically, not resolved in the canary.
      {
        primitive: "wait",
        label: "Items ▸ Repeat… (enabled once the project row is selected)",
        path: `menu item "Repeat…" of ${ITEMS_MENU}`,
        dynamic: true,
        timeoutMs: 5000,
        addressing: "title",
      },
      {
        primitive: "press",
        label: "Items ▸ Repeat…",
        path: `menu item "Repeat…" of ${ITEMS_MENU}`,
        dynamic: true,
        addressing: "title",
      },
      ...repeatDialogEntry({ frequency, interval, ...extras }),
    ],
  };
}

export function rescheduleRepeatRecipe(
  targetUuid: string,
  frequency: RepeatFrequency,
  interval: number,
  extras: RepeatRuleExtras = {},
): UiRecipe {
  return {
    op: "todo.reschedule-repeat",
    targetUuid,
    needsWindowReachability: true,
    steps: [
      ...preamble(targetUuid),
      // The submenu itself is still canaried (it only materializes on a selected
      // TEMPLATE, so its presence is the real precondition) …
      {
        primitive: "resolve",
        label: "Items ▸ Repeat submenu",
        path: REPEAT_SUBMENU_ANCHOR,
        addressing: "title",
      },
      // … but the ITEM was RENAMED: `Reschedule…` through Things 3.22, `Edit
      // Rule…` from 3.23 (RDLG1). Both spellings ship as candidates so the drive
      // self-selects on whichever the installed app offers; neither present is a
      // fail-closed miss naming the step.
      {
        primitive: "press",
        label: "Items ▸ Repeat ▸ Edit Rule… (Reschedule… on Things ≤ 3.22)",
        pathCandidates: [
          `menu item "Edit Rule…" of menu 1 of menu item "Repeat" of ${ITEMS_MENU}`,
          `menu item "Reschedule…" of menu 1 of menu item "Repeat" of ${ITEMS_MENU}`,
        ],
        dynamic: true,
        addressing: "title",
      },
      ...repeatDialogEntry({ frequency, interval, ...extras }),
    ],
  };
}

// --------------------------------------------------- repeating-PROJECT ops
//
// A repeating project has no Items ▸ Repeat submenu (a shown project is not a
// selected to-do — UIC2). Instead its view carries an always-visible REPEAT BAR
// (`text area 2` of the header cell); clicking it opens a custom popover
// [Change… · Pause↔Resume · Stop · Show Latest]. The bar is AX-resolvable and
// the popover items are AX-READABLE but INERT to AXPress (UIC2), so they are
// actuated with a synthetic MOUSE click at their AX-resolved frame center
// (the NATIVE1 primitive) — never a guessed pixel. The Repeat dialog the
// Change… item opens is a sheet, byte-identical to the to-do dialog, and is
// driven with pure AX (reusing repeatDialogEntry). NO project.stop-repeat is
// built: the project Stop then selecting the demoted project crashes Things
// (CRASH1 / oddities §7 C5).
//
// PROVISIONAL element paths (pending UIC3 certification): the header cell, the
// repeat bar, the popover, and the popover items are best-guess structural
// paths derived from the UIC2 AX inventory; the certification pass confirms or
// corrects them exactly as the to-do recipes were corrected in UIC1.

/** The header cell of the project view (row 1 of the content table).
 *  positional-ok: the project view's header IS its first content-table row by
 *  construction (UIC2/UIC3) — the row the app renders above the item list — and
 *  this path only ever reaches a CLICK target, never a value. */
const PROJECT_HEADER_CELL = `UI element 1 of row 1 of table 1 of scroll area 1 of ${MAIN_WINDOW}`;
/** The always-visible repeat bar of a repeating project (UIC2/UIC3: text area 2).
 *  positional-ok: the bar carries no title or description to address it by (UIC2),
 *  so its index in the header cell is the only handle the app offers. It is not a
 *  value-bearing field: the step that uses it is a click whose `assertPath` REQUIRES
 *  the repeat popover to appear afterwards, so a click that lands on the wrong text
 *  area fails closed (Escape + abort) instead of cascading into blind presses. */
const PROJECT_REPEAT_BAR = `text area 2 of ${PROJECT_HEADER_CELL}`;
/**
 * The popover opened by clicking the repeat bar. Confirmed by UIC3 discovery: it
 * is a SEPARATE AXUnknown top-level window (≈215×220), NOT a `pop over` of the
 * standard window — the same custom-window shape UIC2 found for the `…` menu.
 * Two AXUnknown windows exist while it is open (the popover + a hidden 40×40
 * utility window), so it is addressed by subrole AND by not being that 40×40
 * utility window; its items live in the window's scroll area.
 */
const PROJECT_REPEAT_POPOVER = `(first window whose subrole is "AXUnknown" and size is not {40, 40})`;
// positional-ok: a CONTAINER handle only — these custom AXUnknown popovers hold
// exactly one scroll area (MEASURED on the sibling Move… picker, HXPC1 §B2:
// `scroll areas=1`), and every item inside is addressed by exact AXDescription.
const PROJECT_REPEAT_POPOVER_ITEMS = `scroll area 1 of ${PROJECT_REPEAT_POPOVER}`;

/** A project view + foreground preamble — the mouse segment needs Things frontmost. */
function projectPreamble(targetUuid: string): UiStep[] {
  return [
    {
      primitive: "reveal",
      label: "reveal the project in Things (things:///show?id=)",
      value: targetUuid,
    },
    {
      // NOT a fallback here: the repeat-bar/popover clicks are synthesized mouse
      // input, which lands only on the foreground app (NATIVE1-e).
      primitive: "activate",
      label: "bring Things to the foreground (the pointer must reach its repeat bar)",
    },
  ];
}

/** Click the always-visible repeat bar to open the [Change…/Pause/Stop/…] popover. */
function openProjectRepeatPopover(): UiStep {
  return {
    primitive: "click-element",
    label: "open the project's repeat menu (click the repeat bar)",
    path: PROJECT_REPEAT_BAR,
    assertPath: PROJECT_REPEAT_POPOVER,
    assertLabel: "the repeat menu",
    assertTimeoutMs: 5000,
    addressing: "title",
  };
}

/** Click a popover item by its AX description (frame-resolved, AXPress is inert). */
function popoverItemClick(
  label: string,
  description: string,
  assert?: { path: string; label: string },
): UiStep {
  return {
    primitive: "click-element",
    label,
    path: `(first UI element of ${PROJECT_REPEAT_POPOVER_ITEMS} whose description is "${description}")`,
    // The popover only exists after openProjectRepeatPopover ran, so this is not
    // canary-resolvable up front; its frame is resolved (fail-closed) at run time.
    dynamic: true,
    ...(assert !== undefined && {
      assertPath: assert.path,
      assertLabel: assert.label,
      assertTimeoutMs: 5000,
    }),
    addressing: "title",
  };
}

export function projectPauseRepeatRecipe(targetUuid: string): UiRecipe {
  return {
    op: "project.pause-repeat",
    targetUuid,
    steps: [
      ...projectPreamble(targetUuid),
      openProjectRepeatPopover(),
      popoverItemClick("repeat menu ▸ Pause", "Pause"),
    ],
  };
}

export function projectResumeRepeatRecipe(targetUuid: string): UiRecipe {
  return {
    op: "project.resume-repeat",
    targetUuid,
    steps: [
      ...projectPreamble(targetUuid),
      openProjectRepeatPopover(),
      popoverItemClick("repeat menu ▸ Resume", "Resume"),
    ],
  };
}

export function projectRescheduleRepeatRecipe(
  targetUuid: string,
  frequency: RepeatFrequency,
  interval: number,
  extras: RepeatRuleExtras = {},
): UiRecipe {
  return {
    op: "project.reschedule-repeat",
    targetUuid,
    needsWindowReachability: true,
    steps: [
      ...projectPreamble(targetUuid),
      openProjectRepeatPopover(),
      popoverItemClick("repeat menu ▸ Change…", "Change…", {
        // positional-ok: a post-click EXISTENCE assert on the one attached sheet a
        // window can present; nothing is read or written through this path.
        path: `sheet 1 of ${MAIN_WINDOW}`,
        label: "the Repeat dialog",
      }),
      ...repeatDialogEntry({ frequency, interval, ...extras }),
    ],
  };
}

// ------------------------------------ cross-project heading move (HEADXPROJ)
//
// A heading relocates (with its children) to a DIFFERENT project via the heading
// row's `…` ellipsis → Move… menu → a keyboard-driven project picker (HEADXPROJ,
// reordgaps-results.md). No headless spelling exists on any vector. The heading
// `…` button is an AXUnknown whose AXDescription CARRIES the title
// (`"More. <title>"`), so — unlike the promote drive's positional row-select —
// the row is TITLE-addressable; but AXPress on it is INERT (§8j), so it is
// HID-clicked at its frame center (the click-element primitive), like the project
// repeat popover. The popover (Archive / Move… / Convert to Project… / Delete) is
// the same custom AXUnknown-window shape as the repeat popover.
//
// CERTIFIED by HXPC1 (2026-08-25, Things 3.23 / golden-v4 —
// docs/lab/hxpc1-picker-assert.md), which corrected three of the four provisional
// paths the way UIC1 corrected the repeat recipes:
//   * the `…` button is three levels below the content table, so no `whose`
//     clause can reach it (§B0) — the click resolves it by walking rows/cells;
//   * the picker is a DETACHED `MovePopUpDialog-` window, not a sheet of the main
//     window (§B2), and its filter field is not addressable as a child of it;
//   * the commit is a CLICK on the destination row, never a Return — the picker
//     publishes no highlight to read back, and its `New Project "<typed>"` row
//     turns an absent destination into a newly created project (§B4).
// The popover-item enumeration (`whose description is "Move…"`) was the one
// provisional path that measured correct: those items are direct children of the
// popover's scroll area.

/**
 * The heading `…` "More. <title>" button. It carries the heading's title in its
 * `AXDescription`, but it sits at `UI element N of cell 1 of row M` of the
 * content table — three levels down — and a `whose` clause searches only DIRECT
 * children, so the button is NOT addressable as a path. The click step names the
 * table here and the description separately (`rowCellDescription`), and the
 * driver walks rows → cells → children for the exact match (HXPC1 §B0; the
 * one-level spelling this replaces matched nothing on 3.23, which is why every
 * ellipsis drive died at its own frame resolution).
 */
function headingMoreDescription(headingTitle: string): string {
  return `More. ${headingTitle}`;
}
/** The ellipsis popover — a custom AXUnknown window (same shape as the repeat popover). */
const HEADING_ELLIPSIS_POPOVER = `(first window whose subrole is "AXUnknown" and size is not {40, 40})`;
// positional-ok: container handle only — one scroll area per popover (HXPC1 §B2),
// items addressed by exact AXDescription.
const HEADING_POPOVER_ITEMS = `scroll area 1 of ${HEADING_ELLIPSIS_POPOVER}`;
/**
 * The Move… project picker. NOT a sheet of the main window (the shape this
 * recipe first assumed) — a DETACHED top-level window of the same custom
 * `AXUnknown` class as the ellipsis popover, distinguished by an `AXIdentifier`
 * beginning `MovePopUpDialog-` (HXPC1 §B2). The popover that opened it is gone
 * by the time it appears, so the generic detached-window selector resolves it
 * unambiguously; the row-commit script re-checks the identifier before clicking
 * anything, so a different detached window can never be committed into.
 */
const HEADING_MOVE_PICKER = `(first window whose subrole is "AXUnknown" and size is not {40, 40})`;
/**
 * What proves the detached window that appeared IS the picker and not the
 * ellipsis popover it replaced: the picker carries a direct child described
 * `Move` (its header), the popover carries only its item list. Without this the
 * post-click assert would be satisfied by the popover that was already open —
 * i.e. by the click having done nothing (HXPC1 §B2).
 */
const HEADING_MOVE_PICKER_MARKER = `(first UI element of ${HEADING_MOVE_PICKER} whose description is "Move")`;

/**
 * Move a HEADING to a different project via the ellipsis `Move…` menu (HEADXPROJ).
 * `sourceProjectUuid` is revealed to render the heading row; `headingTitle` is the
 * `"More. <title>"` click target; `destProjectTitle` narrows the picker's list and
 * then names the row that is CLICKED to commit. DB effect (HEADXPROJ): the heading
 * row's `project` FK becomes the destination; its children follow via their intact
 * heading FK (a single-row change — no child rewrite, no index churn).
 *
 * The commit used to be a Return pressed BLIND on whatever the filter had
 * highlighted, which is how a move could CREATE a project instead of performing
 * one: the picker offers a trailing `New Project "<typed text>"` row, and it omits
 * completed and canceled projects entirely — so a destination our pre-state had
 * resolved from the database could be absent from the picker, leaving that row as
 * the only offer. Measured on Things 3.23: the heading landed in a brand-new
 * second project of the same name (HXPC1 §B4). The picker publishes no selection
 * or highlight attribute on any row, so there is nothing to read back from a
 * keyboard commit; the recipe therefore addresses the destination row by its exact
 * title and clicks it, and fails closed — naming every row the picker offered —
 * when that row is absent, duplicated, or scrolled out of view.
 */
export function moveHeadingToProjectRecipe(
  sourceProjectUuid: string,
  headingTitle: string,
  destProjectTitle: string,
): UiRecipe {
  return {
    op: "project.move-heading-to-project",
    targetUuid: sourceProjectUuid,
    needsWindowReachability: true,
    steps: [
      {
        primitive: "reveal",
        label: "reveal the source project in Things (things:///show?id=)",
        value: sourceProjectUuid,
      },
      {
        // NOT a fallback: the ellipsis + popover clicks are synthesized mouse
        // input, which lands only on the foreground app (NATIVE1-e).
        primitive: "activate",
        label: "bring Things to the foreground (the pointer must reach the heading row)",
      },
      {
        primitive: "click-element",
        label: `open the heading's ellipsis menu ("More. ${headingTitle}")`,
        path: PROJECT_CONTENT_TABLE,
        rowCellDescription: headingMoreDescription(headingTitle),
        assertPath: HEADING_ELLIPSIS_POPOVER,
        assertLabel: "the heading ellipsis menu",
        assertTimeoutMs: 5000,
        dynamic: true,
        addressing: "title",
      },
      {
        primitive: "click-element",
        label: "ellipsis menu ▸ Move…",
        path: `(first UI element of ${HEADING_POPOVER_ITEMS} whose description is "Move…")`,
        assertPath: HEADING_MOVE_PICKER_MARKER,
        assertLabel: "the Move… project picker",
        assertTimeoutMs: 5000,
        dynamic: true,
        addressing: "title",
      },
      {
        // The picker focuses its own filter field as it opens, and that field is
        // not addressable as a child of the picker window — so the destination is
        // typed at the focus. Nothing is committed on the strength of the
        // keystroke: the next step resolves the destination row by name.
        primitive: "type-text",
        label: `narrow the Move… picker to "${destProjectTitle}"`,
        value: destProjectTitle,
        dynamic: true,
        addressing: "title",
      },
      {
        primitive: "click-picker-row",
        label: `commit the Move… picker on the "${destProjectTitle}" row`,
        path: HEADING_MOVE_PICKER,
        value: destProjectTitle,
        dynamic: true,
        addressing: "title",
      },
    ],
  };
}

/**
 * Dissolve a HEADING via the ellipsis `Delete` menu item (DISS1). Same
 * `"More. <title>"` reveal as the cross-project move, driving Delete instead of
 * Move…. DB effect (DISS1): the heading row is HARD-DELETED while its children
 * become DIRECT project children (heading→NULL, project→parent, index preserved,
 * NOT trashed) — no confirm sheet, so the Delete click is TERMINAL (the write
 * pipeline's read-after-write is the verifier). The popover's Delete item is
 * AX-description-enumerable and scoped to the popover so it never matches the
 * main window's toolbar Delete.
 */
export function dissolveHeadingRecipe(projectReveal: string, headingTitle: string): UiRecipe {
  return {
    op: "project.dissolve-heading",
    targetUuid: projectReveal,
    steps: [
      {
        primitive: "reveal",
        label: "reveal the heading's project in Things (things:///show?id=)",
        value: projectReveal,
      },
      {
        // NOT a fallback: the ellipsis + popover clicks are synthesized mouse
        // input, which lands only on the foreground app (NATIVE1-e).
        primitive: "activate",
        label: "bring Things to the foreground (the pointer must reach the heading row)",
      },
      {
        primitive: "click-element",
        label: `open the heading's ellipsis menu ("More. ${headingTitle}")`,
        path: PROJECT_CONTENT_TABLE,
        rowCellDescription: headingMoreDescription(headingTitle),
        assertPath: HEADING_ELLIPSIS_POPOVER,
        assertLabel: "the heading ellipsis menu",
        assertTimeoutMs: 5000,
        dynamic: true,
        addressing: "title",
      },
      {
        // Terminal click — DISS1 confirmed NO confirmation sheet, the heading
        // dissolves immediately; the read-after-write verifies (heading gone).
        primitive: "click-element",
        label: "ellipsis menu ▸ Delete (dissolve — children become direct project children)",
        path: `(first UI element of ${HEADING_POPOVER_ITEMS} whose description is "Delete")`,
        dynamic: true,
        addressing: "title",
      },
    ],
  };
}

// ------------------------------------------------- sidebar AREA reorder

/**
 * Move an area to a new sidebar position (AXDRAG1/AXDRAG2). The single
 * drag-reorder step is a COMPOSITE the driver expands into snapshot → scroll →
 * drag → database-assert cycles (src/write/vectors/ui-drag.ts); there is no
 * static element path to canary — the drag driver fails closed on its own
 * frame resolution before any synthesis. Foreground-bound (HID drag).
 */
export function areaReorderSidebarRecipe(
  target: { uuid: string; title: string },
  placement: SidebarPlacement,
): UiRecipe {
  const destination =
    placement.kind === "before"
      ? `above "${placement.title}"`
      : placement.kind === "after"
        ? `below "${placement.title}"`
        : placement.kind === "first"
          ? "to the top of the area list"
          : "to the bottom of the area list";
  return {
    op: "area.reorder",
    targetUuid: target.uuid,
    steps: [
      {
        // NOT a fallback: the drag is synthesized mouse input, which lands
        // only on the foreground app (NATIVE1-e).
        primitive: "activate",
        label: "bring Things to the foreground (the pointer must reach the sidebar)",
      },
      {
        primitive: "drag-reorder",
        label: `drag the area "${target.title}" ${destination}`,
        dynamic: true,
        drag: { targetUuid: target.uuid, targetTitle: target.title, placement },
      },
    ],
  };
}
