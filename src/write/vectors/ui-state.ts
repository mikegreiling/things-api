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
 *   3. the window-state diagnostic — `things rescue status` and `things doctor
 *      --ui-state`.
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
 *                     (OK / Cancel), AT MOST ONE direct text field, and one
 *                     cadence group carrying its own field/pop-up. That shape
 *                     holds in every mode of the 3.23 dialog and in both of its
 *                     forms (attached sheet when Things is frontmost, detached
 *                     editor window when it is not), and no other Things sheet
 *                     presents it.
 *
 *                     THE DIRECT-TEXT-FIELD COUNT IS 0 OR 1, NEVER JUST 0
 *                     (CNCAC2, 2026-08-28, golden-v4 / 3.23). Ticking "Add
 *                     deadlines" REVEALS the `and start [n] days earlier` offset
 *                     field as a DIRECT child of the shell — the CGRD1 §B census
 *                     measured exactly that ("0 direct text fields with deadlines
 *                     OFF and exactly 1 with them ON") — so a `tf is 0` clause
 *                     re-classified the drive's OWN Repeat sheet as `other` the
 *                     instant it ticked the box. The per-step focus guard then
 *                     refused the very next keystroke hop ("start N days
 *                     earlier"), aborting EVERY deadlined promote/reschedule and
 *                     leaving the sheet standing. Measured live:
 *                     `sheetKind":"other" … "sheetControls":"cb:2 pu:1 bt:2 gp:1
 *                     tf:1"`.
 *   - `move-picker` — the Move… project picker, identified POSITIVELY by its own
 *                     `AXIdentifier` prefix (`MovePopUpDialog-`) — the same
 *                     identity check the picker-row resolver makes.
 *   - `other`       — something modal is up that is neither of those.
 *   - `none`        — no attached sheet and no detached editor window.
 */
export type UiSheetKind = "none" | "repeat" | "move-picker" | "other";

/** How the dialog presents: attached to the standard window, or detached (Things backgrounded). */
export type UiSheetForm = "none" | "attached" | "detached";

/** How deep a stack of dialogs the walk will follow before giving up. */
const MAX_SHEET_DEPTH = 6;

/**
 * Resolve the dialog IN FRONT — the innermost of a stack — and record how deep
 * the stack goes. Written as a snippet because the census and the dismissal must
 * agree on which dialog they mean, to the element.
 *
 * Sheets STACK (MODALX1 §6, golden-v4 / 3.23): a dialog raised while another is
 * standing becomes an `AXSheet` CHILD of the one below it, not a sibling on the
 * window — measured with two `things:///add` URL-consent alerts nesting inside a
 * Repeat sheet — and dismissal is strictly LIFO. So a census that reads only the
 * window's own `sheet 1` sees the bottom of the stack and misidentifies what
 * actually owns the screen, and a dismissal aimed there presses a button behind
 * a modal. Both walk to the top instead.
 *
 * Runs inside a `tell process "Things3"` block; leaves `shellRef` (or
 * `missing value`), `sheetForm` and `sheetDepth` bound.
 */
export const AX_DIALOG_SHELL_SNIPPET = `		set shellRef to missing value
		set sheetForm to "none"
		set sheetDepth to 0
		try
			-- positional-ok: the one attached sheet a window can present, which is
			-- the BOTTOM of any stack; the walk below climbs to the top.
			set shellRef to sheet 1 of (first window whose subrole is "AXStandardWindow")
			set sheetForm to "attached"
			set sheetDepth to 1
		end try
		if shellRef is missing value then
			try
				set dws to (windows whose subrole is "AXUnknown" and size is not {40, 40})
				if (count of dws) > 0 then
					set shellRef to item 1 of dws
					set sheetForm to "detached"
					set sheetDepth to 1
				end if
			end try
		end if
		if shellRef is not missing value then
			repeat ${MAX_SHEET_DEPTH} times
				set nested to missing value
				try
					if (exists sheet 1 of shellRef) then set nested to sheet 1 of shellRef
				end try
				if nested is missing value then exit repeat
				set shellRef to nested
				set sheetDepth to sheetDepth + 1
			end repeat
		end if`;

/**
 * The census's individually-budgeted probes, in the order they run. The first
 * three are DECISION-CRITICAL — the guard, the drive preflight and the cleanup
 * ladder all decide on them — and the last two are DECORATION for the refusal
 * copy. That order is the point: everything a caller acts on is proven before a
 * single unaddressed query is attempted.
 *
 *   - `running`  — is there a Things process at all (a name-keyed lookup);
 *   - `frontmost` — `frontmost of process "Things3"`, ADDRESSED: the one fact a
 *                   keystroke guard actually needs;
 *   - `dialog`   — the dialog shell, its form, its stack depth and its control
 *                   census, all addressed inside `process "Things3"`;
 *   - `frontapp` — WHICH other application owns the screen. This is the whole
 *                   process table enumerated (`first application process whose
 *                   frontmost is true`), so it runs only when the addressed
 *                   `frontmost` probe already said the answer is not Things, and
 *                   only for the sentence that names the thief;
 *   - `focus`    — the focused element's role, through
 *                   `AXFocusedUIElement`. MEASURED at ~3.5x the cost of every
 *                   addressed probe in this vector even on a bare clone
 *                   (docs/lab/fgrd2-census-hardening.md §2), and it decides
 *                   nothing — so it goes last, inside its own budget, and its
 *                   absence costs a clause in a sentence.
 */
export type UiProbe = "running" | "frontmost" | "dialog" | "frontapp" | "focus";

/** Probes whose absence makes the census unusable for a keystroke decision. */
const CRITICAL_PROBES: readonly UiProbe[] = ["running", "frontmost", "dialog"];

/** Every probe name the census can report, for parsing its record back. */
const KNOWN_PROBES: ReadonlySet<string> = new Set<UiProbe>([
  "running",
  "frontmost",
  "dialog",
  "frontapp",
  "focus",
]);

/**
 * Per-APPLE-EVENT budget for every read in the census (`with timeout of N
 * seconds`). Without one, osascript's default is two MINUTES: a System Events
 * call that does not come back is then bounded only by the caller's own process
 * deadline, which is how issue #629's field incident spent ~15s per inspection
 * and ~56s per drive discovering nothing. With one, a read that will not answer
 * raises AppleScript error -1712 and the census carries on to the next probe —
 * or stops, if the probe was one the caller decides on.
 */
const PROBE_TIMEOUT_S = 2;

/**
 * Wall-clock budget for the WHOLE census, checked between probes. `with
 * timeout` bounds one Apple event, not a run of them, so a surface that is
 * merely slow (rather than wedged) could still add up. Past this, the remaining
 * probes are skipped and reported as stalled rather than waited on.
 */
const CENSUS_BUDGET_S = 8;

/**
 * The transport deadline for one census hop — the backstop under the in-script
 * budgets, not the mechanism. Deliberately far below the 15s step timeout that
 * bounded the old single-shot script: nothing here may take this long, and if
 * it does the caller must hear about it while the drive can still be aborted
 * cleanly rather than after four of them have gone by.
 */
export const CENSUS_TIMEOUT_MS = 12_000;

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
  /** What the dialog IN FRONT is — the innermost of a stack (see {@link AX_DIALOG_SHELL_SNIPPET}). */
  sheetKind: UiSheetKind;
  sheetForm: UiSheetForm;
  /**
   * How many dialogs are stacked (0 when none, 1 for the ordinary case). Sheets
   * nest as children of the sheet below and dismiss strictly LIFO, so a depth
   * above 1 means one dismissal is not enough — and that the thing in front is
   * NOT the dialog a drive opened (MODALX1 §6).
   */
  sheetDepth: number;
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
   *
   * A probe that TIMED OUT does not set this: "macOS refused to describe the
   * screen" and "the screen did not answer in time" are different facts with
   * different remediations, and #629 is what conflating them costs.
   */
  inspectable: boolean;
  /**
   * The probes that did not answer within their budget. Non-empty means the
   * corresponding fields are UNPROVEN, not false — every caller reads them that
   * way, and a critical probe here aborts a drive instead of being retried.
   */
  stalledProbes: UiProbe[];
  /**
   * The probes that answered with an error rather than a value (the surface is
   * there but would not describe itself — a secure modal, a process that exited
   * between two reads). Reported for the same reason: what could not be proven
   * is named, never guessed at.
   */
  failedProbes: UiProbe[];
}

/** Did a probe the caller has to DECIDE on fail to answer? */
export function censusUnverifiable(state: UiState | null): boolean {
  if (state === null) return true;
  return CRITICAL_PROBES.some(
    (p) => state.stalledProbes.includes(p) || state.failedProbes.includes(p),
  );
}

/** Name the probes that did not answer, for a diagnostic someone has to act on. */
export function describeUnprovenProbes(state: UiState): string {
  const label: Record<UiProbe, string> = {
    running: "whether Things is running",
    frontmost: "whether Things owns the screen",
    dialog: "which dialog is open",
    frontapp: "which application owns the screen",
    focus: "which element has keyboard focus",
  };
  const parts: string[] = [];
  if (state.stalledProbes.length > 0) {
    parts.push(`did not answer in time: ${state.stalledProbes.map((p) => label[p]).join(", ")}`);
  }
  if (state.failedProbes.length > 0) {
    parts.push(`could not be read: ${state.failedProbes.map((p) => label[p]).join(", ")}`);
  }
  return parts.join("; ");
}

/** A recognizable token in the script so a test runner can key off the ui-state command. */
export const UI_STATE_MARKER = "-- ui-state census (read-only)";

/** The label every ui-state dispatch carries (one stable command shape). */
export const UI_STATE_LABEL = "read the window and focus state";

/** The Things application's process name — the frontmost value that means "us". */
export const THINGS_PROCESS = "Things3";

/**
 * The census script — ADDRESSED probes, each on its own Apple-event budget
 * (issue #629).
 *
 * WHAT CHANGED, AND WHY IT HAD TO. The 0.19.2 census was one unbounded script
 * that opened with two UNADDRESSED queries: `first application process whose
 * frontmost is true` (the entire process table enumerated) and `value of
 * attribute "AXFocusedUIElement"` on whatever that returned (a system-wide
 * focused-element resolution). Everything else the ui vector runs — every step
 * the field incident's log shows succeeding, inside the very sheet the census
 * could not describe — is addressed: `tell process "Things3" to …`. So the one
 * script that stalled was the one script that left the addressed style, and it
 * stalled on the critical path of BOTH the per-step guard and the cleanup that
 * was supposed to recover from it. Rebuilt here so that:
 *
 *   - the decision-critical facts are ADDRESSED and are proven FIRST;
 *   - every read carries `with timeout of ${PROBE_TIMEOUT_S} seconds`, so a
 *     surface that will not answer costs seconds, not the caller's whole
 *     deadline;
 *   - a critical probe that does not answer STOPS the census then and there —
 *     the remaining probes cannot change what the caller must now do (abort and
 *     clean up), so waiting for them is pure latency;
 *   - the two unaddressed queries survive only as DECORATION, last, skipped
 *     entirely when the addressed probes already answered the question they
 *     were there to answer.
 *
 * Every probe still degrades one field rather than failing the census, and what
 * could not be proven is NAMED (`stalled=` / `failed=`) instead of silently
 * reading as a clean "nothing is open".
 */
export function axUiStateScript(): string {
  return `${UI_STATE_MARKER}
${CENSUS_BODY}

return ${censusRecord("linefeed")}`;
}

/**
 * The census BODY — every probe, leaving its verdict in the AppleScript variables
 * the record below reads. Split out of {@link axUiStateScript} (DRVLAT1, issue
 * #633) so the SAME probes can run as the in-script prelude of a keystroke hop
 * ({@link axFocusGuardPrelude}) rather than as a separate osascript round-trip.
 * Nothing about the probes, their budgets or their order differs between the two
 * uses: it is one body, compiled into two scripts.
 */
const CENSUS_BODY = `set frontName to ""
set frontIsThings to false
set focusRole to ""
set focusSub to ""
set canInspect to true
set thingsRunning to false
set sheetForm to "none"
set sheetKind to "none"
set sheetDepth to 0
set census to ""
set stalled to ""
set failed to ""
set halted to false
set t0 to (current date)

-- P1 running: a name-keyed lookup, no Accessibility round-trip.
try
	with timeout of ${PROBE_TIMEOUT_S} seconds
		tell application "System Events" to set thingsRunning to (exists application process "${THINGS_PROCESS}")
	end timeout
on error errMsg number errNum
	if errNum is -1712 then
		set stalled to stalled & "running "
	else
		set failed to failed & "running "
	end if
	set halted to true
end try

-- P2 frontmost, ADDRESSED: the single fact the per-step input guard decides on.
if (not halted) and thingsRunning then
	try
		with timeout of ${PROBE_TIMEOUT_S} seconds
			tell application "System Events" to tell process "${THINGS_PROCESS}" to set frontIsThings to (frontmost as boolean)
		end timeout
		if frontIsThings then set frontName to "${THINGS_PROCESS}"
	on error errMsg number errNum
		if errNum is -1712 then
			set stalled to stalled & "frontmost "
		else
			set failed to failed & "frontmost "
		end if
		set halted to true
	end try
end if

-- P3 dialog: shell, form, stack depth and control census — all addressed
-- inside the Things process, which is the shape every working drive step uses.
if (not halted) and thingsRunning then
	try
		with timeout of ${PROBE_TIMEOUT_S} seconds
			tell application "System Events" to tell process "${THINGS_PROCESS}"
${AX_DIALOG_SHELL_SNIPPET}
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
					else if nCb is 2 and nPu is 1 and nBt is 2 and nGp is 1 and (nTf is 0 or nTf is 1) then
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
		end timeout
	on error errMsg number errNum
		if errNum is -1712 then
			set stalled to stalled & "dialog "
		else
			set failed to failed & "dialog "
		end if
		set halted to true
	end try
end if

-- P4 frontapp: the ONLY enumeration left, and it runs only when the addressed
-- probe has already said the screen is not ours — its whole job is naming the
-- application in the refusal sentence.
if (not halted) and (not frontIsThings) then
	if ((current date) - t0) > ${CENSUS_BUDGET_S} then
		set stalled to stalled & "frontapp "
	else
		try
			with timeout of ${PROBE_TIMEOUT_S} seconds
				tell application "System Events" to set frontName to (name of first application process whose frontmost is true) as text
			end timeout
		on error errMsg number errNum
			if errNum is -1712 then
				set stalled to stalled & "frontapp "
			else
				set failed to failed & "frontapp "
			end if
		end try
	end if
end if

-- P5 focus: decoration, and the most expensive read in the census. Addressed at
-- the process that owns the screen rather than resolved system-wide, run last,
-- and skipped outright once the budget is spent. An ERROR here (as opposed to a
-- timeout) is the secure-system-modal signature: macOS exposes no tree for one.
if not halted then
	if ((current date) - t0) > ${CENSUS_BUDGET_S} then
		set stalled to stalled & "focus "
	else
		set focusTarget to frontName
		if focusTarget is "" then
			set stalled to stalled & "focus "
		else
			try
				with timeout of ${PROBE_TIMEOUT_S} seconds
					tell application "System Events" to tell process focusTarget
						set fe to value of attribute "AXFocusedUIElement"
						-- No focused element is a perfectly ordinary state (an app
						-- with no key window); it is not an unreadable screen.
						if fe is not missing value then
							set focusRole to (role of fe) as text
							try
								set focusSub to (subrole of fe) as text
							end try
						end if
					end tell
				end timeout
			on error errMsg number errNum
				if errNum is -1712 then
					set stalled to stalled & "focus "
				else
					set canInspect to false
					set failed to failed & "focus "
				end if
			end try
		end if
	end if
end if`;

/**
 * The census RECORD, joined by `sep` — `linefeed` for the stand-alone census
 * script, a single-line separator for the guard prelude's `log` line (a logged
 * record has to survive as ONE stderr line to be recovered).
 */
function censusRecord(sep: string): string {
  return `"front=" & frontName & ${sep} & "isfront=" & frontIsThings & ${sep} & "running=" & thingsRunning & ${sep} & "form=" & sheetForm & ${sep} & "depth=" & sheetDepth & ${sep} & "kind=" & sheetKind & ${sep} & "census=" & census & ${sep} & "role=" & focusRole & ${sep} & "subrole=" & focusSub & ${sep} & "inspectable=" & canInspect & ${sep} & "stalled=" & stalled & ${sep} & "failed=" & failed`;
}

/** The stderr line prefix carrying a folded guard's census record. */
export const GUARD_LOG_PREFIX = "#FGCENSUS ";
/** The separator joining that record's fields on its single line. */
export const GUARD_LOG_SEP = " ~|~ ";
/**
 * What a folded guard RAISES when it refuses. Deliberately a machine tag rather
 * than a sentence: the refusal a caller reads is still built by
 * {@link judgeFocusGuard} in TypeScript, from the census this same hop logged, so
 * there is exactly ONE place the wording lives and the in-script judgement can
 * never drift from it.
 */
export const GUARD_REFUSED_TAG = "#FGREFUSE";

/**
 * The census as the IN-SCRIPT PRELUDE of the hop it guards (DRVLAT1, issue #633).
 *
 * The per-step focus guard used to be its own osascript round-trip: census hop,
 * then keystroke hop. That is both a hop of latency per typed control AND a
 * TOCTOU window — the screen can change between the census that approved the
 * keystroke and the keystroke itself. Prepending the census to the very script
 * that types closes both: the probes and the input now run in one process, in
 * order, with nothing dispatched in between.
 *
 * The prelude LOGS its census record (stderr, one line) and then judges it
 * IN-SCRIPT, raising {@link GUARD_REFUSED_TAG} — a bare tag — when the input must
 * not be sent. The caller recovers the logged record, parses it into the same
 * {@link UiState} the stand-alone census yields, and asks {@link judgeFocusGuard}
 * for the sentence. So the DECISION is made before the keystroke, in-script, and
 * the WORDING is still single-sourced in TypeScript.
 *
 * `expectedSheet` is the dialog the drive has observed itself driving; pass null
 * where no dialog invariant applies.
 */
export function axFocusGuardPrelude(expectedSheet: UiSheetKind | null): string {
  const critical = CRITICAL_PROBES.map(
    (p) => `  if stalled contains "${p} " then set fgBad to true
  if failed contains "${p} " then set fgBad to true`,
  ).join("\n");
  const sheetClause =
    expectedSheet === null
      ? ""
      : `\n  if sheetKind is not "${expectedSheet}" then set fgBad to true`;
  return `${UI_STATE_MARKER}
${CENSUS_BODY}

log "${GUARD_LOG_PREFIX}" & ${censusRecord(`"${GUARD_LOG_SEP}"`)}
set fgBad to false
${critical}
if not canInspect then set fgBad to true
if not frontIsThings then set fgBad to true${sheetClause}
if fgBad then error "${GUARD_REFUSED_TAG}"
`;
}

/**
 * Recover a folded guard's census from the hop's stderr: the parsed state (null
 * when no record was logged) and the stderr with that line removed, so a failure
 * message a caller reads never carries the machinery.
 */
export function parseGuardLog(stderr: string): { state: UiState | null; stderr: string } {
  const kept: string[] = [];
  let record: string | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const at = line.indexOf(GUARD_LOG_PREFIX);
    if (at >= 0) {
      record = line.slice(at + GUARD_LOG_PREFIX.length);
      continue;
    }
    kept.push(line);
  }
  return {
    state: record === null ? null : parseUiState(record.split(GUARD_LOG_SEP).join("\n")),
    stderr: kept.join("\n").trim(),
  };
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
  const probes = (key: string): UiProbe[] =>
    (fields.get(key) ?? "").split(/\s+/).filter((p): p is UiProbe => KNOWN_PROBES.has(p));
  const kindRaw = fields.get("kind") ?? "none";
  const sheetKind: UiSheetKind =
    kindRaw === "repeat" || kindRaw === "move-picker" || kindRaw === "other" ? kindRaw : "none";
  const formRaw = fields.get("form") ?? "none";
  const sheetForm: UiSheetForm =
    formRaw === "attached" || formRaw === "detached" ? formRaw : "none";
  const frontRaw = fields.get("front") ?? "";
  const frontmostApp = frontRaw === "" ? null : frontRaw;
  const role = fields.get("role") ?? "";
  // AppleScript coerces an absent attribute to the literal words "missing
  // value"; that is "no subrole", not a subrole named that.
  const subroleRaw = fields.get("subrole") ?? "";
  const subrole = subroleRaw === "missing value" ? "" : subroleRaw;
  const census = fields.get("census") ?? "";
  const depth = Number(fields.get("depth") ?? "0");
  return {
    thingsRunning: fields.get("running") === "true",
    // Decided by the ADDRESSED probe, not by comparing a name the enumeration
    // may never have been asked for (issue #629).
    thingsFrontmost: fields.get("isfront") === "true",
    frontmostApp,
    sheetOpen: sheetKind !== "none",
    sheetKind,
    sheetForm,
    sheetDepth: Number.isFinite(depth) ? depth : 0,
    sheetControls: census === "" ? null : census,
    focusOwner:
      frontmostApp === null ? null : { app: frontmostApp, role, subrole: subrole || null },
    inspectable: fields.get("inspectable") === "true",
    stalledProbes: probes("stalled"),
    failedProbes: probes("failed"),
  };
}

/**
 * Read the census through the injected runner. Returns null on a transport
 * failure — an UNKNOWN state, which every caller treats fail-closed (the guard
 * refuses; the cleanup path does not send a blind Escape).
 *
 * `timeoutMs` defaults to {@link CENSUS_TIMEOUT_MS}: a census is not a drive
 * step and must not borrow a drive step's patience (issue #629).
 */
export async function readUiState(
  run: (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>,
  timeoutMs: number = CENSUS_TIMEOUT_MS,
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
  // #629: an inspection that did not come back says nothing about who owns the
  // screen — and saying "an unidentified application is frontmost" would read
  // as a measurement. Name the probe that stalled instead.
  if (censusUnverifiable(state)) {
    return `the window state inspection did not complete (${describeUnprovenProbes(state)})`;
  }
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

/**
 * A one-line human summary of the census, for a diagnostic line or a warning.
 *
 * Reports WHAT EACH PROBE PROVED. A stalled probe leaves its clause reading
 * "could not be determined" and is named at the end — never omitted, and never
 * rendered as its default (issue #629: a census that could not see the open
 * Repeat sheet used to report a clean screen).
 */
export function describeUiState(state: UiState): string {
  const unproven = (p: UiProbe): boolean =>
    state.stalledProbes.includes(p) || state.failedProbes.includes(p);
  const trailer = (): string => {
    const unprovenText = describeUnprovenProbes(state);
    return unprovenText === "" ? "" : ` — ${unprovenText}`;
  };
  if (unproven("running")) {
    return `nothing about the screen could be established${trailer()}`;
  }
  if (!state.thingsRunning && !unproven("frontmost")) {
    return `Things is not running${trailer()}`;
  }
  const front = unproven("frontmost")
    ? "whether Things owns the screen could not be determined"
    : state.thingsFrontmost
      ? "Things is frontmost"
      : unproven("frontapp")
        ? "another application is frontmost (it could not be named)"
        : `${state.frontmostApp ?? "an unidentified application"} is frontmost`;
  if (unproven("dialog")) {
    return `${front}; whether a dialog is open in Things could not be determined${trailer()}`;
  }
  const sheet =
    state.sheetKind === "none"
      ? "no dialog is open in Things"
      : state.sheetKind === "repeat"
        ? `the Repeat dialog is open (${state.sheetForm})`
        : state.sheetKind === "move-picker"
          ? `the Move… picker is open (${state.sheetForm})`
          : `an unrecognized dialog is open in Things (${state.sheetForm})`;
  // A stack means the thing in front is sitting ON another dialog, and each one
  // has to be dismissed in turn (MODALX1 §6).
  const stacked = state.sheetDepth > 1 ? `, on top of ${state.sheetDepth - 1} more` : "";
  return `${front}; ${sheet}${stacked}${trailer()}`;
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
