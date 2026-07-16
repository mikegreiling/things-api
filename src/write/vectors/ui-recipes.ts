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
 */
import type {
  MonthlyAnchor,
  RepeatEnds,
  RepeatFrequency,
  Weekday,
  WeekdayOrdinal,
  YearlyAnchor,
} from "../operations.ts";
import type { SidebarPlacement } from "./ui-drag.ts";
import type { UiRecipe, UiStep } from "./types.ts";

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
      primitive: "activate",
      label: "bring Things to the foreground (skipped once background press is certified)",
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
  op: "todo.convert-to-project" | "heading.convert-to-project",
  targetUuid: string,
): UiRecipe {
  return {
    op,
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      menuPress("Items ▸ Convert to Project…", `menu item "Convert to Project…" of ${ITEMS_MENU}`),
      waitFor("the confirmation sheet", `sheet 1 of ${MAIN_WINDOW}`),
      {
        // The alert's primary button carries a stable, locale-proof
        // AXIdentifier "action-button-1" (UIC1); prefer it over the English title.
        primitive: "press",
        label: 'confirm — press "Convert"',
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

/** The content list's table (row 0 = area/Someday header, then projects/to-dos). Confirmed UIC5. */
const PROJECT_CONTENT_TABLE = `table 1 of scroll area 1 of ${MAIN_WINDOW}`;
/** The Repeat editor when Things is frontmost — an attached sheet (interval nested in group 1, UIC1). */
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
/** Frequency pop-up — a direct child of the dialog. */
const DIALOG_FREQUENCY = dualForm("pop up button 1");
/** Interval field — nested in group 1 (UIC5-e). */
const DIALOG_INTERVAL = dualForm("text field 1 of group 1");
/** OK button. */
const DIALOG_OK = dualForm(`button "OK"`);

// --- UIC6-CERTIFIED controls (corrected from the field-map best-guess) ---
// The dialog's rule controls (except the reminder/end-date pickers) all live in
// the cadence AXGroup (`group 1`); UIC6 sat the live tree and fixed the
// provisional structural indices. The invariant that made them addressable:
// the "Ends" pop-up is ALWAYS `pop up button 1 of group 1`, so the per-frequency
// pop-ups follow it (weekday=2; monthly mode=2/ordinal=3; yearly month=2/mode=3/
// ordinal=4). Titles/`_NS:` ids are never used (both drift). See
// docs/lab/uic6-rule-vocabulary.md for the per-control evidence.
/** After-completion cadence unit pop-up — the ONLY group pop-up in that mode. */
const DIALOG_AC_UNIT = dualForm("pop up button 1 of group 1");
/** Weekly day-of-week pop-up — pop up button 2 (Ends is pop up button 1). */
const DIALOG_WEEKDAY = dualForm("pop up button 2 of group 1");
/** Weekly "+" button that adds a weekday row (title-less AXButton — button 1 of the group). */
const DIALOG_ADD_WEEKDAY = dualForm("button 1 of group 1");
/** Monthly MODE pop-up (`day` · Sunday…Saturday) — pop up button 2. */
const DIALOG_MONTH_MODE = dualForm("pop up button 2 of group 1");
/** Monthly ORDINAL pop-up (`last` · 1st…31st) — pop up button 3. */
const DIALOG_MONTH_ORDINAL = dualForm("pop up button 3 of group 1");
/** Yearly MONTH pop-up — pop up button 2 (Ends 1, then month/mode/ordinal). */
const DIALOG_YEAR_MONTH = dualForm("pop up button 2 of group 1");
const DIALOG_YEAR_MODE = dualForm("pop up button 3 of group 1");
const DIALOG_YEAR_ORDINAL = dualForm("pop up button 4 of group 1");
/** "Ends" bound pop-up (`never` · `after` · `on date`) — always pop up button 1 of the group. */
const DIALOG_ENDS = dualForm("pop up button 1 of group 1");
/** "Ends after [n]" count field — becomes text field 1 of the group once shown (interval was set earlier while it was the sole field). */
const DIALOG_ENDS_COUNT = dualForm("text field 1 of group 1");
/** "Add reminders" checkbox (sheet-level, title-pinned). The time is an AXDateTimeArea driven by set-datetime. */
const DIALOG_ADD_REMINDERS = dualForm(`checkbox "Add reminders"`);
/** "Add deadlines" checkbox + the "start N days earlier" field it reveals as a DIRECT sheet child (text field 1 of the shell). */
const DIALOG_ADD_DEADLINES = dualForm(`checkbox "Add deadlines"`);
const DIALOG_START_EARLIER = dualForm("text field 1");

/** After-completion unit pop-up options are singular (`day`/`week`/…), not the frequency word. */
const FREQ_TO_AC_UNIT: Record<RepeatFrequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
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
function setField(label: string, pathCandidates: string[], value: string): UiStep {
  return {
    primitive: "set-value",
    label,
    pathCandidates,
    value,
    dynamic: true,
    addressing: "title",
  };
}
function pressControl(label: string, pathCandidates: string[]): UiStep {
  return { primitive: "press", label, pathCandidates, dynamic: true, addressing: "title" };
}
/**
 * Set the dialog's date/time picker (reminder time / end-date bound). The
 * control is an `AXDateTimeArea` located by role within the front dialog (UIC6),
 * so it carries no element path — the driver's set-datetime primitive finds it.
 * `spec` is `time:HH:mm` or `date:YYYY-MM-DD`.
 */
function setDateTime(label: string, spec: string): UiStep {
  return { primitive: "set-datetime", label, value: spec, dynamic: true, addressing: "title" };
}

/** Steps that drive the day anchor of a monthly rule into the mode + ordinal pop-ups. */
function monthlyAnchorSteps(anchor: MonthlyAnchor, mode: string[], ordinal: string[]): UiStep[] {
  if ("day" in anchor) {
    // mode = "day"; ordinal names the day-of-month (or "last").
    return [
      selectPopup("monthly mode = day", mode, "day"),
      selectPopup(
        `monthly day = ${anchor.day}`,
        ordinal,
        anchor.day === "last" ? "last" : ORDINAL_TITLE_ANY(anchor.day),
      ),
    ];
  }
  return [
    selectPopup(`monthly weekday = ${anchor.weekday}`, mode, WEEKDAY_TITLE[anchor.weekday]),
    selectPopup(`monthly ordinal = ${anchor.ordinal}`, ordinal, ordinalTitle(anchor.ordinal)),
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
  const steps: UiStep[] = [
    {
      primitive: "wait",
      label: "the Repeat dialog",
      pathCandidates: DIALOG_FREQUENCY,
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
      selectPopup(
        `after-completion unit = ${rule.frequency}`,
        DIALOG_AC_UNIT,
        FREQ_TO_AC_UNIT[rule.frequency],
      ),
    );
  } else {
    steps.push(selectPopup(`frequency = ${rule.frequency}`, DIALOG_FREQUENCY, rule.frequency));
  }

  steps.push(setField(`interval = ${rule.interval}`, DIALOG_INTERVAL, String(rule.interval)));

  if (rule.weekdays !== undefined && rule.weekdays.length > 0) {
    const [first, ...rest] = rule.weekdays;
    if (first !== undefined) {
      steps.push(selectPopup(`weekday = ${first}`, DIALOG_WEEKDAY, WEEKDAY_TITLE[first]));
    }
    // Each additional weekday: press "+" to add a row, then the new pop-up. The
    // added pop-up's index shifts per row; UIC6 confirms the exact addressing —
    // provisionally the same DIALOG_WEEKDAY pop-up re-driven after the add.
    for (const day of rest) {
      steps.push(pressControl(`add weekday row (${day})`, DIALOG_ADD_WEEKDAY));
      steps.push(selectPopup(`weekday += ${day}`, DIALOG_WEEKDAY, WEEKDAY_TITLE[day]));
    }
  }

  if (rule.monthly !== undefined) {
    steps.push(...monthlyAnchorSteps(rule.monthly, DIALOG_MONTH_MODE, DIALOG_MONTH_ORDINAL));
  }

  if (rule.yearly !== undefined) {
    const y: YearlyAnchor = rule.yearly;
    steps.push(
      selectPopup(`yearly month = ${y.month}`, DIALOG_YEAR_MONTH, MONTH_TITLE[y.month - 1] ?? ""),
    );
    steps.push(...monthlyAnchorSteps(y, DIALOG_YEAR_MODE, DIALOG_YEAR_ORDINAL));
  }

  if (rule.ends !== undefined && rule.ends.kind !== "never") {
    if (rule.ends.kind === "after") {
      steps.push(selectPopup("ends = after", DIALOG_ENDS, "after"));
      steps.push(
        setField(`ends after = ${rule.ends.count}`, DIALOG_ENDS_COUNT, String(rule.ends.count)),
      );
    } else {
      steps.push(selectPopup("ends = on date", DIALOG_ENDS, "on date"));
      steps.push(setDateTime(`ends on = ${rule.ends.date}`, `date:${rule.ends.date}`));
    }
  }

  if (rule.reminder !== undefined) {
    steps.push(pressControl("check Add reminders", DIALOG_ADD_REMINDERS));
    steps.push(setDateTime(`reminder = ${rule.reminder}`, `time:${rule.reminder}`));
  }

  if (rule.deadline === true || (rule.startDaysEarlier ?? 0) > 0) {
    steps.push(pressControl("check Add deadlines", DIALOG_ADD_DEADLINES));
    if ((rule.startDaysEarlier ?? 0) > 0) {
      steps.push(
        setField(
          `start ${rule.startDaysEarlier} days earlier`,
          DIALOG_START_EARLIER,
          String(rule.startDaysEarlier),
        ),
      );
    }
  }

  steps.push(pressControl('press "OK"', DIALOG_OK));
  return steps;
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
    steps: [
      ...preamble(targetUuid),
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
    steps: [
      ...preamble(targetUuid),
      menuPress(
        "Items ▸ Repeat ▸ Reschedule…",
        `menu item "Reschedule…" of menu 1 of menu item "Repeat" of ${ITEMS_MENU}`,
        REPEAT_SUBMENU_ANCHOR,
      ),
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

/** The header cell of the project view (row 1 of the content table). */
const PROJECT_HEADER_CELL = `UI element 1 of row 1 of table 1 of scroll area 1 of ${MAIN_WINDOW}`;
/** The always-visible repeat bar of a repeating project (UIC2/UIC3: text area 2). */
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
    steps: [
      ...projectPreamble(targetUuid),
      openProjectRepeatPopover(),
      popoverItemClick("repeat menu ▸ Change…", "Change…", {
        path: `sheet 1 of ${MAIN_WINDOW}`,
        label: "the Repeat dialog",
      }),
      ...repeatDialogEntry({ frequency, interval, ...extras }),
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
    op: "area.reorder-sidebar",
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
