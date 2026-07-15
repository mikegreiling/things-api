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

// The to-do stop-repeat recipe was REMOVED (roadmap build item 4): it never
// certified (its Stop popover lives only on the open card, reachable only by a
// mouse double-click — UIC1/UIC2-d) and no project.stop-repeat is built either
// (the project Stop then selecting the demoted project crashes Things — CRASH1
// / oddities §7 C5). See docs/design/ax-initiative.md and docs/design/ui-vector.md.

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
/** The always-visible repeat bar of a repeating project (UIC2: text area 2). */
const PROJECT_REPEAT_BAR = `text area 2 of ${PROJECT_HEADER_CELL}`;
/** The popover opened by clicking the repeat bar. */
const PROJECT_REPEAT_POPOVER = `pop over 1 of ${MAIN_WINDOW}`;

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
    path: `(first UI element of ${PROJECT_REPEAT_POPOVER} whose description is "${description}")`,
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
      ...repeatDialogEntry(frequency, interval),
    ],
  };
}
