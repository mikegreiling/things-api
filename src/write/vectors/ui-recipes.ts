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
import type { RepeatFrequency } from "../operations.ts";
import type { UiRecipe, UiStep } from "./types.ts";

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

export function stopRepeatRecipe(targetUuid: string): UiRecipe {
  // Stop is reachable ONLY from the open-card repeat-bar popover (UI2-i) — not
  // the Items/context menus. Open the card, click the "Repeat every …" bar,
  // then Stop, then confirm the "Stop To-Do from Repeating" sheet.
  //
  // UIC1 BLOCKER (uncertified, and cannot be certified as written): opening the
  // card requires a genuine mouse DOUBLE-CLICK on the list row. Things list rows
  // are sparse AXCells that expose no AXPress/AXOpen action, and neither AXPress
  // on the cell, Return, nor Get Info opens the card (an `entire contents` scan
  // finds no repeat bar). The AX-only vector cannot synthesize a double-click, so
  // this recipe fails-closed at the card-open step. Certifying stop-repeat needs
  // either a native-AXUIElement double-click or a (banned) coordinate click; see
  // docs/lab/uic1-certification.md. Window addressing corrected to the main
  // standard window for when a viable card-open primitive lands.
  return {
    op: "todo.stop-repeat",
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      {
        primitive: "press",
        label: "open the to-do card (UIC1: no AX card-open path — see recipe note)",
        path: `UI element 1 of (first row of table 1 of scroll area 2 of ${MAIN_WINDOW} whose selected is true)`,
        dynamic: true,
        addressing: "title",
      },
      waitFor("the card's repeat bar", `button "Repeat" of group 1 of ${MAIN_WINDOW}`),
      menuPress(
        "click the repeat bar to open the popover",
        `button "Repeat" of group 1 of ${MAIN_WINDOW}`,
      ),
      waitFor("the repeat popover", `pop over 1 of ${MAIN_WINDOW}`),
      {
        primitive: "press",
        label: "popover ▸ Stop",
        path: `menu item "Stop" of pop over 1 of ${MAIN_WINDOW}`,
        dynamic: true,
        addressing: "title",
      },
      waitFor("the confirmation sheet", `sheet 1 of ${MAIN_WINDOW}`),
      {
        // Alert primary button — stable AXIdentifier "action-button-1" (UIC1).
        primitive: "press",
        label: 'confirm — press "Stop"',
        path: `(first button of sheet 1 of ${MAIN_WINDOW} whose value of attribute "AXIdentifier" is "action-button-1")`,
        dynamic: true,
        addressing: "axidentifier",
      },
    ],
  };
}

// --------------------------------------------------------------- tier 2

/** Steps that enter frequency + interval into the open Repeat dialog. */
function repeatDialogEntry(frequency: RepeatFrequency, interval: number): UiStep[] {
  return [
    waitFor("the Repeat dialog", `sheet 1 of ${MAIN_WINDOW}`),
    {
      // The frequency dropdown offers after-completion · daily · weekly ·
      // monthly · yearly (UI2-a). UIC1 confirmed `set value` on this pop-up is a
      // silent no-op — it must be opened and the menu item clicked (select-popup).
      primitive: "select-popup",
      label: `frequency = ${frequency}`,
      path: `pop up button 1 of sheet 1 of ${MAIN_WINDOW}`,
      value: frequency,
      dynamic: true,
      addressing: "title",
    },
    {
      // The interval field is nested inside the dialog's content group (UIC1),
      // not a direct sheet child. `set value` works here.
      primitive: "set-value",
      label: `interval = ${interval}`,
      path: `text field 1 of group 1 of sheet 1 of ${MAIN_WINDOW}`,
      value: String(interval),
      dynamic: true,
      addressing: "title",
    },
    {
      primitive: "press",
      label: 'press "OK"',
      path: `button "OK" of sheet 1 of ${MAIN_WINDOW}`,
      dynamic: true,
      addressing: "title",
    },
  ];
}

export function makeRepeatingRecipe(
  targetUuid: string,
  frequency: RepeatFrequency,
  interval: number,
): UiRecipe {
  return {
    op: "todo.make-repeating",
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      menuPress("Items ▸ Repeat…", `menu item "Repeat…" of ${ITEMS_MENU}`),
      ...repeatDialogEntry(frequency, interval),
    ],
  };
}

export function rescheduleRepeatRecipe(
  targetUuid: string,
  frequency: RepeatFrequency,
  interval: number,
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
      ...repeatDialogEntry(frequency, interval),
    ],
  };
}
