/**
 * Write-vector abstraction. Vectors are pluggable executors whose
 * per-operation support/disruption/validation metadata is DATA shipped from
 * the lab (url-scheme.matrix / applescript.matrix), never hardcoded logic.
 */
import type { DisruptionTier } from "../../config.ts";
import type { HazardId } from "../guards.ts";
import type { OperationKind } from "../operations.ts";

export type VectorId = "url-scheme" | "applescript" | "shortcuts" | "ui";

export interface CompiledInvocation {
  vector: VectorId;
  kind: "open-url" | "osascript" | "shortcuts-run" | "ui-drive";
  /**
   * The exact payload executed (URL or AppleScript source). For the
   * shortcuts-run kind this is a human-readable rendering of the run — the
   * executor reads `shortcut`/`input` instead. For the ui-drive kind this is
   * a human-readable rendering of the recipe — the executor reads `recipe`.
   */
  payload: string;
  /** Payload with secrets replaced — safe for dry-run output and errors. */
  redactedPayload: string;
  /** shortcuts-run only: the proxy shortcut to invoke (`shortcuts run <name>`). */
  shortcut?: string;
  /** shortcuts-run only: the JSON-serializable input dict piped to the shortcut. */
  input?: unknown;
  /** ui-drive only: the ordered Accessibility recipe the driver executes. */
  recipe?: UiRecipe;
  /**
   * STRUCTURED input for the simulator write vector (bench harness): the
   * resolved operation kind and its (uuid/when-normalized) params. Populated by
   * the pipeline right after {@link CommandSpec.compile}; the real transport
   * vectors ignore them entirely. They exist so a synthetic SQL applier never
   * has to reverse-engineer the payload URL / AppleScript to learn the intent.
   */
  op?: OperationKind;
  /** @see op — the resolved params object for the simulator applier. */
  opParams?: unknown;
}

/**
 * A compiled Accessibility recipe: the target to reveal plus an ordered list
 * of element-addressed steps. Element paths are SEMANTIC (System Events),
 * never coordinates. Every path is marked provisional-pending-certification
 * in its source (see docs/design/ui-vector.md).
 */
export interface UiRecipe {
  op: OperationKind;
  /** The item the recipe acts on (revealed/selected via things:///show?id=). */
  targetUuid: string;
  steps: UiStep[];
  /**
   * DIALOG-class recipe: it opens a SHEET on the main Things window (the Repeat
   * editor, the Convert confirm, the Move picker) and waits for it through the
   * Accessibility tree. Such a recipe needs a Things window that is AX-reachable
   * on the current Space — on a locked screen or in a full-screen app's Space
   * the sheet opens on an unreachable window and the wait times out (SESSGATE,
   * #480). The driver runs a session-reachability probe after the reveal and
   * refuses (`blocked`) when the window is unreachable. Menu-only recipes (todo
   * pause/resume — a pure menu-item press that works even under lock, AXVM1) do
   * NOT set this and are never gated.
   */
  needsWindowReachability?: boolean;
}

export type UiPrimitive =
  | "reveal"
  | "activate"
  | "resolve"
  | "press"
  | "set-value"
  /**
   * Set ONE of the Repeat dialog's two numeric fields — the cadence INTERVAL
   * ("Every [n] days") or the ENDS-AFTER COUNT ("Ends: after [n] times") —
   * addressed by the ROW it sits on rather than by its index among the group's
   * text fields (HXPC1). Both used to be spelled `text field 1 of group 1`,
   * which is only correct in the order the create path happens to drive them:
   * the interval is the group's sole text field until an "Ends: after" bound is
   * selected, and the count then takes index 1 with the interval displaced to 2
   * (measured, Things 3.23 — docs/lab/hxpc1-picker-assert.md §A). A RESCHEDULE
   * opens the dialog PRE-POPULATED, so a rule that already ends after N
   * presents both fields from the first step and the index spelling wrote the
   * requested interval into the count field. The row anchor is the group's
   * `Ends:` static text: the count is the field sharing its row, the interval
   * is the field that does not (and after-completion rules, which offer no ends
   * bound at all, have only the interval). {@link UiStep.numberTarget} picks
   * which. Drives with the same focus → select-all → type → Tab → read-back
   * closed loop as set-value, and fails closed when the row anchor resolves
   * anything other than exactly one field.
   */
  | "set-group-number"
  /**
   * Set a Repeat-dialog text field addressed by the pinned English LABEL sharing
   * its row — the same discrimination law as `set-group-number`, for a field that
   * lives on the dialog SHELL rather than in the cadence group. Its one caller is
   * the "and start [n] days earlier" offset the "Add deadlines" checkbox reveals,
   * which shipped as `text field 1` of the shell: a value-bearing field picked by
   * index out of a tree whose shape depends on that checkbox, and verified only by
   * re-reading the same index it wrote — the HXPC1 error class exactly. It was
   * right on Things 3.23 (measured: the shell carries 0 direct text fields with
   * deadlines off and exactly 1 with them on, CGRD1 §B), but nothing in the address
   * said so. {@link UiStep.rowLabel} names the anchor (`days earlier`); a missing
   * label, or anything but exactly one field on its row, fails closed naming the
   * shell's whole text-field inventory.
   */
  | "set-row-field"
  /**
   * PRE-COMMIT FULL-DIALOG AUDIT — re-read every control this drive set, through
   * each control's own discriminated address, and refuse to press OK if any of
   * them does not hold the intended value (CGRD1).
   *
   * Every setter in this vocabulary confirms its own write by re-reading the
   * element it addressed, which proves the keystrokes landed where they were
   * aimed and nothing more; a wrong ADDRESS is invisible to it (#589: the interval
   * drive typed into the ends-count field, then read that field back and found its
   * own number). This step is the outside view. The plan is derived from the
   * recipe's own step list ({@link UiStep.audit}), so a control the recipe drives
   * cannot be left out of the audit by omission, and it compares the dialog's
   * complete intended state — frequency, cadence unit, interval, ends bound and
   * count, deadline/reminder checkboxes, start-days-earlier, the weekday set, the
   * monthly/yearly anchors, the first occurrence and the ends date. A mismatch
   * names every differing control with both values and aborts the drive
   * fail-closed BEFORE the commit, through the usual clean-abort path.
   */
  | "audit-dialog"
  | "select-popup"
  | "wait"
  /**
   * WAIT for the Repeat dialog and CENSUS it in the same hop (RDLAT2). It reports
   * which of the two shells opened — the attached sheet or the detached editor —
   * and the shell's direct-child AX roles, which the driver matches against the
   * shape manifest (`src/write/vectors/ui-shape.ts`).
   *
   * Two things follow from that one answer. A shell whose control census has
   * moved is a REDESIGNED dialog, and the drive refuses instead of pressing
   * structural indices into it. And a shell that matches is a shell the rest of
   * the drive can ADDRESS directly, so no later step re-discovers which of the
   * two is live and the pre-commit audit needs no resolution hop at all.
   */
  | "dialog-open"
  | "key"
  /**
   * Type literal text into whatever control currently holds focus (HXPC1). Used
   * for the Move… picker's filter field, which the picker focuses for itself the
   * moment it opens: the field is not addressable as a direct child of the
   * picker window, and the set-value primitive's select-all + Tab commit is
   * wrong for a search field anyway (Tab has no next key view in a popover). The
   * keystroke is not the verification — the `click-picker-row` step that follows
   * resolves the intended destination row by name and fails closed if the filter
   * did not produce it, so a keystroke that went astray can never be committed.
   */
  | "type-text"
  /**
   * Synthesize a MOUSE click at an AX-resolved element's frame center (the
   * NATIVE1 JXA ObjC-bridge / HID-tap primitive). Used ONLY for Things' custom
   * `…` menu / repeat-bar popover, whose items are AX-readable but inert to
   * AXPress (UIC2). The frame is read from the live AX tree (`position`/`size`)
   * — never a guessed pixel — so a resolution miss fails closed exactly like a
   * canaried AX press. Requires Things frontmost (the HID tap posts to the
   * foreground surface, NATIVE1-e), so a recipe using it must activate first.
   */
  | "click-element"
  /**
   * Commit the Move… project picker by CLICKING the row that carries the
   * destination project's exact title — never by pressing Return on whatever the
   * filter happened to highlight (HXPC1). The picker exposes no selection,
   * focus, or highlight attribute on any row, so there is nothing to read back
   * from a keyboard commit; what it does expose is one `AXUnknown` per row whose
   * `AXDescription` IS the project title, plus — whenever text has been typed —
   * a `New Project "<typed text>"` row that CREATES a project when committed.
   * The blind Return committed that row whenever the destination was absent from
   * the picker, which is reachable from an ordinary database-resolved
   * destination: a COMPLETED or CANCELED project is offered nowhere in the
   * picker, so the drive silently created a second project of the same name and
   * moved the heading into it (measured on Things 3.23,
   * docs/lab/hxpc1-picker-assert.md §B4). Addressing the row by exact title
   * cannot match the New-Project row (its description is the quoted form) and
   * fails closed — naming every row the picker DID offer — when the intended one
   * is absent, ambiguous, or scrolled out of its own scroll area (the CNCAC1
   * off-screen-frame hazard). `path` is the picker WINDOW — the resolver reads its
   * `AXIdentifier` to confirm identity before it looks at any row; `value` is the
   * destination title.
   */
  | "click-picker-row"
  /**
   * Synthesize a MOUSE DRAG that reorders a sidebar AREA row (the AXDRAG1
   * primitive). The driver resolves the source row and the destination slot
   * boundary from the live AX tree per gesture, pre-scrolls (or multi-hops)
   * when the sidebar is longer than the viewport, and asserts the database
   * order after every gesture — see src/write/vectors/ui-drag.ts. Foreground-
   * bound like click-element.
   */
  | "drag-reorder"
  /**
   * Reorder a project's HEADINGS with the arrow chords (CHORDMH1). Things has no
   * menu item, context-menu item or AX action for heading order — the affordance
   * is four bare keybindings on a selected heading row: ⌘↑/⌘↓ move it one slot,
   * ⌘⌥↑/⌘⌥↓ move it to the top/bottom (HEADORD1). The driver selects the row
   * with the pure-AX positional primitive and posts one chord at a time straight
   * to the Things process, reading the heading order back out of the DATABASE
   * after each — the only oracle a bare keybinding offers. Every chord is
   * computed from that read (never fired speculatively: a chord the app declines
   * costs the user an alert beep), and every chord must move exactly the intended
   * heading exactly one slot with no other row's `index` and no child row
   * touched, or the drive stops. Background-capable with no focus steal — the
   * whole gesture runs with Things behind the user's frontmost app. See
   * src/write/vectors/ui-chord.ts.
   */
  | "chord-reorder"
  /**
   * Select a PROJECT as a content-table ROW by matching its title, purely via
   * AX (UIC4-a): the content table's `AXSelectedRows` is settable, so the
   * driver walks the table's rows, sets each as the selection, and reads back
   * `Things3 → name of selected to dos` — leaving the row whose readback equals
   * the target title selected, or reporting no match. Coordinate-free and
   * background-capable (no focus steal); the readback IS the
   * selection-landed verification. `path` is the content table; `value` the
   * title to match.
   */
  | "select-row"
  /**
   * Select a HEADING as a content-table ROW by POSITION, purely via AX
   * (HEADCERT1). A heading is not `things:///show`-selectable and its row
   * exposes no stable AX title handle (only a hover-dependent "More" affordance
   * carries the title), so identity is positional: the driver walks the
   * revealed PROJECT view's content table and selects the Nth row that is
   * genuinely selectable (`AXSelected` lands) AND reads back an EMPTY
   * `Things3 → name of selected to dos` — the signature of a heading, since a
   * heading is not a to-do (a to-do row's readback is its title; header/spacer
   * rows do not take selection). Coordinate-free and background-capable. `path`
   * is the content table; `value` the 0-based heading ordinal (its position
   * among the project's headings in `index` order). With the heading selected,
   * `Items ▸ Convert to Project…` enables.
   */
  | "select-heading-row"
  /**
   * Assert the reveal actually landed an ELIGIBLE selection before a menu press
   * (ADR1, issue #480). A `things:///show?id=<uuid>` reveal is assumed to select
   * the to-do row, but on some surfaces (a future-scheduled to-do in Upcoming, an
   * area view) it may navigate without leaving the row selected — and an AXPress
   * on the resulting DISABLED `Items ▸ Repeat…` "succeeds" as a silent no-op, so
   * the dialog never opens and the drive dies at the dialog-wait timeout with no
   * hint of the real cause. This step closes that gap fail-closed: it reads back
   * `Things3 → id of selected to dos` and requires EXACTLY the target uuid to be
   * selected, then reads the addressed menu item's `AXEnabled`. It returns "OK"
   * only when the target is the sole selection AND the menu item is enabled;
   * otherwise it returns a diagnostic (`NOTSEL…`/`WRONGSEL…`/`DISABLED…`) the
   * driver surfaces as an EARLY, named failure. `value` is the target uuid; `path`
   * the menu item to enabled-check. Pure System Events, background-capable.
   */
  | "assert-eligible"
  /**
   * Set one of the Repeat dialog's date/time controls — each an `AXDateTimeArea`
   * whose value is an NSDate, NOT a text field (UIC6). System Events cannot set
   * it (`set value … to <date>` errors -10000), so the driver sets `AXValue` to
   * an NSDate through the ObjC bridge (JXA), the same bridge the mouse-synthesis
   * primitive rides. `value` is the spec: `time:HH:mm` (keep the control's date,
   * set the time-of-day) or `date:YYYY-MM-DD` (set the calendar date).
   *
   * A fixed rule can expose up to THREE date areas at once — "Next:" (the first
   * occurrence), the "Ends: on date" bound, and the reminder time (ANCH2 census,
   * docs/lab/anch2-next-field.md) — so the target is chosen DETERMINISTICALLY by
   * {@link UiStep.dtTarget}, never "the first AXDateTimeArea by role" (that
   * ambiguity was the §8v collapse + the UIC6-g reminder mis-verdict). The
   * reminder is the only time-bearing area; among the midnight date pickers the
   * "Next" field is the top row and the "Ends" field the bottom row. Fails
   * closed if the addressed control is absent.
   */
  | "set-datetime"
  /**
   * Converge a dialog CHECKBOX to a target state via a deterministic closed loop
   * (RRD1): read the checkbox's `AXValue` (0/1), press ONLY when the observed
   * state differs from the requested {@link UiStep.checkboxTarget}, then re-read to
   * confirm it landed — never a blind toggle. This is what makes the Repeat
   * dialog's "Add deadlines" / "Add reminders" checkboxes safe on a PRE-POPULATED
   * reschedule dialog: the dialog opens with the item's CURRENT deadline/reminder
   * state already reflected, so an unconditional press flips an already-correct box
   * the wrong way (the live bug — a blind "Add deadlines" press UNCHECKED an
   * already-deadlined rule, hiding the "start N days earlier" field it had already
   * revealed). Only fields the caller actually requested emit a step; an
   * unspecified `--deadline` / `--reminder` on reschedule emits NO step, so the
   * pre-populated state is PRESERVED (requested-fields-only law, #492). Fails
   * closed (an `error` the pipeline re-verifies) if the box will not converge
   * within the bounded retries.
   */
  | "ensure-checkbox"
  /**
   * MEASURE which shape the open Repeat dialog is (RDLG2) and remember it for
   * the rest of the drive. Emitted right before the first shape-dependent step;
   * a dialog matching neither known shape aborts the drive fail-closed rather
   * than press structural indexes it cannot vouch for.
   */
  | "probe-dialog-shape"
  /**
   * Choose the first occurrence from the Things 3.23 `Next:` pop-up — a bounded
   * MENU of `Today` plus the rule's own upcoming occurrences (cascading through
   * `More…` submenus), not a date field (RDLG2). The driver matches the request
   * against each item's parsed date, descends the cascade, clicks the match, and
   * reads the pop-up back. A date the rule never produces is UNREACHABLE in this
   * dialog and fails closed — 3.23 replaced the free-form first-occurrence field
   * the ≤3.22 `set-datetime next` drive wrote.
   */
  | "select-next-occurrence"
  /**
   * Let the Things 3.23 `Next:` occurrence pop-up ABSORB the rule change the
   * preceding steps made, before any further input reaches the dialog
   * (NEXTPOP1). The dialog recomputes that control — its displayed first
   * occurrence AND the menu of occurrences behind it — ASYNCHRONOUSLY, ~0.4s
   * after a calendar-anchor change, and an input that lands inside that window
   * CANCELS the recompute for good: the pop-up goes on describing the PREVIOUS
   * rule indefinitely. The step polls the control until it moves (the common
   * case, ~0.4s) or a bounded budget expires (nothing to absorb), so the next
   * input never races it.
   */
  | "settle-occurrences"
  /**
   * Converge the weekly dialog's weekday ROWS onto an exact target set through a
   * deterministic closed loop (RDLG2, the RRD1 fix): read the live row count,
   * press the row-add button until there are at least as many rows as target
   * weekdays, assign EVERY row from the target set (cycling, so a surplus row
   * duplicates a target weekday instead of keeping a stale one — the app stores
   * the weekdays as a set), then read every row back and confirm the set matches.
   * Replaces the blind first-row-then-"+" drive, which left a pre-populated
   * dialog's stale weekdays in the committed rule.
   */
  | "converge-weekdays";

export interface UiStep {
  primitive: UiPrimitive;
  /** Human-readable step label — surfaced in the partial-state report. */
  label: string;
  /** System Events element path (semantic) for resolve/press/set-value/wait. */
  path?: string;
  /**
   * Alternative element paths, tried in order — the driver dispatches against
   * the FIRST that resolves at run time (fail-closed if none do). Used where a
   * control has two equally-valid shapes: the make-repeating Repeat editor is
   * an attached `AXSheet` when Things is frontmost but a DETACHED top-level
   * `AXUnknown` window when backgrounded (UIC4-a), and its controls sit at
   * different depths in each form. Overrides `path` when present.
   */
  pathCandidates?: string[];
  /**
   * Preflight-canary path when the step's own `path` is not statically
   * resolvable (a nested submenu item only populates once its parent opens):
   * the canary resolves this first-level ancestor instead, still catching a
   * menu that a Things update renamed or removed. Falls back to `path`.
   */
  canaryPath?: string;
  /** set-value: the string typed into the field. */
  value?: string;
  /**
   * select-popup: alternative menu-item LABELS, tried in order — the driver
   * clicks the FIRST that exists in the open pop-up (fail-closed if none do).
   * Used where the same option carries more than one display label depending on
   * dialog state: the after-completion cadence unit reads SINGULAR at interval 1
   * (`week`) but PLURAL at interval > 1 (`weeks`), and the reschedule dialog
   * opens pre-populated with the item's CURRENT interval — so a biweekly
   * repeater's unit pop-up already reads `weeks` before the interval is touched
   * (0½ defect (c)). Overrides `value` when present.
   */
  valueCandidates?: string[];
  /** key: a keyboard spec (e.g. "down down return" for a dropdown pick). */
  keys?: string;
  /** wait: how long to poll for the element before aborting. */
  timeoutMs?: number;
  /**
   * set-group-number only: WHICH of the Repeat dialog's two numeric fields to
   * drive. `interval` = the cadence field ("Every [n] …"); `ends-count` = the
   * "Ends: after [n] times" field. Each is resolved by the ROW it sits on, so
   * the drive no longer depends on the order the dialog's controls were touched
   * or on whether a reschedule opened it pre-populated. Required for every
   * set-group-number step.
   */
  numberTarget?: "interval" | "ends-count";
  /**
   * set-group-number only: the rule state the cadence group is expected to be in
   * when this step runs, so the shape manifest can say what the group should look
   * like (`src/write/vectors/ui-shape.ts`). A group that already SHOWS that state
   * has finished re-laying out, so the settle can stop on its first read instead
   * of waiting for two agreeing ones. Advisory: an expectation that does not
   * match simply leaves the BEEP1 agreement rule deciding, as it always did.
   */
  cadence?: { afterCompletion: boolean; endsAfter: boolean };
  /**
   * set-row-field only: the pinned English static text whose ROW the target field
   * shares (`days earlier` for the start-offset field). Locale fail-closed, like
   * every other title-pinned selector here.
   */
  rowLabel?: string;
  /**
   * audit-dialog only: the complete set of controls to re-read before the commit,
   * with the value the drive intended for each. Built by the recipe from its own
   * emitted steps, so the audit and the drive can never disagree about which
   * controls were touched.
   */
  audit?: DialogAuditPlan;
  /**
   * click-element only: resolve the click target by walking the addressed
   * content TABLE's rows → cells → cell children for the element whose
   * `AXDescription` equals this, instead of resolving `path` itself. The heading
   * row's `…` button is the one control that needs it: it carries its heading's
   * title in `AXDescription` ("More. <title>"), but it sits three levels below
   * the table, and a `whose` clause on `UI elements of <table>` searches only
   * the table's DIRECT children — the rows — so the shipped one-level spelling
   * matched nothing and every ellipsis drive died at its own frame resolution
   * (measured on Things 3.23, docs/lab/hxpc1-picker-assert.md §B0 — the same
   * frame-resolution miss the timestamp cells recorded against the golden-v2
   * rig). The walk is an exact match and fails closed naming what it sought.
   */
  rowCellDescription?: string;
  /**
   * click-element only: the element expected to appear right AFTER the click
   * (a popover opening, a sheet appearing). The driver polls for it and, on
   * mismatch, sends Escape to dismiss whatever DID open and aborts fail-closed
   * — so a click that lands somewhere unexpected never cascades into blind
   * presses. Omitted for a TERMINAL click (one that dismisses the popover with
   * no successor element); the write pipeline's read-after-write check is the
   * outcome verifier there.
   */
  assertPath?: string;
  /** click-element only: human-readable name of the asserted element (report). */
  assertLabel?: string;
  /** click-element only: how long to poll for `assertPath` before aborting. */
  assertTimeoutMs?: number;
  /**
   * The element appears only AFTER a preceding press (a sheet/popover), so it
   * is NOT resolvable in the preflight canary — the driver waits for it at run
   * time instead. Static steps (menu-bar paths) are canary-resolved up front.
   */
  dynamic?: boolean;
  /** How the element is addressed — pinned English title, or a stable AXIdentifier. */
  addressing?: "title" | "axidentifier";
  /**
   * activate only: this foregrounding step is a fallback that may be skipped
   * once certification proves background AXPress works (see the runbook).
   */
  activateFallback?: boolean;
  /** drag-reorder only: the sidebar move the drag driver performs. */
  drag?: import("./ui-drag.ts").SidebarDragSpec;
  /** chord-reorder only: the heading order the chord driver steps the project into. */
  chord?: import("./ui-chord.ts").HeadingChordSpec;
  /**
   * set-datetime only: WHICH of the dialog's date areas to drive (ANCH2). The
   * driver selects deterministically — `reminder` = the only time-bearing area;
   * `next` = the top (smaller-y) midnight date picker; `ends` = the bottom
   * (larger-y) midnight date picker. Required for every set-datetime step.
   */
  dtTarget?: "next" | "ends" | "reminder";
  /**
   * ensure-checkbox only: the desired checkbox state. The driver reads the
   * control's `AXValue` and presses ONLY when it differs from this target, then
   * confirms convergence (RRD1 closed loop). Required for every ensure-checkbox step.
   */
  checkboxTarget?: boolean;
  /**
   * Run this step ONLY under the named Repeat-dialog shape (RDLG2). The two
   * shapes present the FIRST-OCCURRENCE control as different element CLASSES —
   * an `AXDateTimeArea` (legacy) versus an `AXPopUpButton` (next-popup) — so the
   * recipe emits BOTH drives and the driver executes the one matching the shape
   * its `probe-dialog-shape` step measured. A step carrying this field with no
   * shape probed fails closed.
   */
  onlyShape?: RepeatDialogShape;
  /**
   * Per-shape overrides merged into the step once the dialog shape is probed
   * (RDLG2). The 3.23 `Next:` pop-up sits between Ends and every per-frequency
   * control, shifting their group indices by +1 — so the SAME step carries both
   * index sets and the driver picks by measured structure, never by app version.
   * A step carrying this field whose probed shape has no entry fails closed.
   */
  shaped?: Partial<Record<RepeatDialogShape, { pathCandidates?: string[]; value?: string }>>;
}

/**
 * ONE control of the pre-commit dialog audit, as the RECIPE declares it — before
 * the driver has resolved which dialog shell is live or which shape the dialog is.
 * Paths are per-shell candidate lists in the same order as {@link DialogAuditPlan.shells}.
 */
export interface DialogAuditControl {
  /** Human name of the control, as the mismatch report should say it. */
  label: string;
  kind:
    | "popup"
    | "checkbox"
    | "group-number"
    | "row-field"
    | "weekdays"
    | "occurrence-popup"
    | "date-area";
  /** popup / checkbox / occurrence-popup: per-shell candidate paths. */
  pathCandidates?: string[];
  /** group-number: which of the cadence group's numeric fields. */
  numberTarget?: "interval" | "ends-count";
  /** row-field: the pinned English label sharing the field's row. */
  rowLabel?: string;
  /** weekdays: the group pop-up index of the first weekday row. */
  weekdayBase?: number;
  /** date-area: which of the dialog's `AXDateTimeArea` controls. */
  dtTarget?: "next" | "ends" | "reminder";
  /** date-area: the spec the drive wrote (`date:YYYY-MM-DD` / `time:HH:mm`). */
  dtSpec?: string;
  /** The accepted observed values — ANY one satisfies (the singular/plural pair). */
  expected?: string[];
  /** How the intended value should READ in the report ("checked", not "1"). */
  expectedLabel?: string;
  /** Check this control ONLY under the named dialog shape (the +1-index fork). */
  onlyShape?: RepeatDialogShape;
  /** Per-shape overrides, merged once the dialog shape is measured. */
  shaped?: Partial<Record<RepeatDialogShape, { pathCandidates?: string[]; weekdayBase?: number }>>;
}

/** The pre-commit audit an `audit-dialog` step carries. */
export interface DialogAuditPlan {
  /** The dialog shells, in the SAME priority order the drive resolves them. */
  shells: string[];
  /** The cadence group inside each shell (same order as {@link shells}). */
  groups: string[];
  controls: DialogAuditControl[];
  /**
   * The OK button, per shell (same order as {@link shells}). Present when the
   * audit should COMMIT in its own script the moment every control agrees, which
   * is how the recipe emits it: the audit and the press used to be two hops with
   * a driver round trip between them, and what is committed must be the state the
   * audit read, with nothing dispatched in between (RDLAT2).
   */
  commits?: string[];
  /**
   * The cadence group's expected shape for the FINAL rule state, from the shape
   * manifest — advisory, letting the settle stop on the first read that already
   * shows it (RDLAT2, `src/write/vectors/ui-shape.ts`).
   */
  cadence?: { afterCompletion: boolean; endsAfter: boolean };
}

/**
 * The structural SHAPE of the Repeat dialog, MEASURED live (never sniffed from
 * the app version — a version string says nothing about the tree the driver has
 * to address, and a point release can move either way):
 *
 * - `next-popup` — Things 3.23+: the first occurrence is an `AXPopUpButton`
 *   listing Today + the rule's own upcoming occurrences; it sits between Ends and
 *   the per-frequency controls, so those are at +1.
 * - `legacy` — Things ≤ 3.22: the first occurrence is a free-form
 *   `AXDateTimeArea` and the per-frequency controls follow Ends directly.
 *
 * Both shapes label that row `Next:` (measured on 3.22.14 and 3.23 alike), so the
 * probe discriminates on the CONTROL CLASS occupying the row, not the label.
 *
 * Anything matching NEITHER shape is a third, unknown dialog — the drive
 * refuses rather than press indexes it cannot vouch for.
 */
export type RepeatDialogShape = "next-popup" | "legacy";

export interface VectorSupport {
  support: "yes" | "partial" | "no";
  /**
   * Disruption tier observed by the lab WITH THINGS ALREADY RUNNING. The
   * pipeline guarantees that state via its ensure-running step (an
   * AppleEvent or plain open to a closed Things steals focus — A40/A41).
   */
  disruption: DisruptionTier;
  validation: "validated" | "assumed" | "unvalidated";
  /** Probe ids backing this entry (u-suite / a-suite evidence). */
  evidence?: string[];
  /**
   * Rides an UNDOCUMENTED app surface (e.g. `_private_experimental_` sdef
   * commands). Requires config allowExperimental AND the pipeline's sdef
   * canary — the surface can vanish in any Things update.
   */
  experimental?: boolean;
  notes?: string;
}

export type VectorMatrix = Partial<Record<OperationKind, VectorSupport>>;

/**
 * How the ui vector's audited cleanup ladder left an open dialog (issue #620):
 * `none` — nothing was open; `dismissed` — closed, and a fresh read confirmed
 * it closed; `cleared-blind` — cleared by the window close+reopen on an
 * AX-blind session, so it cannot be confirmed; `foreign` — a dialog this drive
 * did not open was found and deliberately LEFT ALONE; `may-remain` — ours, and
 * nothing in the ladder would close it (the stranded case, which also holds
 * Things Cloud sync until someone dismisses it).
 */
export type UiClearOutcome = "none" | "dismissed" | "cleared-blind" | "foreign" | "may-remain";

export interface ExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /**
   * The drive's step play-by-play as a LIST — one compact entry per recipe step
   * that ran, in order (the same labels `stdout` renders as one prose line).
   * Emitted by the ui vector on every drive, complete or partial; absent on the
   * transport vectors, which have no steps.
   *
   * This is the DIAGNOSTIC LADDER's middle rung (#632): it never rides a success
   * result by default (it made the field bug reports rich and costs context on
   * every success), the change-history record ALWAYS captures it, `--verbose`
   * opts a success back into it, and a failure always carries it.
   */
  steps?: string[];
  /**
   * Things a SUCCESSFUL drive has to say for itself that outlive the drive — a
   * side effect on the app's own state that the caller is entitled to know
   * about, as opposed to the play-by-play in {@link steps}. Currently: the
   * sidebar areas the collapse rung folded away and re-expanded (SBCOL1).
   *
   * The pipeline routes these through the disclosure registry as `note`-tier
   * lines, so they ride a success result rather than being failure-only.
   */
  notices?: string[];
  /** The transport was killed by its own deadline — the signature of an unanswered consent dialog. */
  timedOut?: boolean;
  /**
   * The vector REFUSED at runtime BEFORE touching the app — a precondition it
   * can only check live (the ui vector's session-reachability gate: a locked
   * screen / full-screen Space leaves no AX-reachable Things window for the
   * dialog, SESSGATE #480). The pipeline maps this to a `blocked` outcome
   * (exit 4), never a transport failure — nothing was mutated.
   */
  blocked?: { hazard: HazardId; detail: string; remediation: string };
  /**
   * The ui vector's overall-drive WATCHDOG fired: the drive exceeded its budget
   * so the CLI — not the caller — gave up first, cleared any open dialog, and
   * returned (TRACE1, #487). Carried alongside a nonzero `exitCode` + `timedOut`
   * so the pipeline routes it through the existing transport-failure re-verify
   * (a mid-commit OK may still have landed), then shapes an HONEST timeout:
   * confirmed-landed → ok with a disclosure; not-confirmed → verify-failed with
   * `uncertain` set and the trace path, since a drive aborted mid-commit cannot
   * promise the app is untouched. See {@link drive}.
   */
  watchdog?: {
    budgetMs: number;
    elapsedMs: number;
    /** The step the drive was about to run (or running) when the budget blew. */
    lastStep: string;
    /** How the open dialog was cleaned up (the audited cleanup ladder's outcome). */
    clear: UiClearOutcome;
    /** The local trace file reconstructing the timeline, when tracing is on. */
    tracePath?: string | null;
  };
  /**
   * A ui drive stopped because the Things WINDOW stopped answering — not because
   * the app accepted a command and did nothing (issue #512). The pre-seed and
   * in-drive reachability gates catch a session that is ALREADY AX-blind; this
   * covers the state that degrades UNDER a running drive (the screen locks, a
   * full-screen app takes the Space, the app stops answering a step before its
   * per-step deadline). Carried alongside a nonzero `exitCode` so the pipeline
   * still runs the transport-failure re-verify (a step that landed before the
   * abort is still honored), and, when nothing landed, shapes
   * `verify-failed:ui-unreachable` — an ENVIRONMENT failure naming the step and
   * the recovery — instead of `verify-failed:silent-noop`, which claims the app
   * was reachable and chose to do nothing. See {@link drive}.
   */
  uiUnreachable?: {
    /** The drive step that stopped (the label the recipe gave it). */
    step: string;
    /**
     * "unreachable" — the cleanup's own blindness probe found NO Things window on
     * the current screen (locked Mac / full-screen Space); "unresponsive" — the
     * step was killed by its own deadline, so the window may be reachable but did
     * not answer in time.
     */
    cause: "unreachable" | "unresponsive";
    /** How a half-open sheet was cleaned up, when the drive had opened one. */
    clear?: UiClearOutcome;
    /** What the caller does to make a retry work. */
    remediation: string;
  };
}

export interface WriteVector {
  id: VectorId;
  matrix: VectorMatrix;
  execute(invocation: CompiledInvocation): Promise<ExecuteResult>;
  /**
   * ui vector ONLY: probe whether a Things window is AX-reachable on the current
   * Space, so a promote ORCHESTRATOR can gate BEFORE it seeds a row (SESSGATE
   * #480). It returns a not-reachable verdict scoped "session" (locked screen /
   * full-screen — the certain-failure case the orchestrator refuses on, zero
   * mutation) or "window" (only Things' window is off-Space — the orchestrator
   * proceeds; the in-drive gate relocates it). Absent on the real transport
   * vectors and the simulator, so a caller with no ui vector simply skips the gate.
   */
  probeReachability?: () => Promise<import("./session-reachability.ts").ReachabilityVerdict>;
  /**
   * ui vector ONLY: read the window/focus census (read-only — no click, no
   * keystroke, no activation), so a composite ORCHESTRATOR can refuse BEFORE it
   * seeds a row when a dialog is already standing in Things (MODALX1, issue
   * #620). Measured: the seed leg rides the URL scheme, which an open dialog
   * does not touch, so the copy lands and then every AppleScript leg after it
   * fails with `-1728` — the compound mutates for a reason it could have known
   * up front. Null means the state could not be read; the caller proceeds (the
   * drive's own precondition is the backstop). Absent on the real transport
   * vectors and the simulator.
   */
  probeUiState?: () => Promise<import("./ui-state.ts").UiState | null>;
  /**
   * The bench-harness SIMULATOR vector (src/write/vectors/simulator.ts). It
   * presents under a real {@link VectorId} but applies mutations via SQL from
   * the structured `invocation.op`/`opParams`, never from a compiled payload.
   * A single VectorId cannot satisfy the transport-specific `spec.compile` of
   * EVERY operation (some are url-scheme-only, others applescript/shortcuts), so
   * the pipeline SKIPS compile for a simulator and hands it structured input
   * directly. Undefined/false for every real transport vector.
   */
  simulates?: boolean;
  /**
   * This vector dispatches REAL Apple Events to Things, so it is subject to the
   * app-control gate (docs/design/permissions-doctrine.md, Articles I + II):
   * on a machine macOS holds no consent record for, that event IS the dialog,
   * so the pipeline establishes standing prompt-free and refuses before
   * dispatch rather than letting the send raise a modal.
   *
   * Set ONLY by {@link import("./applescript.ts").createAppleScriptVector}. It
   * is deliberately not inferred from {@link id}: engine tests substitute fake
   * vectors under the real ids, and a fake that sends nothing must not be
   * gated on the host's actual TCC state — that would make test outcomes
   * depend on the developer's own grants.
   */
  sendsAppleEvents?: boolean;
  /**
   * This vector drives the Things WINDOW through the Accessibility API, so it
   * is subject to the GUI-driving gate (docs/design/permissions-doctrine.md,
   * Article IV): Accessibility plus Automation → System Events, granted to the
   * helper pair and to nothing else. On a machine that holds neither, the drive
   * would raise an Accessibility prompt against whatever host app is running
   * us, so the pipeline establishes standing prompt-free and refuses first.
   *
   * Set ONLY by {@link import("./ui.ts").createUiVector}. Deliberately not
   * inferred from {@link id} — engine and simulator tests substitute fakes
   * under the real ids, and a fake that never touches the AX tree must not be
   * gated on the host's actual TCC state (the Wave A lesson: an id-keyed gate
   * imports the developer's own grants into CI).
   */
  drivesGui?: boolean;
  /**
   * This vector delivers MUTATIONS through `things:///` URLs, so it is subject
   * to Things' own in-app authorization — Settings ▸ General ▸ "Enable Things
   * URLs" (URLEN1, #611). No macOS consent class is involved, but the two
   * not-enabled states are both silent from the caller's side: an explicitly
   * disabled app discards the command outright, and an app nobody has answered
   * the first-use dialog for PARKS the command behind that dialog. Either way
   * the write reports a silent no-op minutes later, so the pipeline reads the
   * setting prompt-free and refuses before dispatch instead.
   *
   * Set ONLY by {@link import("./url-scheme.ts").createUrlSchemeVector}, for the
   * same reason as its two siblings above: engine tests substitute fakes under
   * the real ids, and a fake that opens no URL must not be gated on the state of
   * the developer's own Things install.
   */
  dispatchesUrls?: boolean;
}
