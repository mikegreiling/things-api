/**
 * The READ-ONLY window/focus census (issue #620, field report M1).
 *
 * One stable osascript shape answers four questions without touching anything —
 * no click, no keystroke, no menu opened, no state changed:
 *
 *   - is a Things sheet/dialog open, and WHICH one (identified from its control
 *     census, never from a localized title alone);
 *   - is Things the frontmost application;
 *   - who owns keyboard focus instead (application + element ROLE);
 *   - could the frontmost surface be inspected at all (a secure system modal —
 *     a macOS privacy/consent dialog — belongs to no application's
 *     Accessibility tree, and that is reported as exactly that rather than
 *     guessed at).
 *
 * It has three consumers, deliberately ONE shape for all of them:
 *   1. the PER-STEP GUARD before every keystroke-class hop (ui.ts) — a keystroke
 *      goes to whatever is frontmost, so typing while another app owns the
 *      screen types into the void, or into someone else's window;
 *   2. the PRE-CLEANUP oracle — Escape is itself a keystroke, so the abort path
 *      must know who would receive it before sending it;
 *   3. the `ui-state` diagnostic (and `things doctor --ui-state`).
 *
 * PRIVACY: the census emits ROLE COUNTS and element ROLES only — never a
 * control's value, title or description, and never a window title. A Things
 * sheet routinely displays the user's own to-do text, and a diagnostic that
 * gets pasted into a bug report must not carry it.
 */
import type { UiCommand, UiRunResult } from "./ui.ts";

/**
 * Which dialog is up, decided by STRUCTURE (the control census measured in
 * docs/lab/rdlg1-323-repeat-dialog-census.md §2.1) rather than by a localized
 * string:
 *
 *   - `repeat`      — the Repeat sheet: exactly two checkboxes, exactly one
 *                     direct pop-up button (the frequency), exactly two buttons
 *                     (OK / Cancel), no direct text field, and one cadence group
 *                     carrying its own field/pop-up. That shape holds in every
 *                     mode of the 3.23 dialog and in both of its forms (attached
 *                     sheet when Things is frontmost, detached editor window when
 *                     it is not), and no other Things sheet presents it.
 *   - `move-picker` — the Move… project picker, identified POSITIVELY by its own
 *                     `AXIdentifier` prefix (`MovePopUpDialog-`) — the same
 *                     identity check the picker-row resolver makes.
 *   - `other`       — something modal is up that is neither of those.
 *   - `none`        — no attached sheet and no detached editor window.
 */
export type UiSheetKind = "none" | "repeat" | "move-picker" | "other";

/** How the dialog presents: attached to the standard window, or detached (Things backgrounded). */
export type UiSheetForm = "none" | "attached" | "detached";

/** Who owns keyboard focus. Role only — never the element's value or title (see PRIVACY). */
export interface UiFocusOwner {
  /** The frontmost application's process name (e.g. "Things3"). */
  app: string;
  /** The focused element's `AXRole`, or "" when the tree would not answer. */
  role: string;
  /** The focused element's `AXSubrole`, or null when it has none. */
  subrole: string | null;
}

export interface UiState {
  /** Is the Things process present at all? */
  thingsRunning: boolean;
  /** Is Things the frontmost application — the surface a keystroke would reach? */
  thingsFrontmost: boolean;
  /** The frontmost application's process name; null when it could not be read. */
  frontmostApp: string | null;
  /** Is a modal sheet / detached editor open in Things? */
  sheetOpen: boolean;
  sheetKind: UiSheetKind;
  sheetForm: UiSheetForm;
  /**
   * The open dialog's control census — role COUNTS only, the evidence behind
   * `sheetKind` (e.g. `cb:2 pu:1 bt:2 gp:1 tf:0`). Null when no dialog is open.
   */
  sheetControls: string | null;
  /** Who owns keyboard focus; null when nothing could be read. */
  focusOwner: UiFocusOwner | null;
  /**
   * False when the frontmost surface could not be walked at all — the signature
   * of a SECURE SYSTEM MODAL (a macOS privacy/consent dialog), which belongs to
   * no application's Accessibility tree. Everything else in the census is then
   * "what could still be proven", never a guess.
   */
  inspectable: boolean;
}

/** A recognizable token in the script so a test runner can key off the ui-state command. */
export const UI_STATE_MARKER = "-- ui-state census (read-only)";

/** The label every ui-state dispatch carries (one stable command shape). */
export const UI_STATE_LABEL = "read the window and focus state";

/** The Things application's process name — the frontmost value that means "us". */
export const THINGS_PROCESS = "Things3";

/**
 * The census script. Every read is wrapped: a surface that will not answer
 * degrades that ONE field rather than failing the whole census, because the
 * cases this exists for — a foreign modal, an AX-blind session — are exactly
 * the cases where half the tree is unreadable.
 */
export function axUiStateScript(): string {
  return `${UI_STATE_MARKER}
set frontName to ""
set focusRole to ""
set focusSub to ""
set canInspect to true
set thingsRunning to false
set sheetForm to "none"
set sheetKind to "none"
set census to ""
tell application "System Events"
	try
		set fp to first application process whose frontmost is true
		set frontName to (name of fp) as text
		try
			set fe to value of attribute "AXFocusedUIElement" of fp
			set focusRole to (role of fe) as text
			try
				set focusSub to (subrole of fe) as text
			end try
		on error
			set canInspect to false
		end try
	on error
		set canInspect to false
	end try
	try
		if (exists application process "${THINGS_PROCESS}") then set thingsRunning to true
	end try
end tell
if thingsRunning then
	tell application "System Events" to tell process "${THINGS_PROCESS}"
		set shellRef to missing value
		try
			-- positional-ok: an EXISTENCE read over the one attached sheet a window
			-- can present. Nothing is addressed through it and nothing is written.
			set shellRef to sheet 1 of (first window whose subrole is "AXStandardWindow")
			set sheetForm to "attached"
		end try
		if shellRef is missing value then
			try
				set dws to (windows whose subrole is "AXUnknown" and size is not {40, 40})
				if (count of dws) > 0 then
					set shellRef to item 1 of dws
					set sheetForm to "detached"
				end if
			end try
		end if
		if shellRef is not missing value then
			set nCb to -1
			set nPu to -1
			set nBt to -1
			set nGp to -1
			set nTf to -1
			try
				set nCb to (count of checkboxes of shellRef)
			end try
			try
				set nPu to (count of pop up buttons of shellRef)
			end try
			try
				set nBt to (count of buttons of shellRef)
			end try
			try
				set nGp to (count of groups of shellRef)
			end try
			try
				set nTf to (count of text fields of shellRef)
			end try
			set census to "cb:" & nCb & " pu:" & nPu & " bt:" & nBt & " gp:" & nGp & " tf:" & nTf
			set winId to ""
			try
				set winId to (value of attribute "AXIdentifier" of shellRef) as text
			end try
			if winId starts with "MovePopUpDialog-" then
				set sheetKind to "move-picker"
			else if nCb is 2 and nPu is 1 and nBt is 2 and nGp is 1 and nTf is 0 then
				set groupOk to false
				try
					set g to group 1 of shellRef
					if ((count of text fields of g) + (count of pop up buttons of g)) > 0 then set groupOk to true
				end try
				if groupOk then set sheetKind to "repeat"
			end if
			if sheetKind is "none" then set sheetKind to "other"
		end if
	end tell
end if
return "front=" & frontName & linefeed & "running=" & thingsRunning & linefeed & "form=" & sheetForm & linefeed & "kind=" & sheetKind & linefeed & "census=" & census & linefeed & "role=" & focusRole & linefeed & "subrole=" & focusSub & linefeed & "inspectable=" & canInspect`;
}

/**
 * Parse the census record into a {@link UiState}. Returns null when the output
 * carries none of the expected keys (a transport error, or a script that never
 * ran) — every caller treats that as UNKNOWN, never as "all clear".
 */
export function parseUiState(stdout: string): UiState | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  if (!fields.has("kind") || !fields.has("inspectable")) return null;
  const kindRaw = fields.get("kind") ?? "none";
  const sheetKind: UiSheetKind =
    kindRaw === "repeat" || kindRaw === "move-picker" || kindRaw === "other" ? kindRaw : "none";
  const formRaw = fields.get("form") ?? "none";
  const sheetForm: UiSheetForm =
    formRaw === "attached" || formRaw === "detached" ? formRaw : "none";
  const frontRaw = fields.get("front") ?? "";
  const frontmostApp = frontRaw === "" ? null : frontRaw;
  const role = fields.get("role") ?? "";
  const subrole = fields.get("subrole") ?? "";
  const census = fields.get("census") ?? "";
  return {
    thingsRunning: fields.get("running") === "true",
    thingsFrontmost: frontmostApp === THINGS_PROCESS,
    frontmostApp,
    sheetOpen: sheetKind !== "none",
    sheetKind,
    sheetForm,
    sheetControls: census === "" ? null : census,
    focusOwner:
      frontmostApp === null ? null : { app: frontmostApp, role, subrole: subrole || null },
    inspectable: fields.get("inspectable") === "true",
  };
}

/**
 * Read the census through the injected runner. Returns null on a transport
 * failure — an UNKNOWN state, which every caller treats fail-closed (the guard
 * refuses; the cleanup path does not send a blind Escape).
 */
export async function readUiState(
  run: (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>,
  timeoutMs: number,
): Promise<UiState | null> {
  const res = await run(
    { primitive: "resolve", label: UI_STATE_LABEL, script: axUiStateScript() },
    timeoutMs,
  );
  if (!res.ok) return null;
  return parseUiState(res.stdout);
}

/**
 * How to name the surface that owns the screen, for a refusal someone has to
 * act on. Names the APPLICATION and the focused element's ROLE — never its
 * contents. An un-inspectable frontmost surface is named as what it is: a
 * system dialog macOS does not expose, which is the one case where the person
 * at the keyboard has to look at the screen themselves.
 */
export function describeFocusOwner(state: UiState | null): string {
  if (state === null) return "the window state could not be read";
  if (!state.inspectable) {
    return (
      "a system dialog owns the screen — macOS does not expose it to other apps, so it cannot be " +
      `identified from here${
        state.frontmostApp === null ? "" : ` (frontmost application: ${state.frontmostApp})`
      }`
    );
  }
  const app = state.frontmostApp ?? "an unidentified application";
  const role = state.focusOwner?.role ?? "";
  return role === ""
    ? `${app} is frontmost`
    : `${app} is frontmost and keyboard focus is on a ${role}`;
}

/** A one-line human summary of the census, for a diagnostic line or a warning. */
export function describeUiState(state: UiState): string {
  const front = state.thingsFrontmost
    ? "Things is frontmost"
    : `${state.frontmostApp ?? "an unidentified application"} is frontmost`;
  const sheet =
    state.sheetKind === "none"
      ? "no dialog is open in Things"
      : state.sheetKind === "repeat"
        ? `the Repeat dialog is open (${state.sheetForm})`
        : state.sheetKind === "move-picker"
          ? `the Move… picker is open (${state.sheetForm})`
          : `an unrecognized dialog is open in Things (${state.sheetForm})`;
  return `${front}; ${sheet}`;
}

/**
 * The warning an OPEN Things dialog earns, wherever it is reported.
 *
 * FIELD-MEASURED (2026-08-27, controlled A/B on the maintainer's Mac): with a
 * Repeat sheet left open, a write landed in the local database but Things Cloud
 * did NOT attempt a sync — not on the write, and not when Things was brought
 * back to the front. Dismissing the sheet released the queued sync immediately,
 * with no further write. A stranded dialog is therefore not cosmetic: it holds
 * the account's sync until someone dismisses it. Recorded in
 * docs/things-app-oddities.md (the open-dialog sync gate).
 */
export const SYNC_GATE_WARNING =
  "while a dialog is open in Things the app stops sending changes to Things Cloud — anything " +
  "written on this Mac stays on this Mac until the dialog is dismissed";
