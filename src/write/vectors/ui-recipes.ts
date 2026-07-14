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
      waitFor("the confirmation sheet", `sheet 1 of window 1`),
      {
        primitive: "press",
        label: 'confirm — press "Convert"',
        path: `button "Convert" of sheet 1 of window 1`,
        dynamic: true,
        addressing: "title",
      },
    ],
  };
}

export function stopRepeatRecipe(targetUuid: string): UiRecipe {
  // Stop is reachable ONLY from the open-card repeat-bar popover (UI2-i) — not
  // the Items/context menus. Open the card, click the "Repeat every …" bar,
  // then Stop, then confirm the "Stop To-Do from Repeating" sheet.
  return {
    op: "todo.stop-repeat",
    targetUuid,
    steps: [
      ...preamble(targetUuid),
      {
        primitive: "press",
        label: "open the to-do card (AXOpen the selected row)",
        path: `UI element 1 of row 1 of outline 1 of scroll area 1 of group 1 of window 1`,
        dynamic: true,
        addressing: "title",
      },
      waitFor("the card's repeat bar", `button "Repeat" of group 1 of window 1`),
      menuPress(
        "click the repeat bar to open the popover",
        `button "Repeat" of group 1 of window 1`,
      ),
      waitFor("the repeat popover", `pop over 1 of window 1`),
      {
        primitive: "press",
        label: "popover ▸ Stop",
        path: `menu item "Stop" of pop over 1 of window 1`,
        dynamic: true,
        addressing: "title",
      },
      waitFor("the confirmation sheet", `sheet 1 of window 1`),
      {
        primitive: "press",
        label: 'confirm — press "Stop"',
        path: `button "Stop" of sheet 1 of window 1`,
        dynamic: true,
        addressing: "title",
      },
    ],
  };
}

// --------------------------------------------------------------- tier 2

/** Steps that enter frequency + interval into the open Repeat dialog. */
function repeatDialogEntry(frequency: RepeatFrequency, interval: number): UiStep[] {
  return [
    waitFor("the Repeat dialog", `sheet 1 of window 1`),
    {
      // The type dropdown offers after-completion · daily · weekly · monthly ·
      // yearly (UI2-a). Certification may switch this to keyboard arrow-key
      // selection ("key") if the pop-up button will not take a set value.
      primitive: "set-value",
      label: `frequency = ${frequency}`,
      path: `pop up button 1 of sheet 1 of window 1`,
      value: frequency,
      dynamic: true,
      addressing: "title",
    },
    {
      primitive: "set-value",
      label: `interval = ${interval}`,
      path: `text field 1 of sheet 1 of window 1`,
      value: String(interval),
      dynamic: true,
      addressing: "title",
    },
    {
      primitive: "press",
      label: 'press "OK"',
      path: `button "OK" of sheet 1 of window 1`,
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
