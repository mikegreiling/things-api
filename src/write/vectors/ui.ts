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
import { chordCommand, driveHeadingChordReorder } from "./ui-chord.ts";
import {
  AX_SETTLE_LOG_PREFIX,
  inertSettleInjector,
  observerAwait,
  observerCount,
  observerMark,
  type ObserverSession,
  parseSettleLog,
  type SettleInjector,
  type SettleSpec,
  settleInjectorFor,
  startObserver,
  stopObserver,
} from "./ui-observer.ts";
import { driveSidebarAreaReorder, jxaSidebarSnapshotScript, type UiDriveAux } from "./ui-drag.ts";
import {
  type CadenceExpectation,
  cadenceExpectationFor,
  installedThingsVersion,
  matchRepeatShell,
  parseDialogOpenSnapshot,
  shapeManifestCoversVersion,
} from "./ui-shape.ts";
import {
  AX_ELEMS_LOG_PREFIX,
  AX_DIALOG_SHELL_SNIPPET,
  axFocusGuardPrelude,
  CENSUS_TIMEOUT_MS,
  censusUnverifiable,
  describeFocusOwner,
  describeUnprovenProbes,
  GUARD_REFUSED_TAG,
  parseGuardLog,
  readUiState,
  SYNC_GATE_WARNING,
  THINGS_PROCESS,
  type UiSheetKind,
  type UiState,
} from "./ui-state.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  RepeatDialogShape,
  UiClearOutcome,
  UiPrimitive,
  UiRecipe,
  UiStep,
  VectorMatrix,
  WriteVector,
} from "./types.ts";

/** GUI driving can stall on an unanswered sheet; give each step headroom. */
const STEP_TIMEOUT_MS = 15_000;
/**
 * How long a candidate-addressed control is polled for before the step fails
 * closed. The full-vocabulary dialog reveals a pop-up/field a beat AFTER the
 * frequency/Ends switch that precedes it (UIC6: ~250 ms), so the effective-form
 * resolution must poll, not snap once. Since DRVLAT1 (issue #633) that poll runs
 * IN-SCRIPT, inside the hop that acts on the control ({@link axCandidatePrelude}),
 * rather than as its own osascript round-trip per candidate per round.
 */
const RESOLVE_CANDIDATE_TIMEOUT_MS = 5_000;
/**
 * In-script poll cadence for the element waits the drive folded into their own
 * hops (DRVLAT1, issue #633). The JS-side poll it replaces was kept at a coarse
 * 300ms deliberately — it paid a PROCESS SPAWN per round (PERF2 S5b), so a finer
 * interval bought detection at the price of hops. An in-script poll pays one
 * addressed `exists` per round, so it can be fine enough that a wait ends when
 * the element lands rather than at the next 300ms boundary.
 */
const IN_SCRIPT_POLL_S = 0.05;
/**
 * How long the canary and the eligibility assertion poll for the menu bar to
 * repopulate around the newly-selected target (UIC1: the Items ▸ Repeat submenu
 * appears only once a matching item is selected, and the update is not
 * instantaneous).
 *
 * This REPLACES the fixed post-preamble settle (DRVLAT1, issue #633). That settle
 * was 1500ms, trimmed to 1000ms by PERF2 against a measured ~92ms median / 116ms
 * max menu repopulation (S5a) — i.e. it spent ~900ms of every drive waiting out a
 * margin, on every host, whether or not the menu was already there. The closed-loop
 * form is strictly better on both axes: it proceeds the moment the menu answers
 * (the common case, ~one poll), and it tolerates a host slower than any fixed
 * settle would have covered. Under-margining still only ever costs a fail-closed
 * refusal, never a bad write (determinism doctrine; BEEP1 shape-settle precedent).
 */
const MENU_SETTLE_TIMEOUT_MS = 4_000;
/**
 * Default window for a click's post-condition wait when the step names none.
 * Every recipe that asserts one sets 5000 explicitly; this only keeps the
 * in-script poll comfortably INSIDE the hop's own {@link STEP_TIMEOUT_MS}, which
 * a 15s default would not (the poll would outlive its transport).
 */
const WAIT_ASSERT_TIMEOUT_MS = 5_000;

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
  | "sidebar-held-drag"
  /**
   * Actuate an area row's disclosure chevron, folding its projects out of the
   * drag path (SBCOL1). A pointer click at the chevron's own resolved frame —
   * `AXPress` on the node that advertises it is decorative (REPX1 §1.2).
   */
  | "sidebar-chevron"
  /**
   * Show or hide the sidebar through Things' own View menu (SBRES1). The drag
   * ladder's normalization rung: a hidden sidebar is revealed for the move and
   * hidden again in the epilogue, so a drive never leaves the user's window
   * chrome changed.
   */
  | "sidebar-visibility"
  /** One modifier-bearing key event pair posted straight at the Things process (ui-chord.ts). */
  | "chord-post"
  /**
   * The cleanup ladder's first rung: press the open dialog's own Cancel button
   * (issue #620). Its own primitive rather than a `press` so a recipe's
   * actuations and the cleanup's are never confused — in a trace, in a test, or
   * in the completed-steps trail.
   */
  | "dismiss-dialog"
  /**
   * Arm the AX settle observer (VOPAT2, ui-observer.ts): read the Things pid and
   * background the `python3` ctypes sidecar from INSIDE the hop, so it inherits
   * the Accessibility identity that already holds the grant. Reads no control,
   * presses nothing, and answers `no-process` rather than guessing.
   */
  | "observer-spawn";

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
  /**
   * ACCESSIBILITY ROUND-TRIPS this hop made — the Apple events its osascript
   * sent to System Events (RDLAT2). Present only while round-trip counting is
   * armed (see {@link axRoundTripCountingArmed}); absent otherwise, and absent
   * for the `reveal` primitive, which sends no Apple event at all.
   *
   * This is the unit the FIELD pays in. A hop's wall time on a clone is mostly
   * its process spawn; on the maintainer's Mac the same hop is dominated by how
   * many questions it asks the tree, because each one costs an order of
   * magnitude more there (~20 ms against ~1.7 ms, measured 2026-09-02). Counting
   * them is therefore the only per-hop number that transfers between hosts.
   */
  axOps?: number;
  /**
   * DISTINCT CONTROLS whose CONTENT this hop read (RDLAT2). Absent when the hop
   * reported none. This is the term that predicts a field wall time — see
   * {@link AX_ELEMS_LOG_PREFIX} — and unlike {@link axOps} it needs no
   * environment switch and survives deputy routing, because the scripts report
   * it themselves.
   */
  axElems?: number;
  /**
   * NOTIFICATION SETTLES this hop performed (VOPAT2) — one record per in-script
   * wait, `<what> ~ <the sidecar's reply>`, carrying the notification that fired
   * and its latency from the mark. Absent when the hop settled on nothing (the
   * polling fallback, or a hop with no settle at all).
   *
   * This is the third quantity a field trace needs, beside {@link axOps} and
   * {@link axElems}: how long the APP took to announce, which is the term the
   * drive cannot make smaller and the one it should end up bound by.
   */
  settles?: string[];
}

/**
 * The environment switch that arms AX ROUND-TRIP COUNTING (RDLAT2).
 *
 * When it is set, every osascript this vector spawns runs with Apple's
 * `AEDebugSends` diagnostic enabled: the interpreter logs one line per Apple
 * event it SENDS, which is exactly one line per Accessibility round-trip. The
 * dispatch seam counts those lines into {@link UiRunResult.axOps} and REMOVES
 * them from the hop's stderr, so every refusal a caller reads is unchanged.
 *
 * Off by default and never armed implicitly: a diagnostic that rewrites stderr
 * has no business running in an ordinary drive.
 *
 * ONE LIMITATION, stated plainly: the counting rides the environment of the
 * process that spawns osascript. On a host where the deputy carries automation,
 * that process is the deputy — not the CLI — so the variable has to be in ITS
 * environment for the count to appear. Where it is not, `axOps` is simply
 * absent and the trace still carries every hop's `durationMs`. On a machine with
 * the helpers switched off (`things config set helpers-enabled false`) the CLI
 * spawns osascript itself and the counts appear.
 */
export const AX_COUNT_ENV = "THINGS_API_AX_COUNT";

/**
 * THE ELEMENT-REALIZATION COUNTER (RDLAT2, field measurement 2026-09-02).
 *
 * Counting Apple events was the wrong unit, and the maintainer's sidebar probe
 * says why. A single attribute read costs 0.12 ms through the JXA bridge and
 * 0.05 ms through native ctypes — the IPC is not the cost. What costs is the app
 * REALIZING a view's content when Accessibility asks what is in it: ~115 ms per
 * element on a real Retina display, paid on the first content-bearing touch
 * (AXChildren / AXDescription / AXValue), paid AGAIN on a repeat sweep because
 * the app discards what it realized, and INDEPENDENT of tree depth and of how
 * many calls the sweep makes. A 174-row sidebar cost ~20 s at depth 2 (1,841
 * calls) and ~20 s at depth 6 (2,081 calls): the call count moved 13% and the
 * wall time did not move at all.
 *
 * So the number that predicts a field wall time is HOW MANY DISTINCT CONTROLS A
 * STEP READS THE CONTENT OF — and a plural read, the very thing that makes this
 * driver cheap in Apple events, touches N of them in ONE event. An event count
 * therefore under-reports exactly where the field pays most.
 *
 * Every script that reads control CONTENT logs how many controls that was.
 * Geometry (`position`, `size`) and `role` are NOT counted: they are answered
 * out of the layout the app already holds, and measured free — a 174-row
 * geometry sweep is ~2 ms against ~20 s for the same rows' content.
 *
 * Unlike {@link AX_COUNT_ENV}, this rides the script's own stderr rather than an
 * environment variable, so it works through the deputy and needs nothing but
 * `THINGS_API_TRACE=1`.
 */
export { AX_ELEMS_LOG_PREFIX };

/**
 * Sum every element-realization line out of a hop's stderr, and REMOVE them — a
 * refusal a caller reads must never carry the machinery. Returns null when the
 * hop logged none, so "touched no content" and "does not report" stay
 * distinguishable.
 */
export function parseElemLog(stderr: string): { axElems: number | null; stderr: string } {
  const kept: string[] = [];
  let total: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const at = line.indexOf(AX_ELEMS_LOG_PREFIX);
    if (at >= 0) {
      const n = Number.parseInt(line.slice(at + AX_ELEMS_LOG_PREFIX.length).trim(), 10);
      if (Number.isFinite(n)) total = (total ?? 0) + n;
      continue;
    }
    kept.push(line);
  }
  return { axElems: total, stderr: kept.join("\n").trim() };
}

/** One `AEDebugSends` line: `{core,cnte target='psn '[System Events] {…}`. */
const AE_SEND_LINE = /^\{\S+\s+target=/;

let axCountArmed: boolean | null = null;

/**
 * Is round-trip counting armed? Resolved once per process, and ARMING IT SETS
 * `AEDebugSends` in this process's environment — which is what every osascript
 * child then inherits. Exported for the unit matrix.
 */
export function axRoundTripCountingArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (axCountArmed === null) {
    const raw = (env[AX_COUNT_ENV] ?? "").trim().toLowerCase();
    axCountArmed = raw !== "" && raw !== "0" && raw !== "false" && raw !== "no";
    if (axCountArmed) env.AEDebugSends = "1";
  }
  return axCountArmed;
}

/** Test seam: forget the memoized arming decision. */
export function resetAxRoundTripCounting(): void {
  axCountArmed = null;
}

/**
 * Split an `AEDebugSends` stream into the round-trip COUNT and the text a caller
 * should see.
 *
 * MEASURED (RDLAT2, guest probe `aeprobe`): the diagnostic writes its lines to
 * **stdout**, interleaved ahead of the script's own result — which is exactly
 * the stream every step's verdict is parsed from (`"true"`, `"OK"`, a frame).
 * So the split runs over BOTH streams and removes every diagnostic line: an
 * armed count must not change a single verdict or a single refusal sentence.
 */
export function splitAeDebug(text: string): { axOps: number; text: string } {
  if (text === "") return { axOps: 0, text };
  const kept: string[] = [];
  let axOps = 0;
  for (const line of text.split("\n")) {
    if (AE_SEND_LINE.test(line)) axOps += 1;
    else kept.push(line);
  }
  return { axOps, text: kept.join("\n") };
}

/**
 * Low-level dispatch seam. Injectable so the driver's recipe orchestration,
 * canary, and abort logic are unit-testable WITHOUT ever touching a real GUI
 * (CLAUDE.md safety rails — the production app is never a valid target).
 */
export type UiRunner = (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>;

const SE = `tell application "System Events" to tell process "Things3"`;

/**
 * The cadence group's re-layout settle budget (BEEP1) — how many times
 * `set-group-number` re-reads the group's shape looking for two consecutive
 * identical reads, and how long it waits between reads. ~4s of headroom against
 * a re-layout measured to finish well inside 1.5s; the gate exits on the FIRST
 * agreeing pair, so the common (already-settled) case costs one extra read.
 */
const SETTLE_READS = 40;
const SETTLE_POLL_S = 0.1;

/**
 * Row tolerance (points) for every LABEL-ANCHORED field address here — how far a
 * control's y may sit from its label's y and still count as the same row.
 * Measured on Things 3.23 (CGRD1 §A census): `Every`@286 / interval@283,
 * `Ends:`@375 / count@372, `days earlier`@413 / start-offset@409 — a 3–4pt
 * baseline offset, so 8 is ~2× the observed worst case and well under the
 * ~45pt row pitch of the cadence group.
 */
const ROW_TOLERANCE = 8;

/**
 * How many of the Next: menu's own item titles a MISS reports back (NEXTPOP1).
 * A refusal that names only the date the dialog lacked cannot distinguish "the
 * rule genuinely does not produce that date" from "the menu was not the rule's"
 * — the two failures read identically, and the second one cost a whole campaign
 * to tell apart. Naming the pop-up's current value plus the first few options it
 * offered makes the refusal self-diagnosing. Bounded so a 100-item level cannot
 * flood the message.
 */
const SAMPLE_ITEMS = 5;

/**
 * The `Next:` occurrence pop-up's asynchronous-recompute budget (NEXTPOP1) — how
 * long {@link axSettleOccurrencesScript} waits for the dialog to absorb a rule
 * change before the drive touches it again, and how often it looks. MEASURED at
 * **0.4s** on golden-v4 / Things 3.23 (DIAG4: the control flipped from the seed's
 * first occurrence to the anchor's between t+0.3s and t+0.4s), so the budget is
 * ~3× the observed latency; the poll exits early the moment the control moves,
 * which is the only case that costs anything.
 */
const OCCURRENCE_SETTLE_MS = 1200;
const OCCURRENCE_POLL_MS = 100;

/**
 * The shared AppleScript handler prelude for every LABEL-ANCHORED field address
 * in the Repeat dialog — the HXPC1 discrimination law in ONE place, so the
 * pre-commit audit re-reads each field through the SAME address the drive wrote
 * it through (a self-referential read-back is exactly what let #589's wrong-field
 * write report OK).
 *
 * The laws, all measured on Things 3.23 / build 32300036 (CGRD1 §A census, and
 * HXPC1 §A before it — docs/lab/cgrd1-precommit-audit.md, hxpc1-picker-assert.md):
 *
 *  - The cadence group's numeric fields are identified by the LABEL ROW they sit
 *    on, never by index among the group's text fields. Selecting an "Ends: after"
 *    bound INSERTS the count AHEAD of the interval, so index 1 is a different
 *    control at different moments.
 *  - The interval is matched POSITIVELY, on the `Every` label's row. Every fixed
 *    frequency (daily/weekly/monthly/yearly) carries that label at y=286 with the
 *    interval at y=283. An AFTER-COMPLETION cadence group carries NEITHER an
 *    `Every` nor an `Ends:` label (census: its only static text is "after previous
 *    item is checked off.") and offers exactly ONE text field — so that shape falls
 *    to the sole-field rule, which is itself a uniqueness check, not an index.
 *  - Anything else FAILS CLOSED reporting the whole numeric-field inventory rather
 *    than typing a number into a field it cannot vouch for. An AX tree is an
 *    undocumented private surface: an unrecognized shape is a refusal, never a
 *    best guess.
 */
const AX_CADENCE_HANDLERS = `on cgSnap(c)
  -- ONE INVENTORY, FOUR APPLE EVENTS (RDLAT2).
  --
  -- Every discrimination below — which row a label sits on, which field shares
  -- it, whether the group has stopped re-laying out — is a question about the
  -- SAME instant. These handlers used to ask the tree one control at a time
  -- ("count of static texts", then "value of static text 1", then "value of
  -- static text 2", …), which costs an Accessibility round-trip PER CONTROL and
  -- per repetition: a monthly cadence group answered eight events for a single
  -- scan, and cgField ran three such scans. AppleScript will answer a PLURAL
  -- property in one event, so the whole inventory is four — values and positions
  -- of the static texts, values and positions of the text fields — no matter how
  -- many controls there are. That is the same measurement, taken closer together,
  -- for a fraction of the round-trips (MEASURED: 72 ms → 23 ms per scan on the
  -- clone; the field pays each round-trip an order of magnitude more).
  --
  -- The two reads of a class are still two events, so a tree that changes between
  -- them can return mismatched lengths. That is reported as an INVALID snapshot
  -- (an empty signature), which the settle below treats as "not settled yet"
  -- rather than reasoning from half a picture.
  set sv to {}
  set sp to {}
  set fv to {}
  set fp to {}
  tell application "System Events"
    try
      set sv to (value of static texts of c)
      set sp to (position of static texts of c)
    end try
    try
      set fv to (value of text fields of c)
      set fp to (position of text fields of c)
    end try
  end tell
  set ok to ((count of sv) is (count of sp)) and ((count of fv) is (count of fp))
  -- REPORT WHAT THIS COST (RDLAT2). The two VALUE reads realize every static
  -- text and every numeric field in the container; the two POSITION reads are
  -- answered out of the layout the app already holds and are free. On the
  -- maintainer's Mac the realized ones are ~115 ms each, so this line is the
  -- only per-hop number that predicts a field wall time.
  log "${AX_ELEMS_LOG_PREFIX}" & ((count of sv) + (count of fv))
  return {my cgTexts(sv), my cgYs(sp), my cgTexts(fv), my cgYs(fp), ok}
end cgSnap

on cgTexts(lst)
  -- A control with no value reads as \`missing value\`; the per-control loop this
  -- replaces caught that with a \`try\` and defaulted to "", so this does too.
  set out to {}
  repeat with v in lst
    set c to contents of v
    if c is missing value then
      set end of out to ""
    else
      try
        set end of out to (c as text)
      on error
        set end of out to ""
      end try
    end if
  end repeat
  return out
end cgTexts

on cgYs(lst)
  -- A position is {x, y}; every row rule here is about the y.
  set out to {}
  repeat with p in lst
    set c to contents of p
    try
      set end of out to (item 2 of c)
    on error
      set end of out to -1000000
    end try
  end repeat
  return out
end cgYs

on cgValid(snap)
  return (item 5 of snap)
end cgValid

on cgSig(snap)
  -- The SHAPE SIGNATURE the settle compares: the static texts' values and the
  -- numeric fields' row positions — byte-for-byte the signature the per-control
  -- loop built, so the settle's behavior is unchanged. An invalid snapshot has no
  -- signature, so it can never compare equal to anything (including itself).
  if not (my cgValid(snap)) then return ""
  set s to ""
  repeat with v in (item 1 of snap)
    set s to s & "|s:" & (contents of v)
  end repeat
  repeat with y in (item 4 of snap)
    set s to s & "|f:" & (contents of y)
  end repeat
  return s
end cgSig

on cgLabelY(snap, want)
  -- The y of the LAST static text whose value is exactly \`want\` — the same rule
  -- (and the same last-wins behavior) as the loop it replaces, computed from the
  -- snapshot instead of re-asking the tree.
  set outY to missing value
  set vals to item 1 of snap
  set ys to item 2 of snap
  repeat with i from 1 to (count of vals)
    if (contents of (item i of vals)) is want then set outY to (item i of ys)
  end repeat
  return outY
end cgLabelY

on cgOnRow(snap, y, tol, want)
  -- The INDEXES of the numeric fields that do (or do not) share row \`y\`.
  set hits to {}
  set ys to item 4 of snap
  repeat with i from 1 to (count of ys)
    set dy to (item i of ys) - y
    if dy < 0 then set dy to -dy
    set onRow to (dy <= tol)
    if onRow is want then set end of hits to i
  end repeat
  return hits
end cgOnRow

on cgInventory(snap)
  set inv to ""
  set vals to item 3 of snap
  set ys to item 4 of snap
  repeat with i from 1 to (count of ys)
    set inv to inv & " #" & i & "(y=" & (item i of ys) & ",shows=" & (contents of (item i of vals)) & ")"
  end repeat
  if inv is "" then set inv to " (none)"
  return inv
end cgInventory

on cgMatches(snap, wantFields, need, forbid)
  -- THE SHAPE MANIFEST'S CHECK (RDLAT2, src/write/vectors/ui-shape.ts): does this
  -- inventory look like the state the drive has just produced? \`wantFields\` < 0
  -- means the caller has no expectation for this state, so nothing is asserted.
  if wantFields < -1 then return false
  if not (my cgValid(snap)) then return false
  if wantFields > -1 then
    if (count of (item 3 of snap)) is not wantFields then return false
  end if
  repeat with w in need
    if (my cgLabelY(snap, contents of w)) is missing value then return false
  end repeat
  repeat with w in forbid
    if (my cgLabelY(snap, contents of w)) is not missing value then return false
  end repeat
  return true
end cgMatches

on cgSettle(c, wantFields, need, forbid)
  -- SETTLE ON THE GROUP'S OWN SHAPE, never on a clock (determinism doctrine).
  -- A frequency switch REBUILDS the cadence group. Two things go wrong when a
  -- read starts too early: the row discrimination reads positions from controls
  -- that are still moving, and keystrokes land on a field being torn down —
  -- unhandled, so macOS beeps (BEEP1). Poll until two consecutive reads of the
  -- group's label + field-position signature agree, then proceed.
  --
  -- RETURNS THE SETTLED SNAPSHOT (RDLAT2). It used to return \`true\` and leave
  -- every caller to go and read the group again; handing back the inventory that
  -- was just PROVEN stable removes those reads and — more to the point — makes
  -- the addressing decision on the very instant the settle vouched for, instead
  -- of on a later one nobody checked.
  -- WITH AN EXPECTATION, THE SETTLE WAITS FOR IT (RDLAT2). Agreement alone is
  -- only the absence of movement, and the absence of movement is also what the
  -- group looks like BEFORE the step's own input has taken effect — which is how
  -- the ends-count step read a one-field group, stable and stale, and refused
  -- ("0 field(s) on the Ends: row") the moment the reads got cheap enough to land
  -- inside that window. Where the manifest can say what the finished state looks
  -- like, the settle waits for THAT and for it to hold still, so what it returns
  -- is a group that has demonstrably finished the transition rather than one that
  -- has not started it. Where it cannot (a fixed frequency switching to another
  -- fixed frequency looks identical either side), the agreement rule stands
  -- alone, exactly as before.
  set sig to ""
  set prevSig to "<none>"
  set snap to missing value
  set matched to false
  repeat ${SETTLE_READS} times
    set prevSig to sig
    set snap to my cgSnap(c)
    set sig to my cgSig(snap)
    set matched to my cgMatches(snap, wantFields, need, forbid)
    if (sig is prevSig) and (my cgValid(snap)) then
      if (wantFields < -1) or matched then return snap
    end if
    delay ${SETTLE_POLL_S}
  end repeat
  if wantFields > -2 then error "the Repeat dialog's cadence group never took the shape this step expects — the control the step was about to drive is not the one the dialog is showing; numeric fields:" & my cgInventory(snap)
  error "the Repeat dialog's cadence group is still re-laying out — its shape changed on every read; last seen" & sig
end cgSettle

on cgField(g, snap, target, tol)
  set endsY to my cgLabelY(snap, "Ends:")
  set everyY to my cgLabelY(snap, "Every")
  set nf to (count of (item 3 of snap))
  if target is "ends-count" then
    if endsY is missing value then error "the Repeat dialog's cadence group carries no \\"Ends:\\" label, so the ends-after count field cannot be identified — numeric fields:" & my cgInventory(snap)
    set hits to my cgOnRow(snap, endsY, tol, true)
    if (count of hits) is not 1 then error "the Repeat dialog offers " & (count of hits) & " field(s) on the \\"Ends:\\" row, expected exactly 1 — numeric fields:" & my cgInventory(snap)
    return my cgAt(g, item 1 of hits)
  end if
  if everyY is not missing value then
    set hits to my cgOnRow(snap, everyY, tol, true)
    if (count of hits) is not 1 then error "the Repeat dialog offers " & (count of hits) & " field(s) on the \\"Every\\" row, expected exactly 1 — numeric fields:" & my cgInventory(snap)
    return my cgAt(g, item 1 of hits)
  end if
  if endsY is not missing value then
    set hits to my cgOnRow(snap, endsY, tol, false)
    if (count of hits) is not 1 then error "the Repeat dialog offers " & (count of hits) & " field(s) off the \\"Ends:\\" row, expected exactly 1 — numeric fields:" & my cgInventory(snap)
    return my cgAt(g, item 1 of hits)
  end if
  if nf is not 1 then error "the Repeat dialog's cadence group carries neither an \\"Every\\" nor an \\"Ends:\\" label and offers " & nf & " numeric field(s), so the interval cannot be identified — numeric fields:" & my cgInventory(snap)
  -- Reached ONLY after the line above proved the group holds exactly one text
  -- field, so this is a uniqueness statement, not an index. The after-completion
  -- cadence group is that shape (MEASURED, CGRD1 §A: its only static text is
  -- "after previous item is checked off.", one field).
  return my cgAt(g, 1)
end cgField

on cgAt(c, i)
  -- The element at an index the RULES above resolved. Never a bare index: every
  -- caller reaches here only through a label-row match or a proven uniqueness.
  tell application "System Events" to return text field i of c
end cgAt

on rfInventory(snap)
  return my cgInventory(snap)
end rfInventory

on rfField(c, snap, rowLabel, tol)
  set labelY to my cgLabelY(snap, rowLabel)
  if labelY is missing value then error "the Repeat dialog shows no \\"" & rowLabel & "\\" label, so the field beside it cannot be identified — text fields:" & my rfInventory(snap)
  set hits to my cgOnRow(snap, labelY, tol, true)
  if (count of hits) is not 1 then error "the Repeat dialog offers " & (count of hits) & " field(s) on the \\"" & rowLabel & "\\" row, expected exactly 1 — text fields:" & my rfInventory(snap)
  return my cgAt(c, item 1 of hits)
end rfField`;

/**
 * The IN-SCRIPT half of the per-step focus guard (issue #620).
 *
 * A synthetic keystroke is not addressed at an element — System Events hands it
 * to whatever application owns the screen at that instant. So every script that
 * types re-asserts, in the same osascript hop that will do the typing, that
 * Things is still frontmost; the drive-level census (see {@link guardedRun})
 * runs a moment earlier and cannot close the last few milliseconds. The
 * assertion FAILS CLOSED and names the application that owns the screen
 * instead — never the contents of its window.
 *
 * This is the cheapest possible check: one System Events property read, no
 * sleeps, no polling (UI-automation determinism doctrine).
 */
export const AX_FOCUS_GUARD_HANDLERS = `on fgFrontApp()
	set frontName to ""
	try
		tell application "System Events" to set frontName to (name of first application process whose frontmost is true) as text
	end try
	return frontName
end fgFrontApp

on fgAssertFront(what)
	set f to my fgFrontApp()
	if f is "${THINGS_PROCESS}" then return true
	if f is "" then
		error "refused to " & what & ": the frontmost application could not be read, so there is no proof the keystrokes would reach Things — nothing was typed"
	end if
	error "refused to " & what & ": " & f & " is frontmost, not Things — a keystroke goes to whatever owns the screen, so nothing was typed"
end fgAssertFront`;

/**
 * THE MEASURED OBSERVABLES (VOPAT1 §4, docs/lab/vopat1-screen-reader-pattern.md).
 *
 * Every spec below names a notification Things was MEASURED to post for the
 * actuation it settles, and a budget generous against that measurement — never a
 * guess, and never a class the same campaign found silent (`AXLayoutChanged`
 * never fires, for anything, VOPAT1-12). `fallbackDelayS` is the fixed delay the
 * settle replaces, so a machine with no sidecar generates the script that
 * shipped before this campaign, byte for byte.
 */

/** A pop-up's menu announces itself in 5.1 ms (VOPAT1 §4.2 f). */
const SETTLE_MENU_OPEN: SettleSpec = {
  what: "the pop-up's menu opening",
  want: ["AXMenuOpened"],
  timeoutMs: 1_500,
};
/**
 * THE CLICK WAS CONSUMED — `AXMenuClosed`, measured at 348 ms inside the
 * frequency selection's own sequence (VOPAT1 §4.2 g).
 *
 * This is the settle for a selection that changes NOTHING: clicking the item a
 * pop-up already shows posts no `AXValueChanged`, because nothing changed. The
 * menu still closes, and that is the observable — the app confirming it has
 * taken the click and put its menu away.
 *
 * IT IS NOT COSMETIC, AND VOPAT2 LEARNED THAT THE HARD WAY. The first cut
 * skipped the settle outright in the unchanged case, which took the
 * `--after-completion` drive's frequency hop from 2244 ms to 140 ms — and MOVED
 * the cost, because the next hop's first click on the unit pop-up was then
 * dispatched while the app was still closing the menu, and was SWALLOWED: that
 * hop's menu-open settle timed out at 1515 ms and the retry's click opened the
 * menu in 4.1 ms. It is the RDLAT2 §7c lesson arriving from a third direction —
 * an accidental settle was holding a real dependency together, and making the
 * driver faster exposed it. The remedy is never to put the accident back: wait
 * for the thing itself.
 */
const SETTLE_MENU_CLOSED: SettleSpec = {
  what: "the pop-up's menu closing on the value it already held",
  want: ["AXMenuClosed"],
  timeoutMs: 1_500,
};
/**
 * THE `Next:` POP-UP ABSORBING THE RULE (NEXTPOP1) — the one settle in this
 * drive that is a WHOLE HOP, and the one the field could see.
 *
 * The maintainer watched a `make-repeating` on his M1 (2026-09-02, elapsed
 * 10.5 s) and reported "a ~1.5 s visible pause between selecting the frequency
 * and touching the `Next:` pop-up". That pause is this settle, and the reason it
 * costs its whole budget is structural: the recompute is announced ~0.4 s after
 * the ANCHOR step (DIAG4), and by the time this hop's own process has been
 * spawned the announcement has already been and gone — so a wait that starts
 * HERE has nothing left to see and re-reads the control twelve times to find
 * that out.
 *
 * An observer does not have that problem, because it was already listening. The
 * settle awaits `AXValueChanged` on an `AXPopUpButton` **since the mark taken
 * before the step that CHANGED THE RULE** — an arrival that has already landed
 * satisfies it instantly out of the ledger, which is the whole reason the mark
 * is taken before an actuation rather than after it. That makes this the
 * campaign's only CROSS-HOP settle, and the only one node performs itself: with
 * a sidecar live the hop dispatches no osascript at all and reads no control,
 * against one process spawn and up to thirteen content reads.
 *
 * SOFT, like every settle here. A recompute that never fires (a rule change that
 * does not move the first occurrence — there is nothing to observe, NEXTPOP1's
 * own note) spends the budget and proceeds, exactly as the polling form did.
 */
const SETTLE_OCCURRENCE_RECOMPUTE: SettleSpec = {
  what: "the first-occurrence pop-up absorbing the rule change",
  want: ["AXValueChanged:AXPopUpButton"],
  timeoutMs: OCCURRENCE_SETTLE_MS,
  // A QUIET WINDOW, not the first arrival — and this is the one place in the
  // campaign where that distinction is load-bearing. An anchor selection
  // announces its OWN pop-up value change immediately, and the `Next:` pop-up's
  // recompute follows ~0.4 s later (DIAG4); both are `AXValueChanged` on an
  // `AXPopUpButton` and a notification carries only a name and a role, so they
  // are INDISTINGUISHABLE to the matcher. Returning on the first arrival would
  // therefore return on the anchor's own change and let the next input land
  // inside the recompute window — which is precisely the defect NEXTPOP1 exists
  // to prevent, and a cancelled recompute never retries. So the settle waits
  // until the app has stopped announcing pop-up changes for 250 ms, which spans
  // both whatever their order, and still returns in ~300 ms when the anchor
  // moved nothing further.
  quietMs: 250,
};
/**
 * Asking a field for focus is a closed loop: `AXFocusedUIElementChanged` arrives
 * on the field in 27.6 ms (VOPAT1-13). This is what the 0.15 s sleep was for.
 */
const SETTLE_FOCUS: SettleSpec = {
  what: "the field taking keyboard focus",
  want: ["AXFocusedUIElementChanged:AXTextField", "AXFocusedUIElementChanged"],
  timeoutMs: 1_000,
  fallbackDelayS: 0.15,
};
/**
 * A keystroke announces itself only if it LANDS: `AXValueChanged` on the field in
 * 78.6 ms, and NOTHING AT ALL when focus is elsewhere (VOPAT1-14) — so the
 * silence is itself the signal that the character went somewhere else, and the
 * step's own read-back is what refuses. This is what the 0.1 s sleep was for.
 */
const SETTLE_TYPED: SettleSpec = {
  what: "the field taking the typed value",
  want: ["AXValueChanged:AXTextField"],
  timeoutMs: 1_500,
  fallbackDelayS: 0.1,
};

/** resolve-element: does the element exist right now? Returns "true"/"false". */
export function axResolveScript(path: string): string {
  return `${SE} to return (exists (${path}))`;
}
/**
 * The AppleScript variable a folded candidate resolution binds the live element
 * to. Every addressed script takes its target as `(<path>)`, so handing it this
 * name — with {@link axCandidatePrelude} in front — makes the resolution and the
 * action ONE hop instead of two (DRVLAT1, issue #633).
 */
export const STEP_ELEMENT_REF = "fgStepEl";
/**
 * The message a folded candidate resolution raises when NONE of a step's expected
 * element shapes appeared. Byte-identical to the driver's own wording for the
 * separate-hop resolution it replaces, so a report reads the same either way.
 */
export const CANDIDATES_MISSED =
  "none of its expected element shapes resolved (neither the attached sheet nor the " +
  "detached repeat editor window)";
/**
 * IN-SCRIPT CANDIDATE RESOLUTION (DRVLAT1, issue #633).
 *
 * A candidate-addressed step used to dispatch one `resolve` hop PER CANDIDATE PER
 * POLL ROUND before the hop that acted on whichever answered — a process spawn
 * each, on top of a 300ms JS-side poll floor. This prelude does the same work in
 * the acting hop's own process: it polls the candidates in the SAME priority
 * order, binds the first that exists to {@link STEP_ELEMENT_REF}, and fails closed
 * with {@link CANDIDATES_MISSED} when the window elapses with none of them there.
 *
 * Collapsing it is also strictly better against TOCTOU: the element the script
 * acts on is the one it just proved exists, with nothing dispatched in between.
 */
export function axCandidatePrelude(
  paths: string[],
  timeoutMs: number = RESOLVE_CANDIDATE_TIMEOUT_MS,
): string {
  const probes = paths
    .map(
      (p) => `    try
      if (exists (${p})) then set ${STEP_ELEMENT_REF} to (${p})
    end try
    if ${STEP_ELEMENT_REF} is not missing value then exit repeat`,
    )
    .join("\n");
  return `set ${STEP_ELEMENT_REF} to missing value
set fgT0 to (current date)
${SE}
  repeat
${probes}
    if ((current date) - fgT0) is greater than or equal to ${pollSeconds(timeoutMs)} then exit repeat
    delay ${IN_SCRIPT_POLL_S}
  end repeat
end tell
if ${STEP_ELEMENT_REF} is missing value then error "${escapeAppleScript(CANDIDATES_MISSED)}"`;
}
/**
 * wait: poll for ANY of the awaited element shapes to appear, IN-SCRIPT (DRVLAT1).
 * One hop for the whole wait instead of one per candidate per round — which is
 * what a slow host paid most: the dialog the drive is waiting for is exactly the
 * thing that is slow when the app is busy. Returns "true", or "false" when the
 * window elapses with none of them present (the driver's abort path is unchanged).
 */
export function axWaitAnyScript(paths: string[], timeoutMs: number): string {
  const probes = paths
    .map(
      (p) => `    try
      if (exists (${p})) then return "true"
    end try`,
    )
    .join("\n");
  return `set fgT0 to (current date)
${SE}
  repeat
${probes}
    if ((current date) - fgT0) is greater than or equal to ${pollSeconds(timeoutMs)} then return "false"
    delay ${IN_SCRIPT_POLL_S}
  end repeat
end tell`;
}
/**
 * dialog-open: WAIT for the Repeat dialog and CENSUS it in the same hop (RDLAT2).
 *
 * This replaces the bare wait that used to stand here. The wait proved that one
 * control resolved and said nothing else; the drive then re-discovered which of
 * the two shells was live on every subsequent step, and the pre-commit audit
 * spent a whole osascript hop asking the same question again.
 *
 * The snapshot answers both questions once, for one extra Apple event:
 *
 *   - WHICH SHELL. It returns the 1-based index of the candidate that answered,
 *     so every later step addresses the shell that actually opened instead of
 *     probing both, and the audit needs no resolution hop at all.
 *   - WHAT SHAPE. It returns the shell's direct-child AX roles, which the driver
 *     matches against the manifest (`ui-shape.ts`). The dialog's control census
 *     is the one thing about it that does NOT depend on the rule state, so it is
 *     assertable exactly here — and a shell whose census has moved is a
 *     redesigned dialog, which fails closed rather than being pressed into.
 *
 * Returns `idx=<n> roles=<AXRole>,<AXRole>,…`, or `"none"` when the window
 * elapses with neither shell present (the driver's abort path is unchanged).
 */
export function axDialogOpenScript(shellPaths: string[], timeoutMs: number): string {
  const probes = shellPaths
    .map(
      (p, i) => `    try
      if (exists (${p})) then
        set dlgIdx to ${i + 1}
        set dlgShell to (${p})
        exit repeat
      end if
    end try`,
    )
    .join("\n");
  return `set dlgIdx to 0
set dlgShell to missing value
set fgT0 to (current date)
${SE}
  repeat
${probes}
    if ((current date) - fgT0) is greater than or equal to ${pollSeconds(timeoutMs)} then return "none"
    delay ${IN_SCRIPT_POLL_S}
  end repeat
  set dlgRoles to {}
  try
    set dlgRoles to (role of UI elements of dlgShell)
  end try
  set out to "idx=" & dlgIdx & " roles="
  set first_ to true
  repeat with r in dlgRoles
    if first_ then
      set first_ to false
    else
      set out to out & ","
    end if
    set out to out & (contents of r)
  end repeat
  return out
end tell`;
}
/**
 * A poll window in whole seconds, as the in-script `current date` deadline reads
 * it (AppleScript dates carry second granularity). Never below 1: a sub-second
 * window would make a loop that checks its deadline after the FIRST probe into a
 * single-shot check, which is the race these loops exist to close.
 */
function pollSeconds(timeoutMs: number): number {
  return Math.max(1, Math.round(timeoutMs / 1000));
}
/**
 * press: AXPress the element — and, when the recipe declares what the press
 * ANNOUNCES, wait to be told (VOPAT2).
 *
 * The step that matters here is `Items ▸ Repeat…`. Its dialog takes ~438 ms of
 * the app's own time to present (VOPAT1 §4.2 e, within 4 % of RDLAT2's
 * stopwatch), and the `dialog-open` step that follows used to discover that by
 * asking `exists sheet 1` — and then `exists <detached window>` — every 50 ms
 * until one answered. Nine rounds of two probes is eighteen System Events
 * round-trips on a host where each one costs ~47 ms, spent learning something
 * `AXSheetCreated` says once. The press now waits for that notification, and the
 * census hop's first probe hits.
 *
 * SOFT (see {@link SettleInjector.soft}): the `dialog-open` step's own poll is
 * retained as the oracle and is what refuses, in the words it always used. What
 * the notification changes is when the drive stops waiting, not who decides.
 */
export function axPressScript(
  path: string,
  obs: SettleInjector = inertSettleInjector(),
  settle?: SettleSpec,
): string {
  if (!obs.live || settle === undefined) return `${SE} to click (${path})`;
  return `${obs.handlers()}

${obs.mark("obsSeq", "")}
${SE} to click (${path})
${obs.soft("obsSeq", settle, "")}
return "true"`;
}
/**
 * set-field-value: enter a value into the dialog's numeric text field (interval,
 * ends-count, start-days-earlier) — and into the Move… picker's filter field. It
 * FOCUSES the field, TYPES the value, and Tabs to commit — because
 * `set value of <field>` writes the field's displayed text WITHOUT firing the
 * edit, so the app's binding keeps the old number (the field shows "5" but the
 * rule stays interval 1 — a silent no-op exactly like `set value` on a pop-up,
 * UIC6; it went unnoticed while every base case used the default interval 1).
 * Real keystrokes fire the change the binding needs; Tab (not Return, which would
 * fire the default OK button) commits and moves focus. Foreground-bound
 * (keystrokes reach the frontmost app) — the reveal/activate preamble puts Things
 * there. One stable command shape.
 *
 * NO SELECT-ALL KEYSTROKE (BEEP1, 2026-08-25, docs/lab/beep1-numeric-field-beep.md).
 * The primitive used to send ⌘A before typing, and that ONE keystroke was the
 * audible macOS alert beep every numeric-field drive fired on the live host:
 * Things' `Edit ▸ Select All` menu item exists and is DISABLED while the Repeat
 * sheet is up, AppKit dispatches ⌘A as a menu key equivalent FIRST, the disabled
 * item swallows it, nothing handles it → NSBeep. It is a menu-dispatch fact, not
 * a focus race: the beep survives a verified first responder and a 1.5 s settle,
 * while Tab and the digits themselves are silent. ⌘A was also REDUNDANT —
 * `set focused of tf to true` installs the field editor with the ENTIRE content
 * selected (measured: `AXSelectedTextRange` length goes 0 → the full value
 * length, on both a 1- and a 2-character value), so typing replaces the old value
 * outright, including the shrinking case (12 → 3) that a stale caret would have
 * corrupted into "123". Dropping the keystroke is therefore silent AND correct on
 * all three fields.
 *
 * CLOSED-LOOP (determinism doctrine): type, Tab-commit, then READ THE FIELD BACK
 * and retry if it did not hold — the interval field, when it is the first numeric
 * field after a frequency/type switch, races the dialog's group re-layout and
 * reverts to 1 (UIC7, oddities §8l). Re-focus + re-type after a settle lands it
 * once the re-layout has finished, and the re-focus re-selects the whole value,
 * so a retry starts from a clean field without ⌘A. Fail-closed (an `error`, i.e.
 * a transport failure the pipeline re-verifies) if it never holds — the
 * create/reschedule delta's rule assertion is the final DB-level authority.
 *
 * READ-BACK FIRST (issue #620 item 7): a field that ALREADY holds the requested
 * value is left alone and the script returns {@link OK_ALREADY} — the whole
 * keystroke class disappears for the defaults, which is most drives (the field
 * incident died typing interval `1` into a field already showing `1`). The skip
 * is proven by TWO reads a settle apart, because the one way a matching value
 * can go stale is the UIC7 re-layout revert, which lands within that window; and
 * whatever this decides, the pre-commit audit ({@link axAuditDialogScript})
 * re-reads every control through its own address before the OK press, so a
 * wrongly-skipped field cannot commit.
 */
export function axSetValueScript(
  path: string,
  value: string,
  attempts = 3,
  obs: SettleInjector = inertSettleInjector(),
): string {
  const v = escapeAppleScript(value);
  const n = Math.max(1, Math.trunc(attempts));
  return `${AX_FOCUS_GUARD_HANDLERS}
${obs.live ? `\n${obs.handlers()}\n` : ""}
${SE}
  set tf to (${path})
${alreadyHoldsBlock("tf", v)}
${typeLoopBlock("tf", v, `type \\"${v}\\" into the field`, n, obs)}
${focusRefusalTail(v)}
  error "field did not hold value \\"${v}\\" after ${n} attempt(s); last shown: " & ((value of tf) as text)
end tell`;
}

/**
 * What a typing primitive returns when it typed NOTHING because the field
 * already held the requested value (issue #620 item 7). Distinct from "OK" so
 * the drive can disclose the skip — and so a lab cell can assert that no
 * keystroke hop fired.
 */
export const OK_ALREADY = "OK-ALREADY";

/**
 * The read-back-first skip: two reads a settle apart, no keystroke either way.
 * Shared verbatim by all three typing primitives so the law is one shape.
 */
function alreadyHoldsBlock(ref: string, escapedValue: string): string {
  return `  log "${AX_ELEMS_LOG_PREFIX}2"
  set v0 to ""
  try
    set v0 to ((value of ${ref}) as text)
  end try
  if v0 is "${escapedValue}" then
    delay 0.3
    set v1 to ""
    try
      set v1 to ((value of ${ref}) as text)
    end try
    if v1 is "${escapedValue}" then return "${OK_ALREADY}"
  end if`;
}

/**
 * The element half of the focus guard: after asking for focus, PROVE the field
 * took it before typing. A field that will not accept focus (the dialog is
 * rebuilding, another sheet stole it) would otherwise receive the keystrokes
 * somewhere else entirely.
 *
 * IT IS A CLOSED LOOP, NOT A SINGLE SHOT (RDLAT2). The assertion used to raise on
 * the FIRST miss, and got away with it only because the shape settle above it was
 * slow: the settle re-read the cadence group one control at a time, so on a group
 * with several labels it spent ~240 ms deciding the shape had stopped moving, and
 * by then the rebuilt field would accept focus. Reading the same group in four
 * plural events cut that to ~150 ms, and the fixed-frequency interval step
 * started refusing EVERY time — the guard was measuring the driver's own read
 * cost, which is exactly the timing dependence the determinism doctrine forbids.
 *
 * So the readiness is now waited for POSITIVELY, on the observable itself: ask
 * for focus, look, and if the field has not taken it, ask again on the next
 * attempt of the loop this block sits in. Nothing is typed without proven focus —
 * that property is unchanged and is what makes the retry safe — and a field that
 * never accepts focus still refuses, in the same words, once the attempts are
 * spent. See {@link focusRefusalTail}.
 */
function focusedAssertBlock(ref: string): string {
  return `    set gotFocus to false
    try
      set gotFocus to (focused of ${ref}) as boolean
    end try
    if gotFocus then`;
}

/**
 * The refusal a spent typing loop raises when the field never took focus — the
 * FGRD wording, unchanged, now reached after the attempts rather than on the
 * first miss (see {@link focusedAssertBlock}).
 */
function focusRefusalTail(escapedValue: string): string {
  return `  if not gotFocus then error "refused to type \\"${escapedValue}\\": the field did not take keyboard focus, so the keystrokes would have gone somewhere else"`;
}

/**
 * THE TYPING LOOP, shared by all three typing primitives — focus, prove focus,
 * type, Tab-commit, read the value back, retry (FGRD1 / UIC7 / BEEP1). One
 * shape, so the law is in one place; `what` is only the phrase the frontmost
 * guard's refusal uses.
 *
 * TWO OF ITS FOUR SLEEPS ARE NOW OBSERVABLES (VOPAT2). The 0.15 s after asking
 * for focus becomes `AXFocusedUIElementChanged` on the field (measured 27.6 ms,
 * VOPAT1-13), and the 0.1 s after the keystroke becomes `AXValueChanged` on the
 * field (78.6 ms, VOPAT1-14). Both are SOFT: the `focused` assertion and the
 * value read-back are the certified gates and still decide, so the notification
 * only ends the wait early — a settle that hears nothing costs the loop one
 * ordinary retry, exactly as a too-short sleep did.
 *
 * THE OTHER TWO SLEEPS STAY, deliberately. The 0.2 s after Tab is the commit
 * itself, and the 0.3 s inter-attempt gap is FGRD1's. Neither has a measured
 * observable, and a settle may not be written against a notification nobody has
 * seen fire.
 */
function typeLoopBlock(
  ref: string,
  escapedValue: string,
  what: string,
  attempts: number,
  obs: SettleInjector,
): string {
  return `  set gotFocus to false
  repeat ${attempts} times
    my fgAssertFront("${what}")
${obs.mark("obsSeq", "    ")}${obs.live ? "\n" : ""}    set focused of ${ref} to true
${obs.soft("obsSeq", SETTLE_FOCUS, "    ")}
${focusedAssertBlock(ref)}
${obs.mark("obsSeq", "      ")}${obs.live ? "\n" : ""}      keystroke "${escapedValue}"
${obs.soft("obsSeq", SETTLE_TYPED, "      ")}
      key code 48
      delay 0.2
      try
        if ((value of ${ref}) as text) is "${escapedValue}" then return "OK"
      end try
    end if
    delay 0.3
  end repeat`;
}
/**
 * set-group-number: drive ONE of the Repeat dialog's two numeric fields —
 * the cadence INTERVAL or the ENDS-AFTER COUNT — addressed by the LABEL ROW it
 * sits on (HXPC1, docs/lab/hxpc1-picker-assert.md §A; hardened by CGRD1,
 * docs/lab/cgrd1-precommit-audit.md §A).
 *
 * Both fields used to be spelled `text field 1 of group 1`, which is the same
 * control at different moments. Measured on Things 3.23 (build 32300036):
 *
 *   Ends: never   → group text fields = 1  ·  tf1 = interval  @[311,283]
 *   Ends: after N → group text fields = 2  ·  tf1 = COUNT     @[402,372]
 *                                             tf2 = interval  @[311,283]
 *
 * i.e. selecting the "after" bound INSERTS the count ahead of the interval. The
 * create path got away with it by driving the interval while it was still the
 * sole field, but a RESCHEDULE opens the dialog pre-populated: a rule that
 * already ends after N presents both fields from the first step, so the interval
 * drive wrote the requested interval into the count field, the count drive then
 * overwrote it, and the interval silently never changed.
 *
 * The addresses are the {@link AX_CADENCE_HANDLERS} laws — POSITIVE label-row
 * matches wherever the app offers a label to match, a uniqueness check where it
 * does not, and a fail-closed refusal naming the whole numeric-field inventory
 * otherwise. The write itself is the {@link axSetValueScript} closed loop —
 * focus, type, Tab-commit, read back, bounded retries — and, like it, sends NO
 * select-all keystroke: the ⌘A that used to open it is the macOS alert beep
 * (BEEP1, docs/lab/beep1-numeric-field-beep.md), and focusing the field already
 * selects its whole content.
 *
 * The read-back this loop performs is SELF-REFERENTIAL by construction — it
 * re-reads the field it addressed, so it can only prove the keystrokes landed
 * where they were aimed, never that they were aimed at the right control. The
 * PRE-COMMIT AUDIT ({@link axAuditDialogScript}) is what closes that: it re-reads
 * every control through these same handlers just before the OK press.
 */
export function axSetGroupNumberScript(
  groupPath: string,
  target: "interval" | "ends-count",
  value: string,
  attempts = 3,
  rowTolerance = ROW_TOLERANCE,
  expectation: CadenceExpectation | null = null,
  obs: SettleInjector = inertSettleInjector(),
): string {
  const v = escapeAppleScript(value);
  const n = Math.max(1, Math.trunc(attempts));
  const tol = Math.max(1, Math.trunc(rowTolerance));
  return `${AX_CADENCE_HANDLERS}

${AX_FOCUS_GUARD_HANDLERS}
${obs.live ? `\n${obs.handlers()}\n` : ""}
${SE}
  set g to (${groupPath})
  set cgSnapshot to my cgSettle(g, ${settleArgs(expectation)})
  set tf to my cgField(g, cgSnapshot, "${target}", ${tol})
${alreadyHoldsBlock("tf", v)}
${typeLoopBlock("tf", v, `type \\"${v}\\" into the ${target} field`, n, obs)}
${focusRefusalTail(v)}
  error "the ${target} field did not hold value \\"${v}\\" after ${n} attempt(s); last shown: " & ((value of tf) as text)
end tell`;
}
/**
 * set-row-field: drive a Repeat-dialog text field addressed by the pinned English
 * LABEL sharing its row — the same discrimination law as
 * {@link axSetGroupNumberScript}, applied to a field that lives on the dialog
 * SHELL rather than in the cadence group.
 *
 * Its one caller is the "and start [N] days earlier" offset the "Add deadlines"
 * checkbox reveals, which shipped as `text field 1` of the shell. That address
 * was the HXPC1 error class exactly: a value-bearing text field picked by index
 * out of a STATE-DEPENDENT tree (the field does not exist at all until the
 * checkbox is ticked), verified only by re-reading the same index it wrote. It
 * happened to be right on 3.23 — measured, the shell carries 0 direct text fields
 * with deadlines off and exactly 1 with them on, whether or not reminders are also
 * on (CGRD1 §B census) — but nothing in the address said so, and an AX tree is an
 * undocumented private surface that may add a second field in any release.
 *
 * The label anchor is `days earlier` (y=413 against the field's y=409, CGRD1 §B).
 * A missing label, or anything other than exactly one field on its row, FAILS
 * CLOSED naming the shell's whole text-field inventory. The write is the
 * {@link axSetValueScript} closed loop.
 */
export function axSetRowFieldScript(
  containerPath: string,
  rowLabel: string,
  value: string,
  attempts = 3,
  rowTolerance = ROW_TOLERANCE,
  obs: SettleInjector = inertSettleInjector(),
): string {
  const v = escapeAppleScript(value);
  const label = escapeAppleScript(rowLabel);
  const n = Math.max(1, Math.trunc(attempts));
  const tol = Math.max(1, Math.trunc(rowTolerance));
  return `${AX_CADENCE_HANDLERS}

${AX_FOCUS_GUARD_HANDLERS}
${obs.live ? `\n${obs.handlers()}\n` : ""}
${SE}
  set c to (${containerPath})
  set rfSnapshot to my cgSnap(c)
  set tf to my rfField(c, rfSnapshot, "${label}", ${tol})
${alreadyHoldsBlock("tf", v)}
${typeLoopBlock("tf", v, `type \\"${v}\\" into the \\"${label}\\" field`, n, obs)}
${focusRefusalTail(v)}
  error "the \\"${label}\\" field did not hold value \\"${v}\\" after ${n} attempt(s); last shown: " & ((value of tf) as text)
end tell`;
}

/**
 * ONE control the PRE-COMMIT DIALOG AUDIT re-reads, in the form the generator
 * needs: a resolved element path (the shell / dialog-shape disjunctions are
 * settled by the driver before the script is built) plus the value(s) the drive
 * intended for it.
 */
export interface AuditScriptControl {
  /** Human name of the control, as the mismatch report should say it. */
  label: string;
  kind: "popup" | "checkbox" | "group-number" | "row-field" | "weekdays" | "occurrence-popup";
  /** popup / checkbox / occurrence-popup: the resolved element path. */
  path?: string;
  /** group-number: which of the cadence group's numeric fields. */
  numberTarget?: "interval" | "ends-count";
  /** row-field: the pinned English label sharing the field's row. */
  rowLabel?: string;
  /** weekdays: the group pop-up index of the first weekday row (shape-selected). */
  weekdayBase?: number;
  /** The accepted observed values — ANY one satisfies (the singular/plural pair). */
  expected: string[];
  /** How the intended value should READ in the report ("checked", not "1"). */
  expectedLabel?: string;
}

/** The resolved audit the {@link axAuditDialogScript} generator compiles. */
export interface AuditScriptSpec {
  /** The resolved dialog shell (attached sheet or detached editor window). */
  shell: string;
  /** The resolved cadence group inside that shell. */
  group: string;
  controls: AuditScriptControl[];
  /**
   * The cadence group's expected shape for the rule state this drive built — the
   * shape manifest's advisory check, which lets the settle stop on the first read
   * that already shows the finished state (RDLAT2). Null asserts nothing.
   */
  expectation?: CadenceExpectation | null;
  /**
   * The COMMIT the audit presses when — and only when — every control agreed:
   * the resolved path of the dialog's OK button (RDLAT2).
   *
   * The audit and the press used to be two osascript hops with a driver round
   * trip between them, which is a window in which the thing just audited can
   * change. Pressing inside the same script closes it: what is committed is the
   * dialog state the audit read, with nothing dispatched in between. It also
   * removes a process spawn and the separate shell resolution that preceded it
   * (the open item DRVLAT1 §8 left).
   *
   * Absent for a caller that wants the audit alone (the date-area leg runs
   * first, and a recipe that drove no control has no audit to fold a press into).
   */
  commit?: string;
}

/** The marker a folded commit's own failure raises, so the driver can tell the two apart. */
export const COMMIT_FAILED_TAG = "#COMMITFAIL";

/** AppleScript list literal of quoted strings. */
function asList(values: readonly string[]): string {
  return `{${values.map((v) => `"${escapeAppleScript(v)}"`).join(", ")}}`;
}

/**
 * The shape manifest's expectation as `cgSettle`'s three arguments. A null
 * expectation compiles to `-1` — the sentinel that asserts nothing and leaves
 * the BEEP1 two-agreeing-reads rule deciding alone (RDLAT2).
 */
function settleArgs(expectation: CadenceExpectation | null): string {
  // Two sentinels, because "no expectation" and "an expectation that does not
  // constrain the field count" are different things (RDLAT2):
  //   -2  no expectation at all — the agreement rule decides alone
  //   -1  check the labels, not the count
  if (expectation === null) return "-2, {}, {}";
  return `${expectation.fields ?? -1}, ${asList(expectation.requiredLabels)}, ${asList(
    expectation.forbiddenLabels,
  )}`;
}

/** The intended value(s) as the mismatch report should read them. */
function intendedText(control: AuditScriptControl): string {
  if (control.expectedLabel !== undefined) return control.expectedLabel;
  return control.expected.map((v) => `\\"${escapeAppleScript(v)}\\"`).join(" or ");
}

/**
 * audit-dialog: RE-READ EVERY CONTROL THIS DRIVE SET, through each control's own
 * discriminated address, and refuse to commit if any one of them does not hold
 * the value the drive intended.
 *
 * This exists because a per-step read-back is SELF-REFERENTIAL. Every setter here
 * confirms its write by re-reading the element it addressed, so it proves the
 * keystrokes landed where they were aimed — and nothing else. The #589 wrong-field
 * write reported OK for exactly that reason: the interval drive typed into the
 * ends-count field, then read the ends-count field back and found its own number
 * sitting there. The address was wrong; a read-back through the same address
 * cannot see that.
 *
 * The audit is the outside view. It is assembled from the recipe's OWN step list
 * (so no control the recipe drives can be left out of the audit by omission) and
 * runs as the last step before the OK press, comparing the dialog's complete
 * intended state against what the dialog actually shows: frequency, the
 * after-completion cadence unit, interval, ends bound and its count, the
 * deadline/reminder checkboxes, the start-days-earlier offset, the weekday set,
 * the monthly/yearly anchor pop-ups and the 3.23 first-occurrence pop-up. A
 * mismatch is an `error` naming EVERY differing control with both values, which
 * aborts the drive fail-closed BEFORE the commit and runs the standard clean-abort
 * path — nothing reaches the database.
 *
 * Deterministic throughout: the cadence group is settled on its own shape
 * signature (the BEEP1 two-agreeing-reads gate), never on a sleep, and every field
 * is found by its label row rather than by index ({@link AX_CADENCE_HANDLERS}).
 *
 * The dialog's three `AXDateTimeArea` controls are audited separately — their
 * values are NSDates no System Events read can reach, so they ride
 * {@link axAuditDateAreasScript} through the same ObjC bridge that writes them.
 */
export function axAuditDialogScript(spec: AuditScriptSpec, rowTolerance = ROW_TOLERANCE): string {
  const tol = Math.max(1, Math.trunc(rowTolerance));
  // The shell's own text-field inventory is read only when a control needs it
  // (the "and start N days earlier" offset is the sole one), so the ordinary
  // audit costs four Apple events for the cadence group and none for the shell.
  const needsShellSnapshot = spec.controls.some((c) => c.kind === "row-field");
  // How many CONTROLS this audit reads the content of, for the element counter
  // (RDLAT2). A weekday check reads every row pop-up from its base, so it is
  // counted as the set it compares; every other kind re-reads exactly one
  // control. The cadence group's own inventory reports itself, from `cgSnap`.
  const auditContentReads = spec.controls.reduce(
    (n, c) => n + (c.kind === "weekdays" ? Math.max(1, c.expected.length) : 1),
    0,
  );
  // The commit, pressed only past the mismatch check above it. Its own failure
  // carries a distinct tag: "the audit refused" and "the OK button would not
  // press" are different outcomes and must not be reported as each other.
  const commitTail =
    spec.commit === undefined
      ? ""
      : `  try
    click (${spec.commit})
  on error errMsg
    error "${COMMIT_FAILED_TAG} " & errMsg
  end try
`;
  const body = spec.controls
    .map((c, i) => {
      const name = escapeAppleScript(c.label);
      const want = asList(c.expected);
      const intended = intendedText(c);
      const miss = `set end of bad to "${name} (intended ${intended}, dialog shows \\"" & v${i} & "\\")"`;
      switch (c.kind) {
        case "popup":
          return `  set v${i} to "(unreadable)"
  try
    set v${i} to (value of (${c.path ?? ""})) as text
  end try
  if not (my aqAny(v${i}, ${want})) then ${miss}`;
        case "occurrence-popup":
          return `  set v${i} to "(unreadable)"
  try
    set v${i} to (value of (${c.path ?? ""})) as text
  end try
  set d${i} to my aqYMD(v${i})
  if d${i} is missing value then
    ${miss}
  else if not (my aqAny(d${i}, ${want})) then
    set end of bad to "${name} (intended ${intended}, dialog shows \\"" & v${i} & "\\" = " & d${i} & ")"
  end if`;
        case "checkbox":
          return `  set v${i} to "(unreadable)"
  try
    set v${i} to ((value of (${c.path ?? ""})) as integer) as text
  end try
  if not (my aqAny(v${i}, ${want})) then set end of bad to "${name} (intended ${intended}, dialog shows " & (my aqTick(v${i})) & ")"`;
        case "group-number":
          return `  set v${i} to "(unreadable)"
  try
    set v${i} to ((value of (my cgField(g, cgSnapshot, "${c.numberTarget ?? "interval"}", ${tol}))) as text)
  end try
  if not (my aqAny(v${i}, ${want})) then ${miss}`;
        case "row-field":
          return `  set v${i} to "(unreadable)"
  try
    set v${i} to ((value of (my rfField(sh, rfSnapshot, "${escapeAppleScript(c.rowLabel ?? "")}", ${tol}))) as text)
  end try
  if not (my aqAny(v${i}, ${want})) then ${miss}`;
        case "weekdays":
          return `  set got${i} to {}
  repeat with k from ${Math.max(1, Math.trunc(c.weekdayBase ?? 2))} to (count of pop up buttons of g)
    set end of got${i} to ((value of pop up button k of g) as text)
  end repeat
  set v${i} to my aqJoin(got${i}, ",")
  set off${i} to false
  repeat with w in ${want}
    if not (my aqAny(w as text, got${i})) then set off${i} to true
  end repeat
  repeat with w in got${i}
    if not (my aqAny(w as text, ${want})) then set off${i} to true
  end repeat
  if off${i} then ${miss}`;
      }
    })
    .join("\n");
  return `${AX_CADENCE_HANDLERS}

on aqAny(v, lst)
  repeat with c in lst
    if (v as text) is (c as text) then return true
  end repeat
  return false
end aqAny

on aqJoin(lst, sep)
  set out to ""
  repeat with x in lst
    if out is not "" then set out to out & sep
    set out to out & (x as text)
  end repeat
  return out
end aqJoin

on aqTick(v)
  if (v as text) is "1" then return "checked"
  if (v as text) is "0" then return "unchecked"
  return "\\"" & (v as text) & "\\""
end aqTick

on aqPad2(n)
  set s to (n as integer) as text
  if (length of s) < 2 then set s to "0" & s
  return s
end aqPad2

on aqStamp(d)
  return ((year of d) as text) & "-" & my aqPad2((month of d) as integer) & "-" & my aqPad2(day of d)
end aqStamp

on aqRelative(s)
  -- The first-occurrence control renders NEAR dates RELATIVELY — "Today" for the
  -- current day — and a relative word can never be string-compared against a
  -- typed ISO date (#625: make-repeating --when <today> refused its own correct
  -- write, every time, because the audit compared "2026-07-05" against "Today").
  -- Resolve the word against the app's own clock, the same way the selector
  -- already does, rather than rebuilding the app's display string.
  set rightNow to current date
  if s is "Today" then return my aqStamp(rightNow)
  if s is "Tomorrow" then return my aqStamp(rightNow + 86400)
  if s is "Yesterday" then return my aqStamp(rightNow - 86400)
  -- A weekday-only rendering names a day inside the coming week; anything
  -- further out is rendered as a date, so the search is bounded at 7 days and a
  -- word that resolves to nothing falls through to the date parse (and, failing
  -- that, to a fail-closed mismatch — never a guess).
  set wdNames to {"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}
  repeat with i from 1 to 7
    if s is (item i of wdNames) then
      repeat with k from 1 to 7
        set cand to rightNow + (k * 86400)
        if ((weekday of cand) as text) is (item i of wdNames) then return my aqStamp(cand)
      end repeat
    end if
  end repeat
  return missing value
end aqRelative

on aqYMD(t)
  -- Occurrence-pop-up titles are LOCALIZED ("Sun, Jul 12, 2026") and, for near
  -- dates, RELATIVE ("Today") — so the match is made by RESOLVING the title to a
  -- calendar date and comparing components, never by rebuilding the app's
  -- display string (the axSelectNextOccurrenceScript law).
  set s to t as text
  set rel to my aqRelative(s)
  if rel is not missing value then return rel
  try
    set d to date s
    return ((year of d) as text) & "-" & my aqPad2((month of d) as integer) & "-" & my aqPad2(day of d)
  end try
  try
    set ofs to offset of ", " in s
    if ofs > 0 then
      set d to date (text (ofs + 2) thru -1 of s)
      return ((year of d) as text) & "-" & my aqPad2((month of d) as integer) & "-" & my aqPad2(day of d)
    end if
  end try
  return missing value
end aqYMD

${SE}
  set sh to (${spec.shell})
  set g to (${spec.group})
  set cgSnapshot to my cgSettle(g, ${settleArgs(spec.expectation ?? null)})${
    needsShellSnapshot ? "\n  set rfSnapshot to my cgSnap(sh)" : ""
  }
  set bad to {}
  log "${AX_ELEMS_LOG_PREFIX}${auditContentReads}"
${body}
  if (count of bad) is not 0 then error "the Repeat dialog does not hold what this drive entered — " & (count of bad) & " control(s) differ: " & my aqJoin(bad, "; ")
${commitTail}  return "OK"
end tell`;
}

/** ONE date/time area the pre-commit audit re-reads through the ObjC bridge. */
export interface AuditDateArea {
  /** Human name of the control, as the mismatch report should say it. */
  label: string;
  target: "next" | "ends" | "reminder";
  /** The spec the drive wrote: `date:YYYY-MM-DD` or `time:HH:mm`. */
  spec: string;
}

/**
 * The pre-commit audit's DATE-AREA leg. The dialog's first-occurrence, ends-on and
 * reminder controls are `AXDateTimeArea`s whose value is an NSDate — unreachable
 * from System Events — so they are re-read through the SAME ObjC bridge, the same
 * shell-scoped walk and the SAME deterministic `pick` discriminator that
 * {@link axSetDateTimeScript} writes them through. A control the audit cannot find,
 * or one holding a different date/time, throws naming every area the dialog does
 * present (y-position + time-of-day), so the drive aborts before the OK press.
 */
export function axAuditDateAreasScript(areas: AuditDateArea[]): string {
  return `${AX_DATE_AREA_PRELUDE}
function run(){
  var apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.culturedcode.ThingsMac');
  if(!apps || apps.count===0) throw new Error('Things not running');
  var app=$.AXUIElementCreateApplication(apps.objectAtIndex(0).processIdentifier);
  var wanted=${JSON.stringify(areas)};
  var cal=$.NSCalendar.currentCalendar;
  var found=[]; try{ var shell=findShell(app); if(shell) collect(shell,'AXDateTimeArea',16,found); }catch(e){ found=[]; }
  var bad=[];
  for(var i=0;i<wanted.length;i++){
    var w=wanted[i];
    var dt=pick(found,w.target);
    if(!dt){ bad.push(w.label+' (intended '+w.spec+', but this dialog state presents no '+w.target+' control among ['+inv(found)+'])'); continue; }
    if(w.spec.indexOf('date:')===0){
      var got=ymdStr(dt,cal), want=w.spec.slice(5);
      if(got!==want) bad.push(w.label+' (intended '+want+', dialog shows '+(got||'(no value)')+')');
    } else {
      var gott=hmStr(dt,cal), p=w.spec.slice(5).split(':'), wantt=(+p[0])+':'+('0'+(+p[1])).slice(-2);
      if(gott!==wantt) bad.push(w.label+' (intended '+wantt+', dialog shows '+(gott||'(no value)')+')');
    }
  }
  if(bad.length) throw new Error('the Repeat dialog does not hold what this drive entered — '+bad.length+' control(s) differ: '+bad.join('; '));
  return 'OK';
}`;
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
export function axSelectPopupScript(
  path: string,
  value: string,
  obs: SettleInjector = inertSettleInjector(),
  settle?: SettleSpec,
): string {
  return axSelectPopupCandidatesScript(path, [value], obs, settle);
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
export function axSelectPopupCandidatesScript(
  path: string,
  values: string[],
  obs: SettleInjector = inertSettleInjector(),
  settle?: SettleSpec,
): string {
  const list = values.map((v) => `"${escapeAppleScript(v)}"`).join(", ");
  // The menu is WAITED FOR, not slept on (DRVLAT1, issue #633): the old loop paid
  // a flat 0.3s after every click before it would look again, so the common case —
  // one click, menu up in well under that — spent the remainder of the settle
  // doing nothing. The click cadence is unchanged (one click per round, never a
  // second click into a menu that is opening — BEEP1); only the looking is finer.
  //
  // AND NOW IT IS TOLD (VOPAT2). The menu announces `AXMenuOpened` 5.1 ms after
  // the press (VOPAT1-11) — against an inner poll that could not answer sooner
  // than its own 50 ms floor and asked the tree once per round to find out. The
  // `exists menu 1` check stays as the round's verdict: a notification says WHEN,
  // not WHAT, and BEEP1's one-click-per-round cadence is unchanged.
  const openRound = obs.live
    ? `${obs.mark("obsSeq", "    ")}
    click pu
${obs.soft("obsSeq", SETTLE_MENU_OPEN, "    ")}`
    : `    click pu
    repeat 6 times
      if (exists menu 1 of pu) then exit repeat
      delay ${IN_SCRIPT_POLL_S}
    end repeat`;
  // WHAT THE SELECTION ANNOUNCES, when the recipe knows (VOPAT2). Picking a
  // frequency REBUILDS the cadence group — three controls become nine — and the
  // step that types the interval next used to discover that by re-reading the
  // group until two reads agreed, which is the gate RDLAT2 §7c found was sized by
  // its own read cost. The rebuild's observable is `AXValueChanged` on the pop-up
  // this step just set arriving together with the `AXUIElementDestroyed` burst
  // that tears the old children down (both ~535 ms, VOPAT1-12): *the control I
  // set now reports the value I set, and the children it had are gone*. Waiting
  // for it HERE means the next step's `cgSettle` finds a group that has finished
  // moving and agrees on its first pair of reads.
  //
  // SOFT: `cgSettle` is retained unchanged as the oracle and is what refuses.
  //
  // AND IT IS SKIPPED WHEN THE VALUE DOES NOT CHANGE (VOPAT2 §trace). `AXValue
  // Changed` means the value CHANGED: clicking the item a pop-up already shows
  // posts nothing at all, and the settle then burns its whole budget on a drive
  // that is behaving perfectly. MEASURED on golden-v4: the `--after-completion`
  // shape — the maintainer's own command — opens the dialog on `after completion`
  // and selects `after completion`, and the settle timed out at 2005 ms having
  // seen 3 unrelated arrivals. That is not a hazard (the settle is soft, so
  // `cgSettle` still decided), but it is two wasted seconds on the commonest
  // shape.
  //
  // So the pop-up's value is READ ONCE before the click and the settle is armed
  // only when the click will actually move it. One content read against two
  // seconds, and it is the same read-back-first discipline the typing primitives
  // already use for the same reason (issue #620 item 7).
  const willSettle = obs.live && settle !== undefined;
  const preread = willSettle
    ? `  set puWas to ""
  try
    set puWas to (value of pu) as text
  end try
  log "${AX_ELEMS_LOG_PREFIX}1"
${obs.mark("obsSeq", "  ")}
`
    : "";
  const afterSelect = willSettle
    ? `
      if (contents of candidate) is not puWas then
${obs.soft("obsSeq", settle as SettleSpec, "        ")}
      else
${obs.soft("obsSeq", SETTLE_MENU_CLOSED, "        ")}
      end if`
    : "";
  return `${obs.live ? `${obs.handlers()}\n\n` : ""}${SE}
  set pu to (${path})
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
${openRound}
  end repeat
  -- The menu's items are realized by the search below, which matches them by
  -- TITLE — so the whole menu is content-touched however early the match hits
  -- (RDLAT2). Reported here, where they have just been realized by the open.
  try
    log "${AX_ELEMS_LOG_PREFIX}" & (count of menu items of menu 1 of pu)
  end try
${preread}  repeat with candidate in {${list}}
    if (exists menu item candidate of menu 1 of pu) then
      click menu item candidate of menu 1 of pu${afterSelect}
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
  // ONE INVENTORY, FOUR APPLE EVENTS (the RDLAT2 §4(a) plural-read law, applied
  // to the one script in this drive that never got it). It used to ask the tree
  // `count of static texts`, then `value of static text i` and `position of
  // static text i` for each, then `count of pop up buttons`, then a position per
  // pop-up — MEASURED at 15 Apple events for a weekly cadence group, which is
  // ~700 ms on the maintainer's M1 at RDLAT2's fitted ~47 ms per round-trip, to
  // answer one structural question. AppleScript answers a PLURAL property in one
  // event, so the same discrimination — which row the `Next:` label sits on and
  // what class of control shares it — costs three, or four when it has to look at
  // the legacy date areas.
  //
  // THE ORDER IS DELIBERATE AND FIELD-CONFIRMED: `next-popup` is tested first
  // because it is the norm (Things 3.23+, "in almost all scenarios" — the
  // maintainer, 2026-09-02), and `legacy` is the retained fallback for ≤3.22.
  // Both remain POSITIVE matches and an unrecognized third dialog still returns
  // "unknown" so the drive refuses rather than pressing structural indices into a
  // tree it cannot identify — that property is what the step is for, and it is
  // not worth one hop to assume instead.
  return `${SE}
  set g to (${groupPath})
  set sv to {}
  set sp to {}
  try
    set sv to (value of static texts of g)
    set sp to (position of static texts of g)
  end try
  -- Two reads of a class are two events, so a tree that changed between them can
  -- return mismatched lengths. That is not a shape, it is a half-picture, and it
  -- fails closed (cgSnap's own rule).
  if ((count of sv) is not (count of sp)) then return "unknown"
  log "${AX_ELEMS_LOG_PREFIX}" & (count of sv)
  set nextY to missing value
  repeat with i from 1 to (count of sv)
    set v to contents of (item i of sv)
    if v is not missing value then
      try
        if (v as text) is "Next:" then set nextY to (item 2 of (contents of (item i of sp)))
      end try
    end if
  end repeat
  if nextY is missing value then return "unknown"
  set pp to {}
  try
    set pp to (position of pop up buttons of g)
  end try
  repeat with p in pp
    set dy to (item 2 of (contents of p)) - nextY
    if dy < 0 then set dy to -dy
    if dy <= ${tol} then return "next-popup"
  end repeat
  set ap to {}
  try
    set ap to (position of (every UI element of g whose role is "AXDateTimeArea"))
  end try
  repeat with p in ap
    set dy to (item 2 of (contents of p)) - nextY
    if dy < 0 then set dy to -dy
    if dy <= ${tol} then return "legacy"
  end repeat
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
  -- READ THE POP-UP BEFORE OPENING IT (field report, 2026-09-02: "the drive
  -- opens the Next: pop-up only to select the option that was ALREADY
  -- selected"). The commonest first occurrence a caller asks for is the one the
  -- rule already produces, and the whole menu walk below then exists to click
  -- the item the control is already showing — a menu open, a cascade of title
  -- reads, a click, a settle and a read-back, to arrive where it started.
  --
  -- ONE content read on the ONE control decides it. This is the same
  -- read-back-first discipline as the typing primitives (issue #620 item 7), and
  -- it weakens no verification: nothing is skipped except an ACTUATION whose
  -- outcome is already the current state, and the drive's oracles are unchanged
  -- — the pre-commit audit still re-reads this pop-up through its own address,
  -- and the write pipeline still verifies the honored first occurrence against
  -- the database (#508).
  log "${AX_ELEMS_LOG_PREFIX}1"
  set already to ""
  try
    set already to (value of pu) as text
  end try
  set alreadyYMD to my parsedYMD(already)
  set alreadySatisfied to false
  if alreadyYMD is not missing value then
    if (item 1 of alreadyYMD) is wantY and (item 2 of alreadyYMD) is wantM and (item 3 of alreadyYMD) is wantD then
      set alreadySatisfied to true
    end if
  else if isToday then
    -- THE "Today" LABEL. The pop-up's own options are the localized word for
    -- today, then the rule's upcoming occurrences as dates, then a More… item;
    -- so a value that will not PARSE as a date is the today item, and the app is
    -- saying the first occurrence is today. That inference is not new here — the
    -- menu walk below already takes an unparseable FIRST ITEM to be today and
    -- clicks it — this applies the same law to the same control's value, which
    -- matters because make-repeating defaults its first occurrence to the item's
    -- own scheduled date and "today" is the commonest one there is.
    if already is not "" then set alreadySatisfied to true
  end if
  if alreadySatisfied then
    log "${AX_SETTLE_LOG_PREFIX}the Next: pop-up already showed the requested first occurrence ~ skip reason=next-already-satisfied"
    return "${OK_ALREADY}"
  end if
  repeat 20 times
    if (exists menu 1 of pu) then exit repeat
    click pu
    delay 0.3
  end repeat
  set theMenu to menu 1 of pu
  set clickedTitle to ""
  set levelsSeen to 0
  set opener to (value of pu) as text
  set sample to ""
  set sampled to 0
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
        -- Keep a short sample of what THIS menu actually offered, so a miss can
        -- report the dates the dialog had rather than only the one it lacked.
        if sampled < ${SAMPLE_ITEMS} then
          if sample is not "" then set sample to sample & ", "
          set sample to sample & (nm as text)
          set sampled to sampled + 1
        end if
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
    error "select-next-occurrence: this Repeat dialog offers only the rule's own upcoming occurrences (and today) as the first occurrence, and ${isoDate} is not one of them — searched " & levelsSeen & " level(s) of the Next: menu, which opened on \\"" & opener & "\\" and led with: " & sample & ". Ask for a date the rule actually produces, or change the rule."
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
 * settle-occurrences: let the 3.23 `Next:` pop-up ABSORB the rule change the
 * preceding steps made, before the drive touches the dialog again (NEXTPOP1).
 *
 * MEASURED (golden-v4 / Things 3.23, `research-nextpop1.sh` DIAG3/DIAG4): the
 * dialog recomputes the first-occurrence pop-up — its displayed value AND the
 * menu of occurrences behind it — ASYNCHRONOUSLY. After the yearly anchor was
 * moved from Aug 6 to Aug 20 the control flipped at **t+0.4s** with nothing else
 * driven; when the very next step (the "Add deadlines" checkbox) was pressed
 * inside that window instead, the control NEVER caught up — it still read
 * `Thu, Aug 6, 2026`, and its menu still enumerated the Aug-6 series, six
 * seconds later. A cancelled recompute does not retry.
 *
 * That is what made every deadlined monthly/yearly promote fail closed on 3.23:
 * the anchor drive is followed immediately by the deadline controls, so by the
 * time `select-next-occurrence` opened the menu it was the SEED's series, and
 * the requested date — the rule's own first due date — was genuinely not in it
 * (VMRES1 §4.3, reproduced and explained in NEXTPOP1).
 *
 * The wait is closed-loop in the direction that matters: it exits the moment the
 * control MOVES, which is the case that needs waiting for. When the rule change
 * did not move the first occurrence there is nothing to observe, so the budget
 * bounds it — deliberately over-cautious, since the cost is a fraction of a
 * second and the alternative is a series that starts on the wrong date.
 */
export function axSettleOccurrencesScript(
  popupPath: string,
  budgetMs = OCCURRENCE_SETTLE_MS,
  pollMs = OCCURRENCE_POLL_MS,
  obs: SettleInjector = inertSettleInjector(),
): string {
  const poll = Math.max(50, Math.trunc(pollMs)) / 1000;
  const reads = Math.max(1, Math.ceil(Math.max(1, Math.trunc(budgetMs)) / Math.max(50, pollMs)));
  // `before` and `after` are AppleScript's own positional keywords and `now` is
  // taken too — `set before to …` does not even COMPILE (osacompile: "Expected
  // expression but found “to”"), and osascript reports that as a drive failure at
  // run time, mid-dialog. Hence the deliberately dull variable names.
  if (obs.live) {
    // THE SAME QUESTION, ASKED ONCE (VOPAT2). The poll below re-READS the pop-up
    // up to twelve times to notice a recompute the app announces with a single
    // `AXValueChanged` on that very control. Two reads replace thirteen, and the
    // verdict is still decided by the VALUE rather than by the notification: a
    // recompute that landed before this hop began reads back identical either
    // way, which is exactly what the polling form reported too.
    return `${obs.handlers()}

${SE}
  set wasValue to (value of ${popupPath}) as text
end tell
${obs.mark("obsSeq", "")}
${obs.soft("obsSeq", { what: "the first-occurrence pop-up recomputing", want: ["AXValueChanged:AXPopUpButton"], timeoutMs: Math.max(1, Math.trunc(budgetMs)) }, "")}
${SE}
  set curValue to (value of ${popupPath}) as text
  if curValue is not wasValue then return "moved: " & wasValue & " -> " & curValue
  return "unchanged: " & wasValue
end tell`;
  }
  return `${SE}
  set wasValue to (value of ${popupPath}) as text
  repeat ${reads} times
    delay ${poll}
    set curValue to (value of ${popupPath}) as text
    if curValue is not wasValue then return "moved: " & wasValue & " -> " & curValue
  end repeat
  return "unchanged: " & wasValue
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
        -- No Escape here (issue #620): a keystroke reaches whatever owns the
        -- screen, and this error path is exactly when that is least certain.
        -- The open menu is left for the driver's audited cleanup, which is the
        -- ONE place an Escape is decided.
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
export function axAssertEligibleScript(
  targetUuid: string,
  menuItemPath: string,
  settleMs: number = MENU_SETTLE_TIMEOUT_MS,
): string {
  const u = escapeAppleScript(targetUuid);
  return `set t0 to (current date)
set verdict to my aeCheck()
repeat until verdict is "OK"
  if ((current date) - t0) is greater than or equal to ${pollSeconds(settleMs)} then exit repeat
  delay ${IN_SCRIPT_POLL_S}
  set verdict to my aeCheck()
end repeat
return verdict

on aeCheck()
  set selIds to {}
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
  return "OK"
end aeCheck`;
}

/** activate: foreground Things (the fallback preamble step). */
export function axActivateScript(): string {
  return `tell application "Things3" to activate`;
}
/**
 * key: a space-separated keystroke spec (e.g. "down down return").
 *
 * Frontmost-guarded in-script (issue #620): `key code`/`keystroke` reach
 * whatever application owns the screen, so the script refuses — naming that
 * application — rather than firing keys into someone else's window.
 */
export function axKeyScript(keys: string): string {
  const KEY_CODES: Record<string, number> = { return: 36, escape: 53, down: 125, up: 126, tab: 48 };
  const spec = keys.trim();
  const lines = keys
    .split(/\s+/)
    .filter((k) => k !== "")
    .map((k) =>
      KEY_CODES[k] !== undefined
        ? `key code ${KEY_CODES[k]}`
        : `keystroke "${escapeAppleScript(k)}"`,
    );
  return `${AX_FOCUS_GUARD_HANDLERS}

my fgAssertFront("send the keystrokes \\"${escapeAppleScript(spec)}\\"")
tell application "System Events" to tell process "Things3"
  ${lines.join("\n  ")}
end tell`;
}
/**
 * type-text: send literal text to whatever control holds focus (HXPC1). The
 * Move… picker focuses its own filter field the instant it opens, and that field
 * is NOT addressable as a direct child of the picker window — so there is no
 * element to hand `set-value`, whose select-all + Tab commit would be wrong for a
 * search field regardless (a popover filter has no next key view for Tab to move
 * to). Unlike {@link axKeyScript}, which splits its spec on whitespace and would
 * drop the spaces out of a multi-word project title, this sends the string as
 * ONE keystroke. It is deliberately not self-verifying: the `click-picker-row`
 * step that follows resolves the destination row by name and fails closed when
 * the filter did not produce it, so a keystroke that landed elsewhere can never
 * be committed. One stable command shape.
 */
export function axTypeTextScript(text: string): string {
  return `${AX_FOCUS_GUARD_HANDLERS}

my fgAssertFront("type into the focused field")
${SE}
  keystroke "${escapeAppleScript(text)}"
end tell`;
}

/**
 * resolve-frame for a control nested inside a CONTENT-TABLE ROW: walk the
 * table's rows → cells → cell children and return the frame of the one whose
 * `AXDescription` equals `description` (HXPC1, docs/lab/hxpc1-picker-assert.md
 * §B0). Same "x y w h" contract as {@link axFrameScript}.
 *
 * This exists because the heading row's `…` button — the only content-row
 * control that carries its own title (`"More. <heading title>"`, the HEADXPROJ
 * enabler) — sits at `UI element N of cell 1 of row M of the table`, and
 * `first UI element of <table> whose description is …` searches the table's
 * DIRECT children only. Those are the rows, which carry no description, so the
 * shipped one-level spelling matched nothing and the ellipsis drives
 * (`project.move-heading-to-project`, `project.dissolve-heading`) died at their
 * own frame resolution before any click — measured on Things 3.23 against a
 * heading whose button the raw Accessibility API resolves at the same instant.
 * The row/cell indices are never guessed: every row is walked and the match is
 * exact, so a heading whose title changed under us fails closed by name.
 */
export function axRowCellFrameScript(tablePath: string, description: string): string {
  const d = escapeAppleScript(description);
  return `${SE}
  set t to (${tablePath})
  repeat with r in rows of t
    repeat with c in UI elements of r
      repeat with e in UI elements of c
        try
          if ((description of e) as text) is "${d}" then
            set _p to position of e
            set _s to size of e
            return ((item 1 of _p) as text) & " " & ((item 2 of _p) as text) & " " & ((item 1 of _s) as text) & " " & ((item 2 of _s) as text)
          end if
        end try
      end repeat
    end repeat
  end repeat
  error "no row of this project's list exposes \\"${d}\\" — the heading may have been renamed, moved or deleted since it was read"
end tell`;
}

/**
 * resolve-frame for the Move… picker ROW carrying an exact project title — the
 * step that replaced the recipe's blind Return (HXPC1,
 * docs/lab/hxpc1-picker-assert.md §B).
 *
 * The picker exposes no `AXSelected` / `AXFocused` / `AXHighlighted` on any row
 * (measured — only its filter field is focused), so there is nothing to read
 * back from a keyboard commit and no way to assert what Return would take. What
 * it does expose is one `AXUnknown` per row whose `AXDescription` IS the project
 * title, and — whenever the filter holds text — a trailing
 * `New Project "<typed text>"` row that CREATES a project when committed. That
 * row is what the blind Return took whenever the destination was missing from
 * the picker, which an ordinary database-resolved destination reaches: a
 * COMPLETED or CANCELED project appears nowhere in the picker, so the drive
 * minted a second project of the same title and moved the heading into it
 * (measured 3.23: projects 14 → 15, heading re-parented to the new row).
 *
 * So the commit is addressed instead of guessed. The script requires:
 *   - the picker to be the window it claims (its `AXIdentifier` begins
 *     `MovePopUpDialog-`) — a positive identity check, so a different detached
 *     window can never be clicked into;
 *   - EXACTLY ONE row whose description equals the destination title (the
 *     New-Project row's description is the quoted form, so an exact match cannot
 *     hit it);
 *   - that row's centre to lie inside the picker's own scroll area — the CNCAC1
 *     off-screen hazard, where a row scrolled past the fold still resolves a
 *     frame and a click at it lands on the desktop.
 * Any miss FAILS CLOSED naming the destination and listing every row the picker
 * actually offered, so the caller learns what the app was willing to move to.
 */
export function axPickerRowFrameScript(pickerPath: string, title: string): string {
  const t = escapeAppleScript(title);
  return `${SE}
  set w to (${pickerPath})
  set pickerId to ""
  try
    set pickerId to (value of attribute "AXIdentifier" of w) as text
  end try
  if pickerId does not start with "MovePopUpDialog-" then
    error "the front dialog is not the Move… project picker (window id \\"" & pickerId & "\\") — nothing was committed"
  end if
  -- positional-ok: the picker window holds exactly one scroll area (MEASURED,
  -- HXPC1 §B2: "direct text fields=0  scroll areas=1"), and the window's own
  -- AXIdentifier was checked above, so this is a container handle inside an
  -- already-identified window — the ROW is addressed by exact title below.
  set sa to scroll area 1 of w
  set saPos to position of sa
  set saSize to size of sa
  set saTop to item 2 of saPos
  set saBottom to saTop + (item 2 of saSize)
  set hits to {}
  set offered to ""
  repeat with i from 1 to (count of UI elements of sa)
    set e to UI element i of sa
    set d to ""
    try
      set d to (description of e) as text
    end try
    if d is not "" and (role of e) is "AXUnknown" then
      set offered to offered & " [" & d & "]"
      if d is "${t}" then set end of hits to e
    end if
  end repeat
  if (count of hits) is 0 then
    error "the Move… picker offers no project named \\"${t}\\" — it offered:" & offered & ". Committing here would have created a new project with that name instead of moving into the existing one. A completed or canceled project is not offered by this picker."
  end if
  if (count of hits) > 1 then
    error "the Move… picker offers " & (count of hits) & " rows named \\"${t}\\" — it offered:" & offered
  end if
  set row1 to item 1 of hits
  set rp to position of row1
  set rs to size of row1
  set cy to (item 2 of rp) + ((item 2 of rs) / 2)
  if cy < saTop or cy > saBottom then
    error "the \\"${t}\\" row is scrolled out of the Move… picker's visible list, so clicking it would land outside the picker — narrow the destination or scroll it into view"
  end if
  return ((item 1 of rp) as text) & " " & ((item 2 of rp) as text) & " " & ((item 1 of rs) as text) & " " & ((item 2 of rs) as text)
end tell`;
}

/**
 * The abort keystroke, sent ONLY from the audited cleanup ladder (issue #620)
 * and only once that ladder has proven Things owns the screen. It is scoped to
 * the Things process for readability, but scoping is not what makes it safe —
 * a synthetic key goes to whatever is frontmost, which is why the script
 * carries the same in-script frontmost assertion every other keystroke does.
 */
export function axAbortScript(): string {
  return `${AX_FOCUS_GUARD_HANDLERS}

my fgAssertFront("dismiss the open dialog with Escape")
${SE}
  key code 53
end tell`;
}

/**
 * Dismiss the open dialog by PRESSING ITS OWN CANCEL BUTTON (issue #620).
 *
 * Preferred over Escape wherever it works, for two independent reasons: an
 * AXPress is addressed at an ELEMENT, so it cannot leak into another
 * application the way a keystroke can, and it works while Things is in the
 * BACKGROUND — the cleanup never has to steal the user's focus to undo its own
 * half-finished dialog. The button is addressed by its pinned English title,
 * exactly like every other selector in this vector, and the dialog shell is
 * resolved the same two ways the census resolves it (attached sheet, or the
 * detached editor window Things presents when it is not frontmost).
 *
 * Returns "OK" after pressing, or a diagnostic ("NO-DIALOG" / "NO-CANCEL") the
 * ladder falls through on — it never claims a dismissal; the caller re-reads
 * the census to decide that.
 */
export function axCancelDialogScript(): string {
  return `${SE}
${AX_DIALOG_SHELL_SNIPPET}
  if shellRef is missing value then return "NO-DIALOG"
  if not (exists button "Cancel" of shellRef) then return "NO-CANCEL"
  click button "Cancel" of shellRef
  return "OK"
end tell`;
}

/**
 * The Cancel button's on-screen FRAME, resolved through the same addressed
 * dialog-shell path the AXPress dismissal uses (issue #629). Feeds the pointer
 * fallback: if `AXPress` on the button reports success and the dialog is still
 * standing, a real click at the button's own AX-resolved centre is the next
 * thing to try before discarding the window wholesale. The frame comes from the
 * tree, never from a remembered coordinate, so a moved dialog fails closed.
 */
export function axCancelFrameScript(): string {
  return `${SE}
${AX_DIALOG_SHELL_SNIPPET}
  if shellRef is missing value then error "no dialog is open"
  if not (exists button "Cancel" of shellRef) then error "the open dialog has no Cancel button"
  set _b to button "Cancel" of shellRef
  set _p to position of _b
  set _s to size of _b
  return ((item 1 of _p) as text) & " " & ((item 2 of _p) as text) & " " & ((item 1 of _s) as text) & " " & ((item 2 of _s) as text)
end tell`;
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
    -- positional-ok: an APP-LEVEL command to the Things scripting dictionary, not
    -- an Accessibility element path — "close the front window", whichever it is,
    -- which is the whole intent of the maneuver (a stuck sheet goes with it).
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
    -- positional-ok: an EXISTENCE probe over the one attached sheet a window can
    -- present; no element is read or written through this path.
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
 *   - "none"          — the census found no dialog open (nothing to clear);
 *   - "dismissed"     — it is gone, and a fresh census CONFIRMED that;
 *   - "cleared-blind" — the session was AX-blind (locked / off-Space), so no
 *                       census and no keystroke can be trusted; the PROVEN
 *                       app-level close+reopen ran to clear it (cannot be
 *                       AX-confirmed, but the maneuver works blind — SESSGATE);
 *   - "foreign"       — a dialog is open that this drive did not open, so it was
 *                       LEFT ALONE (a cleanup must never dismiss the dialog the
 *                       person at the keyboard opened after our failure);
 *   - "may-remain"    — ours, and nothing in the ladder would close it
 *                       (fail-closed: report it precisely, with the sync gate).
 */
export type ClearOutcome = UiClearOutcome;

export interface ClearResult {
  state: ClearOutcome;
  /** How it was closed, for the trace and the disclosure. */
  how?: "cancel-button" | "escape" | "window-close";
  /** What the census identified as open at cleanup time. */
  sheetKind?: UiSheetKind;
  /** Who owned the screen when the cleanup started, when it was not Things. */
  focusOwner?: string;
  /**
   * True when the cleanup ran WITHOUT a working window-state inspection (issue
   * #629) — the dismissal and its proof came from addressed reads alone, so the
   * outcome is real but the identity of what was dismissed was taken from what
   * this drive had already observed rather than re-confirmed.
   */
  unverified?: boolean;
}

/**
 * Is the dialog the census found OURS to dismiss? `expected` is the kind this
 * drive was observed driving (latched from the census the drive itself ran). A
 * kind that does not match is left strictly alone: between our failure and this
 * cleanup, the person at the keyboard may have opened something of their own,
 * and dismissing it would be a mutation nobody asked for.
 *
 * With nothing latched (a drive that failed before any dialog was observed) the
 * two kinds this vector's recipes actually open are still treated as ours —
 * they are the dialogs our own steps would have opened — while an unrecognized
 * modal never is.
 */
function oursToDismiss(kind: UiSheetKind, expected: UiSheetKind | null): boolean {
  if (kind === "none") return false;
  if (expected !== null) return kind === expected;
  return kind === "repeat" || kind === "move-picker";
}

/** How many stacked dialogs the cleanup will unwind before falling to the next rung. */
const MAX_DISMISS_ROUNDS = 4;

/** Press the dialog's own Cancel button (element-addressed, background-safe). */
async function pressCancel(run: UiRunner): Promise<boolean> {
  const res = await run(
    {
      primitive: "dismiss-dialog",
      label: "dismiss the open dialog (its Cancel button)",
      script: axCancelDialogScript(),
    },
    STEP_TIMEOUT_MS,
  );
  return res.ok && res.stdout.trim() === "OK";
}

/**
 * The pointer fallback for the Cancel rung (issue #629): a real click at the
 * button's own AX-resolved centre, for the case where `AXPress` reports success
 * and the dialog is demonstrably still standing. Needs Things frontmost — the
 * HID tap posts at the foreground surface (NATIVE1-e) — so it activates first,
 * and re-reads the frame AFTERWARDS, because bringing Things forward can
 * re-attach a detached editor as a sheet and move the button.
 */
async function clickCancel(run: UiRunner): Promise<boolean> {
  await run(
    {
      primitive: "activate",
      label: "bring Things forward to click its dialog's Cancel button",
      script: axActivateScript(),
    },
    STEP_TIMEOUT_MS,
  );
  const frameRes = await run(
    {
      primitive: "resolve-frame",
      label: "locate the open dialog's Cancel button",
      script: axCancelFrameScript(),
    },
    STEP_TIMEOUT_MS,
  );
  if (!frameRes.ok) return false;
  const center = parseFrameCenter(frameRes.stdout);
  if (center === null) return false;
  const res = await run(
    uiClickPointCommand(center.x, center.y, "click the open dialog's Cancel button"),
    STEP_TIMEOUT_MS,
  );
  return res.ok;
}

/**
 * The dismissal that needs NO working inspection (issue #629): press the
 * dialog's own Cancel button, PROVE the dialog is gone with one addressed
 * existence read, and fall through to a real click at the button's frame if the
 * press reported success while the dialog stayed up.
 *
 * This is the rung the field incident needed and did not have. Its cleanup
 * re-ran the census that had just stalled, learned nothing three times over,
 * and ended in the AX-blind close+reopen — which left the sheet standing, and
 * with it the app-wide scripting freeze that stopped the composite trashing its
 * own disposable copy (MODALX1 §2.1) and the Things Cloud sync gate.
 *
 * Everything here is addressed inside `process "Things3"`: {@link
 * axCancelDialogScript} and {@link axSheetOpenScript} are the same shape as the
 * drive steps that kept working while the census did not.
 */
async function semanticCancel(
  run: UiRunner,
  expected: UiSheetKind | null,
  owner: { focusOwner?: string },
): Promise<ClearResult> {
  const kind = expected === null ? {} : { sheetKind: expected };
  // A stack unwinds LIFO (MODALX1 §6), so press-and-verify in a loop rather
  // than pressing once and assuming.
  for (let i = 0; i < MAX_DISMISS_ROUNDS; i += 1) {
    if (!(await pressCancel(run))) break;
    if (!(await sheetStillOpen(run))) {
      return { state: "dismissed", how: "cancel-button", ...kind, ...owner, unverified: true };
    }
  }
  if (await clickCancel(run)) {
    if (!(await sheetStillOpen(run))) {
      return { state: "dismissed", how: "cancel-button", ...kind, ...owner, unverified: true };
    }
  }
  return closeReopenRung(run, expected, owner, false, true);
}

/**
 * Clear a half-open dialog a failed drive left behind — AUDITED at every rung
 * (issue #620; supersedes the unconditional Escape, which was measured firing
 * into a foreign application's modal while the Things sheet it was meant for
 * stayed open all night).
 *
 * The ladder, cheapest and least disruptive first, re-reading the census after
 * every rung so nothing is ever CLAIMED to be dismissed:
 *
 *   0. census. No dialog + a reachable session → nothing to do. A dialog that
 *      is not ours → left alone, reported.
 *   1. press the dialog's own CANCEL button — element-addressed, so it needs
 *      neither focus nor the frontmost slot, and it cannot leak into another
 *      app. This is the rung that clears the ordinary case.
 *   2. Escape, but only from a state where Things demonstrably owns the screen:
 *      if it does not, RE-ACTIVATE Things, RE-AUDIT, and only then send it.
 *   3. the app-level close+reopen (SESSGATE) — the maneuver that works with no
 *      Accessibility tree at all, and the documented recovery for the app-wide
 *      AppleScript freeze a stuck sheet imposes (oddities §9cc), which is what
 *      makes a caller's follow-up cleanup mutations land again.
 *
 * `expected` is the dialog kind this drive was observed driving; see
 * {@link oursToDismiss}.
 */
async function clearDialog(
  run: UiRunner,
  expected: UiSheetKind | null = null,
  inspectionStalled = false,
): Promise<ClearResult> {
  // #629: the inspection already refused to answer once. Asking it again buys
  // nothing and costs the caller another deadline — go straight to the rung
  // that needs no inspection and proves itself with one addressed read.
  if (inspectionStalled) return semanticCancel(run, expected, {});
  const census = await readUiState(run, CENSUS_TIMEOUT_MS);
  if (censusUnverifiable(census)) return semanticCancel(run, expected, {});
  const owner =
    census !== null && !census.thingsFrontmost ? { focusOwner: describeFocusOwner(census) } : {};
  const readable = census !== null && census.inspectable;

  // 0. A clean, readable "no dialog" — but only trustworthy on a session whose
  //    windows are AX-visible at all: a locked screen / full-screen Space
  //    enumerates ZERO windows, so the census would report "no dialog" for a
  //    sheet that is very much open (SESSGATE). Confirm before believing it.
  if (readable && census.sheetOpen === false) {
    const reach = await probeSessionReachability(run, STEP_TIMEOUT_MS);
    if (reach.reachable) return { state: "none" };
    // AX-blind: System Events enumerates zero windows for EVERY app, so the
    // census cannot see a sheet that is open — and equally cannot confirm one
    // is gone. Run the blind-proof maneuver and report it as unconfirmed.
    return closeReopenRung(run, expected, owner, true);
  }
  // 0b. A dialog someone else opened — never touched.
  if (readable && !oursToDismiss(census.sheetKind, expected)) {
    return { state: "foreign", sheetKind: census.sheetKind, ...owner };
  }
  const kind = readable ? { sheetKind: census.sheetKind } : {};

  // 1. Its own Cancel button — repeated while a STACK unwinds, because dialogs
  //    nest and dismiss strictly LIFO (MODALX1 §6), re-reading between presses
  //    so a dialog that is not ours stops the loop rather than being clicked.
  if (readable) {
    for (let i = 0; i < MAX_DISMISS_ROUNDS; i += 1) {
      if (!(await pressCancel(run))) break;
      const after = await readUiState(run, CENSUS_TIMEOUT_MS);
      if (after === null || !after.inspectable) break;
      if (!after.sheetOpen) return { state: "dismissed", how: "cancel-button", ...kind, ...owner };
      if (!oursToDismiss(after.sheetKind, expected)) {
        return { state: "foreign", sheetKind: after.sheetKind, ...owner };
      }
    }
  }

  // 2. Escape — from a state where Things owns the screen, re-activating and
  //    RE-AUDITING first when it does not (never a blind key into the unknown).
  let front = readable && census.thingsFrontmost;
  if (readable && !front) {
    await run(
      {
        primitive: "activate",
        label: "bring Things forward to dismiss its dialog",
        script: axActivateScript(),
      },
      STEP_TIMEOUT_MS,
    );
    const reaudit = await readUiState(run, CENSUS_TIMEOUT_MS);
    if (reaudit !== null && reaudit.inspectable) {
      if (!reaudit.sheetOpen)
        return { state: "dismissed", how: "cancel-button", ...kind, ...owner };
      if (!oursToDismiss(reaudit.sheetKind, expected)) {
        return { state: "foreign", sheetKind: reaudit.sheetKind, ...owner };
      }
      front = reaudit.thingsFrontmost;
    }
  }
  if (front) {
    await run(
      { primitive: "key", label: "abort (Escape)", script: axAbortScript() },
      STEP_TIMEOUT_MS,
    );
    const after = await readUiState(run, CENSUS_TIMEOUT_MS);
    if (after !== null && after.inspectable && !after.sheetOpen) {
      return { state: "dismissed", how: "escape", ...kind, ...owner };
    }
  }

  // 3. The blind-proof maneuver, last: it discards the half-entered dialog with
  //    the window, and unwedges the app-wide AppleScript freeze with it.
  return closeReopenRung(run, expected, owner);
}

/**
 * The final rung: close+reopen the Things window, then re-audit if we can.
 * `blind` says the session itself is AX-blind, in which case NOTHING the census
 * reports afterwards is evidence — the outcome is honestly unconfirmed.
 */
async function closeReopenRung(
  run: UiRunner,
  expected: UiSheetKind | null,
  owner: { focusOwner?: string },
  blind = false,
  /**
   * #629: the window-state inspection is not answering, so the outcome is
   * decided by the ADDRESSED sheet-open read instead of a fresh census. The
   * verdict is still proven — just proven by a narrower question.
   */
  inspectionStalled = false,
): Promise<ClearResult> {
  await run(
    {
      primitive: "resolve",
      label: "clear a stuck dialog (close the Things window and reopen it)",
      script: axCloseReopenActivateScript(),
    },
    STEP_TIMEOUT_MS,
  );
  if (blind) return { state: "cleared-blind", how: "window-close", ...owner };
  if (inspectionStalled) {
    const kind = expected === null ? {} : { sheetKind: expected };
    if (!(await sheetStillOpen(run))) {
      return { state: "dismissed", how: "window-close", ...kind, ...owner, unverified: true };
    }
    return { state: "may-remain", ...kind, ...owner, unverified: true };
  }
  const after = await readUiState(run, CENSUS_TIMEOUT_MS);
  if (after === null || !after.inspectable) {
    return { state: "cleared-blind", how: "window-close", ...owner };
  }
  if (!after.sheetOpen) return { state: "dismissed", how: "window-close", ...owner };
  return {
    state: oursToDismiss(after.sheetKind, expected) ? "may-remain" : "foreign",
    sheetKind: after.sheetKind,
    ...owner,
  };
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
/**
 * A synthesized HID click at a screen point. Exported (issue #640) so the rescue
 * path's Cancel fallback and the drive's own click are literally the same shape
 * — a second construction site is a second place for the event sequence to drift.
 */
export function uiClickPointCommand(x: number, y: number, label: string): UiCommand {
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
  return `${AX_DATE_AREA_PRELUDE}
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
  // rather than let a garbled commit verify as ok (YANCH1 #493). Like every
  // per-step read-back here it is SELF-REFERENTIAL (it re-reads the area it just
  // picked), so the pre-commit audit re-checks it from the outside.
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
 * The shared ObjC-bridge prelude for every `AXDateTimeArea` read or write: the
 * attribute helpers, the DIALOG-SHELL resolver (so the walk stays inside the
 * dialog's small subtree — the app-root descent PERF2 removed cost ~4.4s on a busy
 * host), and the deterministic {@link pick} target discriminator. The write
 * ({@link axSetDateTimeScript}) and the pre-commit read
 * ({@link axAuditDateAreasScript}) MUST agree on which area is which, so they
 * share one definition rather than two that can drift apart.
 */
const AX_DATE_AREA_PRELUDE = `ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('ApplicationServices');
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
`;

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
  const counting = axRoundTripCountingArmed();
  const res = await osaExec(command.script ?? "", { lang, timeoutMs });
  const out = counting ? splitAeDebug(res.stdout) : null;
  const err = counting ? splitAeDebug(res.stderr) : null;
  // The element-realization lines are stripped ALWAYS, armed or not: the scripts
  // log them unconditionally (so the count survives deputy routing), and a
  // refusal a caller reads must never carry the machinery.
  const elems = parseElemLog(err === null ? res.stderr : err.text);
  // The settle records come off the SAME stream and are stripped the same way,
  // for the same reason: a refusal a caller reads must never carry machinery.
  const settled = parseSettleLog(elems.stderr);
  return {
    ok: res.exitCode === 0 && res.timedOut !== true,
    stdout: out === null ? res.stdout : out.text,
    stderr: settled.stderr,
    ...(res.timedOut === true && { timedOut: true }),
    ...(out !== null && err !== null && { axOps: out.axOps + err.axOps }),
    ...(elems.axElems !== null && { axElems: elems.axElems }),
    ...(settled.settles.length > 0 && { settles: settled.settles }),
  };
}

/**
 * Read the live window/focus census through the shipped dispatch seam — the
 * transport behind the window-state diagnostic (src/ui-state.ts) and, in tests,
 * behind any injected runner. READ-ONLY: the census clicks nothing, types
 * nothing, and changes no state; see src/write/vectors/ui-state.ts.
 */
export function readLiveUiState(run: UiRunner = defaultRun): Promise<UiState | null> {
  return readUiState(run, CENSUS_TIMEOUT_MS);
}

/**
 * The production dispatch seam itself, exported (issue #640).
 *
 * The drive owns its own runner and always will. But `things rescue` presses a
 * button on a dialog no drive opened, so it needs the SAME transport — the
 * deputy routing, the reveal/osascript split, the timeout handling — without
 * borrowing the drive's recipe machinery. Re-declaring a second dispatcher would
 * mean a second place for the deputy contract to drift, which is the one thing
 * this seam exists to prevent.
 *
 * Nothing else changes: this is `defaultRun` under a name a caller outside the
 * vector can read, and every injected-runner test seam still works exactly as
 * before.
 */
export const defaultUiRunner: UiRunner = defaultRun;

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
      // The round-trip count rides EVERY traced hop when counting is armed
      // (RDLAT2): `durationMs` says what this host paid, `axOps` says what any
      // host would pay, and only the second one transfers between machines.
      ...(res.axOps !== undefined && { axOps: res.axOps }),
      // The elements whose content this hop realized — the term the field pays
      // ~115 ms each for, and the one a plural read hides from an event count.
      ...(res.axElems !== undefined && { axElems: res.axElems }),
      // Every notification this hop waited on, with the latency the APP took to
      // announce (VOPAT2) — the term a settled drive should end up bound by.
      ...(res.settles !== undefined && { settles: res.settles }),
      ok: res.ok,
      timedOut: res.timedOut === true,
    }));
    return res;
  };
}

/**
 * PRIMITIVE CLASSIFICATION for the per-step guard (issue #620). What decides a
 * primitive's class is HOW macOS routes its effect, not what it looks like:
 *
 *   - KEYSTROKE-CLASS — System Events `keystroke` / `key code`. The event is
 *     handed to whatever application owns the screen, so these need Things
 *     frontmost AND the dialog we opened still in front. The element half of
 *     the guard (did the field actually take focus?) is asserted in-script, in
 *     the same hop as the typing.
 *   - POINTER-CLASS — mouse synthesis through the global HID event tap
 *     (`CGEventPost(kCGHIDEventTap)`). It posts at the FOREGROUND surface
 *     (NATIVE1-e: `CGEventPostToPid` is inert for Things' hit-testing), so a
 *     click while another app is frontmost lands in that app's window. Frontmost
 *     is required; focus is not (a click sets its own).
 *   - Everything else is ELEMENT-ADDRESSED — `click <element>`, `set value`,
 *     `set focused`, the ObjC `AXUIElementSetAttributeValue` date writes, and
 *     every read. System Events delivers those to the element named, whether or
 *     not the app is frontmost, so guarding them would only add a hop and
 *     forbid perfectly good background work.
 *   - `chord-post` is deliberately NOT guarded: it posts its key event with
 *     `CGEventPostToPid`, which addresses the PROCESS rather than the focused
 *     surface — the whole point of the heading-reorder gesture is that it runs
 *     with Things in the background and the user's focus untouched (HEADORD1
 *     1h2a, CHORDMH1). A frontmost guard there would break a certified op.
 */
const KEYSTROKE_CLASS: ReadonlySet<UiCommandPrimitive> = new Set<UiCommandPrimitive>([
  "key",
  "type-text",
  "set-value",
  "set-group-number",
  "set-row-field",
]);

const POINTER_CLASS: ReadonlySet<UiCommandPrimitive> = new Set<UiCommandPrimitive>([
  "click-point",
  "sidebar-drag",
  "sidebar-held-drag",
  "sidebar-scroll",
  "sidebar-chevron",
]);

/** What the drive has observed about the dialog it is driving (see {@link oursToDismiss}). */
interface SheetLatch {
  sheet: UiSheetKind | null;
  /**
   * Set the FIRST time a window-state inspection fails to answer (issue #629).
   * Once it is set, nothing downstream inspects again: the cleanup ladder goes
   * straight to the dialog's own Cancel button and proves the outcome with a
   * single addressed existence read, because re-running the inspection that
   * just stalled is how one 15s stall became a 56s one and left the sheet
   * standing.
   */
  inspectionStalled: boolean;
}

/**
 * Judge one guard reading. Returns null to proceed, or the refusal sentence —
 * which always names who owns the screen, because that is the one fact the
 * person reading it cannot recover after the fact.
 *
 * Exported for the unit matrix: every branch here is a fail-closed decision
 * about synthetic input, and each one is worth a test.
 */
export function judgeFocusGuard(
  state: UiState | null,
  expectedSheet: UiSheetKind | null,
  label: string,
): string | null {
  const refuse = (why: string): string => `refused to run "${label}": ${why}`;
  if (state === null) {
    return refuse(
      "the window and focus state could not be read, so there is no proof the input would reach " +
        "Things — nothing was sent",
    );
  }
  // #629: a probe that did not come back is a DIAGNOSTIC, not a state. Say so
  // in those words, name what could not be established, and route the drive
  // straight to its cleanup — the caller must not read this as "retry".
  if (censusUnverifiable(state)) {
    return refuse(
      `the window state inspection timed out — treating the dialog as unverifiable (${describeUnprovenProbes(
        state,
      )}). Nothing was sent, and the dialog this command opened is being closed. Check that Things ` +
        "is responding, then run the same command again",
    );
  }
  if (!state.inspectable) {
    return refuse(
      `${describeFocusOwner(state)}. Input sent now would go to it, not to Things — nothing was ` +
        "sent. Answer or dismiss the system dialog, then run the same command again",
    );
  }
  if (!state.thingsFrontmost) {
    return refuse(
      `${describeFocusOwner(state)}, so the input would go there instead of to Things — nothing ` +
        "was sent. Leave Things in front while it is being driven, then run the same command again",
    );
  }
  if (expectedSheet !== null && state.sheetKind !== expectedSheet) {
    return refuse(
      `the dialog this command opened is no longer the one in front (expected ${expectedSheet}, ` +
        `found ${state.sheetKind}) — it was closed or replaced while the command was running, so ` +
        "nothing was sent",
    );
  }
  return null;
}

/**
 * Wrap the dispatch seam with the PER-STEP FOCUS GUARD (issue #620): before
 * every focus-routed hop, one cheap read-only census decides whether the input
 * can legitimately be delivered, and a violation ABORTS THE STEP rather than
 * typing into the void. Element-addressed hops pass straight through, so the
 * cost is paid only where it buys something.
 *
 * A closed loop, not a sleep: the census is a deterministic read of the live
 * state, taken immediately before the hop, and the in-script assertions close
 * the remaining milliseconds (UI-automation determinism doctrine; the #595
 * pre-commit audit and BEEP1 shape-settle are the same pattern).
 *
 * FOLDED for keystroke-class hops (DRVLAT1, issue #633). Those hops are
 * AppleScript, so the census can be — and now is — the PRELUDE OF THE VERY SCRIPT
 * THAT TYPES ({@link axFocusGuardPrelude}) rather than a hop of its own. Two
 * things improve at once: the drive stops paying a process spawn per typed
 * control, and the TOCTOU window between "the census approved this" and "the
 * keystroke went out" closes to nothing — no dispatch happens in between, because
 * there is nothing in between. The judgement is still made BEFORE the keystroke
 * (in-script, fail-closed) and the sentence a caller reads is still built HERE by
 * {@link judgeFocusGuard}, from the census that same hop logged, so there remains
 * exactly one wording of every refusal.
 *
 * POINTER-class hops keep the separate census: they dispatch JXA, which cannot
 * carry an AppleScript prelude.
 */
function guardedRun(inner: UiRunner, latch: SheetLatch): UiRunner {
  return async (command, timeoutMs) => {
    const keystroke = KEYSTROKE_CLASS.has(command.primitive);
    if (!keystroke && !POINTER_CLASS.has(command.primitive)) {
      return inner(command, timeoutMs);
    }
    // The dialog invariant applies to keystroke-class hops only: a pointer hop
    // is aimed at a frame it resolved a moment ago and fails closed on its own
    // if that frame moved.
    const expected = keystroke ? latch.sheet : null;
    const refuse = (state: UiState | null, why: string): UiRunResult => {
      trace(() => ({
        phase: "focus-guard",
        event: "refused",
        primitive: command.primitive,
        label: command.label,
        frontmost: state?.frontmostApp ?? null,
        sheetKind: state?.sheetKind ?? null,
        inspectable: state?.inspectable ?? false,
        stalled: state?.stalledProbes ?? null,
      }));
      return { ok: false, stdout: "", stderr: why };
    };
    // An inspection that would not answer poisons every later inspection's
    // credibility, so the cleanup ladder is told once and never asks again
    // (issue #629).
    const noteStall = (state: UiState | null): void => {
      if (state === null || censusUnverifiable(state)) latch.inspectionStalled = true;
    };
    // Latched only on a census that APPROVED the hop — a dialog seen while
    // refusing is, by construction, not the one this drive is driving.
    const latchSheet = (state: UiState | null): void => {
      if (state !== null && state.sheetOpen && latch.sheet === null) latch.sheet = state.sheetKind;
    };

    if (keystroke && command.lang !== "javascript" && typeof command.script === "string") {
      const res = await inner(
        { ...command, script: `${axFocusGuardPrelude(expected)}\n${command.script}` },
        timeoutMs,
      );
      const { state, stderr } = parseGuardLog(res.stderr);
      noteStall(state);
      if (!res.ok && stderr.includes(GUARD_REFUSED_TAG)) {
        // The script refused. Re-judge the census it logged for the sentence; a
        // census too damaged to re-judge still refuses — the hop already did.
        return refuse(
          state,
          judgeFocusGuard(state, expected, command.label) ??
            `refused to run "${command.label}": the window and focus state could not be read, so ` +
              "there is no proof the input would reach Things — nothing was sent",
        );
      }
      latchSheet(state);
      return { ...res, stderr };
    }

    const state = await readUiState(inner, CENSUS_TIMEOUT_MS);
    noteStall(state);
    const guardRefusal = judgeFocusGuard(state, expected, command.label);
    if (guardRefusal !== null) return refuse(state, guardRefusal);
    latchSheet(state);
    return inner(command, timeoutMs);
  };
}

/** How a dialog is named in a disclosure — behavior, not chrome. */
function dialogNoun(kind: UiSheetKind | undefined): string {
  switch (kind) {
    case "repeat":
      return "the repeat dialog";
    case "move-picker":
      return "the move-to-project chooser";
    default:
      return "a dialog";
  }
}

/**
 * The cleanup disclosure (issue #620). Every branch states what is TRUE of the
 * app right now, and — whenever a dialog may still be open — that Things Cloud
 * sync is held until someone dismisses it, which is the consequence a caller
 * cannot see and would otherwise discover hours later on another device.
 */
export function describeCleanup(clear: ClearResult): string {
  const owner = clear.focusOwner === undefined ? "" : ` (${clear.focusOwner} when cleanup started)`;
  // #629: when the window-state inspection stalled, the cleanup still ran and
  // still proved its outcome — through the narrower addressed read. Say which
  // it was, so nobody reads "confirmed closed" as more than it is.
  const how = clear.unverified === true ? " (the window state could not be inspected)" : "";
  switch (clear.state) {
    case "none":
      return "No dialog was left open in Things.";
    case "dismissed":
      return `${
        clear.how === "cancel-button"
          ? `${dialogNoun(clear.sheetKind)} was closed with its own Cancel button`
          : clear.how === "escape"
            ? `${dialogNoun(clear.sheetKind)} was dismissed with Escape`
            : `${dialogNoun(clear.sheetKind)} was cleared by closing and reopening the Things window`
      }, confirmed closed${how}${owner}.`;
    case "cleared-blind":
      return (
        "Things had no window reachable on the current screen (the Mac may be locked, or a" +
        " full-screen app is covering the desktop), so the open dialog could not be confirmed" +
        " through the on-screen layer — the Things window was closed and reopened to clear it," +
        " discarding any partially-entered rule. Unlock the Mac or leave the full-screen app" +
        " before retrying."
      );
    case "foreign":
      return (
        `A dialog is open in Things that this command did not open (${dialogNoun(clear.sheetKind)}),` +
        ` so it was left exactly as it is${owner}. Dismiss it yourself when you are ready — and note` +
        ` that ${SYNC_GATE_WARNING}.`
      );
    case "may-remain":
      return (
        `WARNING: ${dialogNoun(clear.sheetKind)} may still be open in Things${owner} — neither its` +
        " Cancel button, nor Escape, nor closing and reopening the window would clear it. Dismiss" +
        " it in Things (click Cancel, or press Escape with Things in front) before retrying: a" +
        ` leftover dialog also disables the menu bar, so the next attempt would refuse. Also note` +
        ` that ${SYNC_GATE_WARNING}.`
      );
  }
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

function refusal(detail: string): ExecuteResult {
  return { exitCode: 1, stdout: "", stderr: detail };
}

/**
 * Compile one recipe step into its primitive command (no dispatch).
 *
 * A CANDIDATE-ADDRESSED step compiles to ONE script that resolves its own element
 * and then acts on it (DRVLAT1, issue #633): the addressed body is generated
 * against {@link STEP_ELEMENT_REF} and {@link axCandidatePrelude} is prepended, so
 * the resolution that used to be a separate `resolve` hop (or several) now rides
 * the acting hop. Steps whose script is JXA, or that resolve their own target,
 * are unaffected.
 */
export function commandForStep(
  step: UiStep,
  targetUuid: string,
  obs: SettleInjector = inertSettleInjector(),
): UiCommand {
  if (step.primitive === "wait") {
    // The whole wait is ONE hop: the candidates are polled in-script until one of
    // them exists or the step's own window elapses (DRVLAT1).
    const paths = step.pathCandidates ?? [step.path ?? ""];
    return {
      primitive: "wait",
      label: step.label,
      script: axWaitAnyScript(paths, step.timeoutMs ?? STEP_TIMEOUT_MS),
    };
  }
  if (step.primitive === "dialog-open") {
    // The wait and the shell census, in one hop (RDLAT2).
    const paths = step.pathCandidates ?? [step.path ?? ""];
    return {
      primitive: "dialog-open",
      label: step.label,
      script: axDialogOpenScript(paths, step.timeoutMs ?? STEP_TIMEOUT_MS),
    };
  }
  if (step.pathCandidates !== undefined && step.path === undefined) {
    const candidates = step.pathCandidates;
    const inner = commandForStep({ ...step, path: STEP_ELEMENT_REF }, targetUuid, obs);
    // Only an AppleScript body can take the AppleScript prelude; a JXA step
    // (set-datetime, the pointer primitives) resolves its own target anyway.
    if (inner.lang === "javascript" || typeof inner.script !== "string" || inner.script === "") {
      return inner;
    }
    return {
      ...inner,
      script: `${axCandidatePrelude(candidates, RESOLVE_CANDIDATE_TIMEOUT_MS)}\n${inner.script}`,
    };
  }
  switch (step.primitive) {
    case "reveal":
      return { primitive: "reveal", label: step.label, url: revealUrl(step.value ?? targetUuid) };
    case "activate":
      return { primitive: "activate", label: step.label, script: axActivateScript() };
    case "press":
      return {
        primitive: "press",
        label: step.label,
        script: axPressScript(step.path ?? "", obs, step.settle),
      };
    case "resolve":
      return { primitive: "resolve", label: step.label, script: axResolveScript(step.path ?? "") };
    case "set-value":
      return {
        primitive: "set-value",
        label: step.label,
        script: axSetValueScript(step.path ?? "", step.value ?? "", undefined, obs),
      };
    case "set-group-number":
      return {
        primitive: "set-group-number",
        label: step.label,
        script: axSetGroupNumberScript(
          step.path ?? "",
          step.numberTarget ?? "interval",
          step.value ?? "",
          undefined,
          undefined,
          step.cadence === undefined
            ? null
            : cadenceExpectationFor(step.cadence, installedThingsVersion()),
          obs,
        ),
      };
    case "set-row-field":
      return {
        primitive: "set-row-field",
        label: step.label,
        script: axSetRowFieldScript(
          step.path ?? "",
          step.rowLabel ?? "",
          step.value ?? "",
          undefined,
          undefined,
          obs,
        ),
      };
    case "audit-dialog":
      // Compiled by driveDialogAudit, which resolves the live dialog shell and the
      // measured shape first (a control's path and its weekday base both depend on
      // them). This shape exists only so the step renders/compiles uniformly.
      return {
        primitive: "audit-dialog",
        label: step.label,
        script: "",
      };
    case "type-text":
      return {
        primitive: "type-text",
        label: step.label,
        script: axTypeTextScript(step.value ?? ""),
      };
    case "select-popup":
      return {
        primitive: "select-popup",
        label: step.label,
        script:
          step.valueCandidates !== undefined
            ? axSelectPopupCandidatesScript(step.path ?? "", step.valueCandidates, obs, step.settle)
            : axSelectPopupScript(step.path ?? "", step.value ?? "", obs, step.settle),
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
    case "settle-occurrences":
      return {
        primitive: "settle-occurrences",
        label: step.label,
        script: axSettleOccurrencesScript(step.path ?? "", undefined, undefined, obs),
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
      // A `rowCellDescription` step resolves its target by walking the addressed
      // content table's rows/cells instead (the heading `…` button, which sits
      // three levels below the table a `whose` clause can reach).
      return {
        primitive: "resolve-frame",
        label: step.label,
        lang: "applescript",
        script:
          step.rowCellDescription !== undefined
            ? axRowCellFrameScript(step.path ?? "", step.rowCellDescription)
            : axFrameScript(step.path ?? ""),
      };
    case "click-picker-row":
      // Phase 1 of the picker commit: resolve the row carrying the destination's
      // exact title (identity-checked, uniqueness-checked, on-screen-checked).
      // driveClickElement then clicks it — the recipe never presses Return.
      return {
        primitive: "resolve-frame",
        label: step.label,
        lang: "applescript",
        script: axPickerRowFrameScript(step.path ?? "", step.value ?? ""),
      };
    case "drag-reorder":
      // Composite step: drive() hands it to the sidebar drag driver, which
      // dispatches its own snapshot/scroll/drag commands through `run`. This
      // shape only exists so the step renders/compiles uniformly.
      return {
        primitive: "sidebar-snapshot",
        label: step.label,
        lang: "javascript",
        // The rendered form only has to compile and read: the real dispatch
        // builds this script with the caller's live area titles (SBRES1).
        script: jxaSidebarSnapshotScript([]),
      };
    case "chord-reorder":
      // Composite step: drive() hands it to the heading-chord driver, which
      // dispatches its own select/chord commands through `run` and asserts the
      // database between them. This shape only exists so the step renders and
      // compiles uniformly; the chord it names is the FIRST hop's, and the
      // driver recomputes every subsequent one from the live order.
      return chordCommand("up-one");
  }
}

/**
 * Recover the message an AppleScript `error "…"` raised from osascript's stderr,
 * dropping the wrapper osascript adds around it (`<line>:<col>: execution error:
 * <message> (-1728)`). Returns null when stderr carries no such message, so a
 * caller can fall back to its own wording. This is what lets a resolver script
 * REFUSE with a sentence the operator can act on — "the Move… picker offers no
 * project named X — it offered […]" — instead of the driver's generic guess.
 */
function scriptErrorText(stderr: string): string | null {
  const raw = stderr.trim();
  if (raw === "") return null;
  const marker = raw.lastIndexOf("execution error:");
  const body = marker >= 0 ? raw.slice(marker + "execution error:".length) : raw;
  const trimmed = body.replace(/\s*\(-?\d+\)\s*$/, "").trim();
  return trimmed === "" ? null : trimmed;
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
    // A resolver that REFUSED (rather than merely failing to find an element)
    // carries the diagnosis — which row it wanted, and what the surface offered
    // instead. Prefer it over the generic guess: that text is the whole point of
    // the picker-row and heading-button resolvers (HXPC1).
    const named = scriptErrorText(frameRes.stderr);
    return {
      ok: false,
      why:
        named !== null
          ? `${named} — no click was sent`
          : "its on-screen position did not resolve — a Things update may have moved the control, " +
            "or the app is not in the expected state; no click was sent",
    };
  }
  const clickRes = await run(uiClickPointCommand(center.x, center.y, step.label), STEP_TIMEOUT_MS);
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
    // one hop, polled in-script (DRVLAT1)
    const res = await run(
      {
        primitive: "wait",
        label: step.assertLabel ?? step.label,
        script: axWaitAnyScript([step.assertPath], step.assertTimeoutMs ?? WAIT_ASSERT_TIMEOUT_MS),
      },
      STEP_TIMEOUT_MS,
    );
    if (!(res.ok && res.stdout.trim() === "true")) {
      return {
        ok: false,
        why: `${step.assertLabel ?? "the expected element"} did not appear after the click`,
        needsAbort: true,
      };
    }
  }
  return { ok: true };
}

/**
 * Execute the PRE-COMMIT FULL-DIALOG AUDIT step (CGRD1): re-read every control the
 * drive set — through each control's own discriminated address — and refuse the
 * commit if any of them does not hold the intended value.
 *
 * Three resolutions happen here rather than in the recipe, because only the driver
 * knows them: WHICH dialog shell is live (attached sheet vs detached editor), which
 * SHAPE the dialog measured (the +1 group-index fork, and which first-occurrence
 * control class exists), and therefore which candidate path each control has. A
 * shell that does not resolve, or a shape-dependent control with no shape probed,
 * fails closed exactly like every other address here — an unaudited commit is not
 * an option, because the audit is the only non-self-referential check the drive has.
 *
 * The System Events sweep and the ObjC date-area sweep are separate commands
 * because the dialog's date/time controls hold NSDates that System Events cannot
 * read; both must pass.
 */
async function driveDialogAudit(
  step: UiStep,
  run: UiRunner,
  dialogShape: RepeatDialogShape | null,
  knownShellIndex: number | null,
): Promise<{ ok: boolean; why?: string; committed?: boolean }> {
  const plan = step.audit;
  if (plan === undefined) return { ok: false, why: "no audit plan compiled (recipe bug)" };
  // Which of the two dialog shells is live. The dialog-open snapshot already
  // answered this when the drive opened the dialog, and the answer cannot have
  // changed underneath (a shell does not become the other kind), so the audit
  // reads it rather than spending a hop re-resolving (RDLAT2 — the open item
  // DRVLAT1 §8 left). Without a snapshot — an unrecognized app build — it falls
  // back to probing, in the SAME priority order the drive's own candidate
  // resolution used, so the audit still reads the dialog the drive wrote.
  let shellIndex =
    knownShellIndex !== null && knownShellIndex < plan.shells.length ? knownShellIndex : -1;
  for (let i = 0; shellIndex < 0 && i < plan.shells.length; i += 1) {
    const res = await run(
      {
        primitive: "resolve",
        label: step.label,
        script: axResolveScript(plan.shells[i] as string),
      },
      STEP_TIMEOUT_MS,
    );
    if (res.ok && res.stdout.trim() === "true") {
      shellIndex = i;
      break;
    }
  }
  if (shellIndex < 0) {
    return {
      ok: false,
      why:
        "the Repeat dialog could not be re-read before committing (neither the attached sheet " +
        "nor the detached repeat editor window resolved), so what it holds could not be checked",
    };
  }
  const shell = plan.shells[shellIndex] as string;
  const group = (plan.groups[shellIndex] ?? plan.groups[0]) as string;

  const scriptControls: AuditScriptControl[] = [];
  const dateAreas: AuditDateArea[] = [];
  for (const raw of plan.controls) {
    if (raw.onlyShape !== undefined || raw.shaped !== undefined) {
      if (dialogShape === null) return { ok: false, why: SHAPE_UNPROBED };
      if (raw.onlyShape !== undefined && raw.onlyShape !== dialogShape) continue;
    }
    const override = raw.shaped === undefined ? undefined : raw.shaped[dialogShape ?? "next-popup"];
    if (raw.shaped !== undefined && override === undefined) {
      return {
        ok: false,
        why: `the audit has no check for "${raw.label}" under the "${dialogShape ?? "unmeasured"}" Repeat dialog (recipe bug)`,
      };
    }
    const control = { ...raw, ...override };
    if (control.kind === "date-area") {
      dateAreas.push({
        label: control.label,
        target: control.dtTarget ?? "next",
        spec: control.dtSpec ?? "",
      });
      continue;
    }
    const candidates = control.pathCandidates;
    scriptControls.push({
      label: control.label,
      kind: control.kind,
      ...(candidates !== undefined && {
        path: (candidates[shellIndex] ?? candidates[0]) as string,
      }),
      ...(control.numberTarget !== undefined && { numberTarget: control.numberTarget }),
      ...(control.rowLabel !== undefined && { rowLabel: control.rowLabel }),
      ...(control.weekdayBase !== undefined && { weekdayBase: control.weekdayBase }),
      expected: control.expected ?? [],
      ...(control.expectedLabel !== undefined && { expectedLabel: control.expectedLabel }),
    });
  }

  // The DATE-AREA leg runs FIRST now (RDLAT2). It is a JXA hop and cannot carry
  // the commit, so it has to finish before the AppleScript leg — which does — or
  // the drive would commit with one control still unaudited. Both legs are
  // read-only, so the order between them is free to choose.
  if (dateAreas.length > 0) {
    const res = await run(
      {
        primitive: "audit-dialog",
        label: step.label,
        lang: "javascript",
        script: axAuditDateAreasScript(dateAreas),
      },
      STEP_TIMEOUT_MS,
    );
    if (!res.ok || res.stdout.trim() !== "OK") {
      return { ok: false, why: auditFailureText(res) };
    }
  }
  if (scriptControls.length > 0) {
    // The COMMIT rides this hop when the recipe supplied one: every control is
    // re-read, and the OK press happens in the same script the moment they all
    // agree. Nothing is dispatched between the audit and the commit, so what
    // lands is what was audited.
    const commit = plan.commits?.[shellIndex] ?? plan.commits?.[0];
    const res = await run(
      {
        primitive: "audit-dialog",
        label: step.label,
        script: axAuditDialogScript({
          shell,
          group,
          controls: scriptControls,
          ...(plan.cadence !== undefined && {
            expectation: cadenceExpectationFor(plan.cadence, installedThingsVersion()),
          }),
          ...(commit !== undefined && { commit }),
        }),
      },
      STEP_TIMEOUT_MS,
    );
    if (!res.ok || res.stdout.trim() !== "OK") {
      return { ok: false, why: auditFailureText(res) };
    }
    if (commit !== undefined) return { ok: true, committed: true };
  }
  return { ok: true };
}

/**
 * The audit's own refusal text, preferred over the driver's generic guess.
 *
 * A folded commit's failure is NOT an audit failure and must not read as one:
 * the audit passed, every control held what the drive entered, and the OK button
 * would not press. Its message is tagged in-script so the two stay distinct.
 */
function auditFailureText(res: UiRunResult): string {
  const named = scriptErrorText(res.stderr);
  if (named !== null && named.startsWith(COMMIT_FAILED_TAG)) {
    return `the Repeat dialog held exactly what this drive entered, but its OK button would not ${""}press (${named.slice(COMMIT_FAILED_TAG.length).trim()}) — nothing was committed`;
  }
  if (named !== null) return `${named} — nothing was committed`;
  if (res.timedOut === true) return "the pre-commit dialog audit timed out; nothing was committed";
  return "the Repeat dialog could not be re-read before committing; nothing was committed";
}

/**
 * Does this recipe ask to be TOLD about anything? Only a recipe with at least
 * one measured observable is worth a sidecar — a menu-only pause/resume drive
 * spawns nothing (VOPAT2).
 */
function recipeWantsObserver(recipe: UiRecipe): boolean {
  return recipe.steps.some((step) => step.settle !== undefined);
}

/**
 * The drive, with the settle sidecar's LIFETIME wrapped around it (VOPAT2).
 *
 * The sidecar is an observing process, and the one thing an observing process
 * must never do is outlive what it was observing. So it is stopped in a
 * `finally` that no return path, refusal, watchdog stop or thrown error can
 * skip — and, because a `finally` is not a guarantee against SIGKILL, the
 * sidecar independently bounds itself with an absolute TTL and a no-request
 * idle timeout. Belt, braces, and a third thing.
 */
async function drive(
  recipe: UiRecipe,
  rawRun: UiRunner,
  aux: UiDriveAux,
  budgetMs: number = DEFAULT_UI_DRIVE_BUDGET_MS,
  reachCache: ReachabilityProbeCache = createReachabilityCache(),
): Promise<ExecuteResult> {
  const observer: { session: ObserverSession | null } = { session: null };
  try {
    return await driveSteps(recipe, rawRun, aux, budgetMs, reachCache, observer);
  } finally {
    if (observer.session !== null) await stopObserver(observer.session);
  }
}

async function driveSteps(
  recipe: UiRecipe,
  rawRun: UiRunner,
  aux: UiDriveAux,
  budgetMs: number,
  reachCache: ReachabilityProbeCache,
  observer: { session: ObserverSession | null },
): Promise<ExecuteResult> {
  /**
   * The settle injector, read FRESH at every use: the sidecar is armed part-way
   * through this function, so a captured value would be the inert one for the
   * whole drive.
   */
  const obs = (): SettleInjector => settleInjectorFor(observer.session);
  // Every step below dispatches through the PER-STEP FOCUS GUARD (issue #620);
  // the latch records the dialog this drive is observed driving, so the cleanup
  // ladder can tell our own half-open dialog from one the user opened after us.
  const latch: SheetLatch = { sheet: null, inspectionStalled: false };
  const run = guardedRun(rawRun, latch);
  // The cleanup ladder audits for itself (it is what decides whether a keystroke
  // may be sent at all), so it runs OUTSIDE the guard — and it is told when the
  // inspection has already stalled, so it never re-runs it (issue #629).
  const clearNow = (): Promise<ClearResult> =>
    clearDialog(rawRun, latch.sheet, latch.inspectionStalled);
  const done: string[] = [];
  /** Durable side effects a SUCCESSFUL drive owes the caller (see ExecuteResult.notices). */
  const notices: string[] = [];
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
    const clear = await clearNow();
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
      steps: [...done],
      // A watchdog stop is a failure exit like any other: whatever the drive
      // changed about the sidebar's disclosure state still has to be said.
      ...(notices.length > 0 && { notices: [...notices] }),
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
  const partial = (
    failed: string,
    why: string,
    clear?: ClearResult,
    /**
     * The failing step's own transport outcome: `true` when its osascript was
     * killed by its deadline rather than answering. Together with a blind cleanup
     * this is what separates "the Things window stopped answering" from "the app
     * answered and refused/did nothing" (#512) — see {@link ExecuteResult.uiUnreachable}.
     */
    stepTimedOut = false,
  ): ExecuteResult => {
    const base = `ui drive stopped at "${failed}" (${why}). Completed: ${done.join(" → ") || "nothing"}.`;
    const cleanup = clear === undefined ? "" : ` ${describeCleanup(clear)}`;
    // Name the deeper record and a spelling that WORKS. #672's field agent was
    // asked for a trace, ran `THINGS_API_TRACE=1`, and got nothing — the parser
    // took only `true` at the time — so the whole diagnostic session came back
    // without the one artifact it existed to produce.
    const deeper = traceActive()
      ? ""
      : " For a step-by-step record of the next attempt, re-run with THINGS_API_TRACE=1 in the" +
        " environment (or `things config set trace true`).";
    // #512: name an environment failure as one. A cleanup that had to run BLIND
    // is direct evidence the session went AX-blind mid-drive; a step killed by
    // its own deadline is the window not answering. Either way the app was not
    // reachable to be driven — which is not the app accepting a command and
    // changing nothing, and must not be reported as that.
    const cause: "unreachable" | "unresponsive" | null =
      clear?.state === "cleared-blind" ? "unreachable" : stepTimedOut ? "unresponsive" : null;
    // The step list rides EVERY partial exit: a failure always carries the
    // play-by-play, which is what made the field bug reports rich (#632). The
    // step that stopped the drive is named as the last entry so the list reads
    // as the whole attempt, not only the part that worked.
    // Notices ride EVERY exit, not only the clean one (SBCOL1). A drive that
    // folded the sidebar and then died is the case where the fold is MOST
    // likely to have outlived it — dropping the notice here would hide the one
    // durable side effect precisely when it matters. The pipeline's
    // transport-recovered path re-shapes such a drive into a SUCCESS, and it
    // reads the notices from this same result.
    const res = {
      ...refusal(base + cleanup + deeper),
      steps: [...done, `${failed} — FAILED: ${why}`],
      ...(notices.length > 0 && { notices: [...notices] }),
    };
    if (cause === null) return res;
    return {
      ...res,
      uiUnreachable: {
        step: failed,
        cause,
        ...(clear !== undefined && { clear: clear.state }),
        remediation:
          cause === "unreachable"
            ? "unlock the Mac, or leave the full-screen app so a Things window is visible on the " +
              "desktop you're viewing, then run the same command again"
            : "bring Things to the front and check that it is responding, then run the same " +
              "command again",
      },
    };
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
    const res = await run(commandForStep(step, recipe.targetUuid, obs()), STEP_TIMEOUT_MS);
    if (!res.ok) {
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
        undefined,
        res.timedOut === true,
      );
    }
    done.push(step.label);
    idx += 1;
  }
  // The menu bar repopulates around the new selection a beat after the preamble
  // (UIC1). That beat is WAITED OUT IN THE CANARY below, which polls each element
  // it must resolve — no fixed settle stands here any more (DRVLAT1, issue #633).

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

  // 0¾. OPEN-DIALOG PRECONDITION (MODALX1 §3/§4, issue #620). A dialog already
  //      standing when a drive starts is not ours and cannot be driven around:
  //      it disables the menu bar (so a menu recipe's canary would miss and
  //      guess at why), and it SWALLOWS the chord recipes' key events, which
  //      pass their canary happily and then move nothing. The census says so
  //      directly, for every recipe, before anything is pressed — and a dialog
  //      standing here also means the app is ignoring scripted changes app-wide
  //      and holding Things Cloud sync, which is the operator's real problem.
  const startState = await readUiState(rawRun, CENSUS_TIMEOUT_MS, "when-not-ours");
  // An inspection that stalls at the very first hop is remembered, so a later
  // failure's cleanup does not go asking it again (issue #629). The preflight
  // itself stays permissive — only a POSITIVE sighting refuses (MODALX1 §7).
  if (censusUnverifiable(startState)) latch.inspectionStalled = true;
  if (startState !== null && startState.inspectable && startState.sheetOpen) {
    return refusal(
      `ui preflight refused: a dialog is already open in Things (${startState.sheetKind}${
        startState.sheetDepth > 1 ? `, on top of ${startState.sheetDepth - 1} more` : ""
      }), most likely left over from an earlier command or opened by hand. While one is open the ` +
        "app disables its menu bar, ignores keyboard input aimed at anything else, and " +
        `${SYNC_GATE_WARNING}. Dismiss it in Things (click Cancel, or press Escape with Things in ` +
        "front), then run the same command again. Nothing was pressed.",
    );
  }

  // 0⅞. ARM THE SETTLE OBSERVER (VOPAT2, #676). Here and nowhere earlier: the
  //      preamble has proved Things is running and reachable, the preflight has
  //      proved no foreign dialog is standing, and nothing has been pressed yet —
  //      so the ledger starts empty and every arrival from this point belongs to
  //      an actuation this drive made (VOPAT1-6: Things is silent when nothing
  //      happens). A recipe with no measured observable spawns nothing.
  //
  //      A NULL SESSION IS NOT A FAILURE. No Command Line Tools, no python3, the
  //      observer switched off, a socket that never answered — each leaves every
  //      generated script byte-identical to the polling one that shipped before
  //      this campaign, with one trace record naming the reason. Only an ARMED
  //      settle that times out fails closed.
  if (recipeWantsObserver(recipe)) {
    observer.session = await startObserver((command, timeoutMs) =>
      rawRun(
        { primitive: "observer-spawn", label: command.label, script: command.script },
        timeoutMs,
      ),
    );
  }

  // 1. Recipe canary: resolve every statically-reachable element (now that the
  //    target is selected). A miss refuses the whole drive before anything is
  //    pressed. (This is also the localization check: English titles must resolve.)
  for (const { path, label } of canaryPaths(recipe)) {
    // the canary resolves elements one at a time; a single miss aborts before anything is pressed, so parallelizing would waste work and blur which element failed
    // POLLED, not snapped: this is where the drive waits out the menu-bar
    // repopulation the preamble triggered (DRVLAT1 — it replaces the fixed settle).
    const res = await run(
      {
        primitive: "resolve",
        label,
        script: axWaitAnyScript([path], MENU_SETTLE_TIMEOUT_MS),
      },
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
  // THE SHAPE MANIFEST'S GATE (RDLAT2). Set by the `dialog-open` step from the
  // shell that actually opened: the 0-based index into every step's candidate
  // list. While it is null every dialog-addressed step probes both shells and the
  // pre-commit audit spends a hop resolving one — the behavior that shipped
  // before this campaign, and the behavior an unrecognized app build keeps.
  let shellIndex: number | null = null;
  /**
   * The settle observer's ledger sequence marked immediately BEFORE the step just
   * dispatched, and before the one before it (VOPAT2). A cross-hop settle awaits
   * since the EARLIER of the two, because the actuation whose announcement it
   * wants for was the previous step's.
   */
  let markBeforeStep: number | null = null;
  let markBeforePrev: number | null = null;
  for (let i = idx; i < recipe.steps.length; i += 1) {
    let step = recipe.steps[i] as UiStep;
    // Shape-gated step: the recipe emits BOTH the legacy and the 3.23 drive for a
    // control whose CLASS changed, and only the matching one runs.
    if (step.onlyShape !== undefined) {
      if (dialogShape === null) {
        const clear = await clearNow();
        return partial(step.label, SHAPE_UNPROBED, clear);
      }
      if (step.onlyShape !== dialogShape) continue;
    }
    // Shape-selected paths/values (the +1 index shift the 3.23 "Next:" pop-up
    // introduced, and the weekday-row base index).
    if (step.shaped !== undefined) {
      if (dialogShape === null) {
        const clear = await clearNow();
        return partial(step.label, SHAPE_UNPROBED, clear);
      }
      const override = step.shaped[dialogShape];
      if (override === undefined) {
        const clear = await clearNow();
        return partial(
          step.label,
          `this step has no drive for the "${dialogShape}" Repeat dialog (recipe bug)`,
          clear,
        );
      }
      step = { ...step, ...override };
    }
    // NARROW to the shell that actually opened (RDLAT2). Applied AFTER the shape
    // merge, so a shape-selected path is narrowed too. Every candidate list in a
    // dialog recipe is `dualForm(inner)` — the same control inside each shell, in
    // one fixed order — so index `shellIndex` names THIS drive's dialog. Nothing
    // is skipped by narrowing: the step still proves its element exists (the
    // candidate prelude polls it), it just stops asking about the shell that is
    // demonstrably not there.
    if (shellIndex !== null && step.pathCandidates !== undefined) {
      const resolved = step.pathCandidates[shellIndex];
      if (resolved !== undefined) step = { ...step, pathCandidates: [resolved] };
    }
    // Overall-drive watchdog: if the budget is spent, stop at THIS step boundary
    // (the per-step execFile timeouts keep the boundary close), clear any open
    // dialog, and return the honest uncertain-outcome timeout (TRACE1 #487).
    if (overBudget()) return watchdogResult(step.label);
    if (step.primitive === "wait") {
      // A candidate-addressed wait polls for ANY of its shapes to appear (the
      // dialog opening as an attached sheet OR a detached AXUnknown window) — the
      // whole poll inside ONE hop (DRVLAT1).
      // steps are strictly sequential: this wait must resolve before the step that acts on the awaited element runs
      const res = await run(commandForStep(step, recipe.targetUuid, obs()), STEP_TIMEOUT_MS);
      const ok = res.ok && res.stdout.trim() === "true";
      if (!ok) {
        // the abort keystroke must land (and be verified) before returning the partial-state report
        const clear = await clearNow();
        return partial(step.label, "the expected element never appeared within the timeout", clear);
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "dialog-open") {
      // WAIT + CENSUS in one hop (RDLAT2). Three outcomes, in fail-closed order:
      // the dialog never appeared (the old wait's failure, word for word); it
      // appeared but its control census is not the Repeat dialog's (a REFUSAL —
      // an app update has redesigned it, and structural indices must not be
      // pressed into an unknown tree); or it matched, and the rest of the drive
      // addresses the shell that opened instead of re-discovering it.
      const res = await run(commandForStep(step, recipe.targetUuid, obs()), STEP_TIMEOUT_MS);
      const snapshot = res.ok ? parseDialogOpenSnapshot(res.stdout) : null;
      if (snapshot === null) {
        const clear = await clearNow();
        return partial(step.label, "the expected element never appeared within the timeout", clear);
      }
      const version = installedThingsVersion();
      const covered = shapeManifestCoversVersion(version);
      const verdict = matchRepeatShell(snapshot.roles);
      trace(() => ({
        phase: "dialog-shape",
        label: step.label,
        shell: snapshot.index,
        roles: snapshot.roles,
        appVersion: version,
        manifestCovers: covered,
        match: verdict.ok,
        ...(verdict.ok ? {} : { mismatch: verdict.why }),
      }));
      if (!verdict.ok) {
        if (covered) {
          // The manifest says what this build's Repeat dialog looks like and this
          // is not it. Fail closed, naming what was seen — the CGRD1 posture:
          // better to refuse on an anodyne change than to mutate a field nobody
          // asked about.
          const clear = await clearNow();
          return partial(
            step.label,
            `the dialog that opened is not the Repeat dialog this version drives — it shows ` +
              `${verdict.why}. A Things update has changed it; nothing was entered into the rule`,
            clear,
          );
        }
        // An app generation the manifest was never measured against gets no
        // assertion and no fast path — it runs the full per-step discrimination,
        // exactly as it did before the manifest existed.
        done.push(step.label);
        continue;
      }
      if (covered) shellIndex = snapshot.index - 1;
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
      // SBCOL1: a move that needed the collapse rung changed the sidebar's
      // disclosure state to get there. That state lives in Things' own
      // preferences and SURVIVES A RELAUNCH, so the caller is told which areas
      // were folded — and, above all, if one is still folded. Recorded BEFORE
      // the failure check: a drive that died part-way is exactly when a fold is
      // most likely to have outlived it, and that is the last moment to go quiet.
      if (outcome.collapsed !== undefined && outcome.collapsed.length > 0) {
        const names = outcome.collapsed.map((t) => `"${t}"`).join(", ");
        notices.push(
          outcome.restoreFailed === undefined
            ? `${names} in the sidebar was collapsed to clear the drag path and expanded again ` +
                "afterwards; the sidebar looks as it did"
            : `${names} in the sidebar was collapsed to clear the drag path, and ` +
                `${outcome.restoreFailed.map((t) => `"${t}"`).join(", ")} could not be expanded ` +
                "again — click the arrow on that row in Things to put it back",
        );
      }
      if (!outcome.ok) return partial(step.label, outcome.detail);
      done.push(`${step.label} (${outcome.detail})`);
      continue;
    }
    if (step.primitive === "chord-reorder") {
      // The heading-chord driver runs its own select → chord → DB-assert loop
      // (ui-chord.ts): every chord is computed from the order it just read, and
      // a chord that moves nothing (or moves the wrong row) stops the drive
      // rather than being re-sent. No sheet is involved, so no dismissal clause.
      if (step.chord === undefined) return partial(step.label, "no chord spec compiled");
      const spec = step.chord;
      // the chord ladder depends on the UI state the reveal produced
      const outcome = await driveHeadingChordReorder(spec, run, aux.headingOrder, (ordinal) =>
        axSelectHeadingRowScript(spec.tablePath, ordinal),
      );
      if (!outcome.ok) return partial(step.label, outcome.detail);
      done.push(`${step.label} (${outcome.detail})`);
      continue;
    }
    // A candidate-addressed step resolves its effective element (the
    // sheet-vs-detached-window disjunction) INSIDE its own script now — see
    // commandForStep / axCandidatePrelude. A miss raises CANDIDATES_MISSED there
    // and lands on this step's ordinary failure path, with the same wording and
    // the same clean abort it had when the resolution was its own hop (DRVLAT1).
    // THE LEDGER MARK, TAKEN BEFORE THE ACTUATION (VOPAT2). A settle whose
    // observable belongs to an EARLIER step — the `Next:` pop-up's recompute is
    // announced ~0.4 s after the anchor selection, long before the hop that waits
    // for it exists — can only be satisfied if something was already listening at
    // the moment the actuation happened. So every step's dispatch is bracketed by
    // a mark, and the previous step's mark is kept: a cross-hop settle awaits
    // since THAT, and an arrival that has already landed satisfies it out of the
    // ledger instantly. One sub-millisecond socket round-trip per step.
    if (observer.session !== null) {
      markBeforePrev = markBeforeStep;
      markBeforeStep = await observerMark(observer.session);
    }
    if (step.primitive === "settle-occurrences" && observer.session !== null) {
      // The whole hop IS the wait, so with a sidecar live it dispatches NOTHING:
      // no osascript, no content read. See SETTLE_OCCURRENCE_RECOMPUTE.
      const since = markBeforePrev ?? markBeforeStep ?? 0;
      // AND IT IS SKIPPED WHEN THE PREVIOUS STEP ACTUATED NOTHING. Things says
      // nothing when nothing happens (VOPAT1-6), so zero arrivals since the mark
      // taken before that step means it changed no state — a weekday set that
      // already matched, an anchor already on the requested day — and a rule that
      // did not change has no recompute to absorb. MEASURED: the field's own
      // command shape reaches here with `seen=0` (the scheduled date's weekday is
      // already the weekly default), and the polling form spent its whole 1.66 s
      // hop discovering that by re-reading the control twelve times.
      const seen = await observerCount(observer.session, since);
      if (seen === 0) {
        trace(() => ({
          phase: "ui-settle",
          what: SETTLE_OCCURRENCE_RECOMPUTE.what,
          ok: true,
          skipped: "nothing-announced",
          since,
        }));
      } else {
        await observerAwait(observer.session, since, SETTLE_OCCURRENCE_RECOMPUTE);
      }
      done.push(step.label);
      continue;
    }
    const command = commandForStep(step, recipe.targetUuid, obs());
    if (step.primitive === "probe-dialog-shape") {
      // MEASURE the dialog (RDLG2) before any shape-dependent control is touched.
      // A shape we do not recognize refuses the drive with the dialog cleared —
      // the same fail-closed posture as a canary miss, and for the same reason:
      // pressing a structural index into an unknown tree is how a GUI driver
      // writes the wrong rule.
      const res = await run(command, STEP_TIMEOUT_MS);
      const verdict = res.stdout.trim();
      if (!res.ok || (verdict !== "next-popup" && verdict !== "legacy")) {
        const clear = await clearNow();
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
          res.timedOut === true,
        );
      }
      dialogShape = verdict;
      // THE VERDICT, IN THE TRACE (RDLAT2's census law: a change to what the
      // driver READS is certified by reading it back). VOPAT2 rewrote this probe
      // from 15 singular Apple events into three plural ones, so what it decides
      // has to be visible per drive rather than only in the step trail.
      trace(() => ({
        phase: "dialog-shape",
        event: "probe",
        label: step.label,
        shape: verdict,
        ...(res.axOps !== undefined && { axOps: res.axOps }),
        ...(res.axElems !== undefined && { axElems: res.axElems }),
      }));
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
        const clear = await clearNow();
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
          res.timedOut === true,
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
        const clear = await clearNow();
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
          res.timedOut === true,
        );
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "audit-dialog") {
      // The last thing before the commit: re-read EVERY control this drive set,
      // through each control's own discriminated address, and abort fail-closed if
      // any of them disagrees with what was requested (CGRD1). Every per-step
      // read-back before this point is self-referential — it re-reads the element it
      // addressed — so a wrong ADDRESS is invisible until here. A mismatch clears
      // the dialog through the standard clean-abort path, so nothing is committed.
      const outcome = await driveDialogAudit(step, run, dialogShape, shellIndex);
      if (!outcome.ok) {
        const clear = await clearNow();
        return partial(step.label, outcome.why ?? "the pre-commit dialog audit failed", clear);
      }
      done.push(step.label);
      // The audit COMMITTED in its own script (RDLAT2). The recipe's commit step
      // is still a step of the drive and still appears in the trail — it just did
      // not need a process of its own, and nothing was dispatched between the
      // read and the press.
      if (outcome.committed === true) {
        const commitStep = recipe.steps[i + 1];
        if (commitStep !== undefined && commitStep.primitive === "press") {
          done.push(commitStep.label);
          i += 1;
        }
      }
      continue;
    }
    if (step.primitive === "click-element" || step.primitive === "click-picker-row") {
      // A mouse click at an AX-resolved frame center (the NATIVE1 primitive),
      // used only where AXPress is inert (Things' custom `…`/repeat-bar popover)
      // — and, for `click-picker-row`, where committing by keyboard would take
      // whatever the app highlighted, including the row that CREATES a project.
      // the click depends on the UI state the previous step produced
      const outcome = await driveClickElement(step, run);
      if (!outcome.ok) {
        // clear whatever the click opened (honest cleanup) before reporting
        const clear = outcome.needsAbort === true ? await clearNow() : undefined;
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
        step.primitive !== "reveal" && step.primitive !== "activate" ? await clearNow() : undefined;
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
        clear,
        res.timedOut === true,
      );
    }
    // A typing primitive that found the field ALREADY holding the requested
    // value typed nothing at all (issue #620 item 7) — disclosed, so the trail
    // says what the drive did rather than what it intended.
    done.push(res.stdout.trim() === OK_ALREADY ? `${step.label} (already set)` : step.label);
  }
  return {
    exitCode: 0,
    stdout: `${relocationNote}drove ${done.length} step(s): ${done.join(" → ")}`,
    stderr: "",
    // The same play-by-play as a LIST (#632). `stdout` keeps the prose form the
    // trace and the transport-failure paths already read; `steps` is what the
    // change-history record stores and `--verbose` renders.
    steps: relocationNote === "" ? [...done] : [relocationNote.trim(), ...done],
    ...(notices.length > 0 && { notices: [...notices] }),
  };
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
        "set ui-enabled true`, then run `things helpers setup --gui`, which grants GUI-driving " +
        "to the helper pair (the only identity it is granted to). It drives the local Things " +
        "GUI and is intended for a dedicated always-on Mac.",
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
    // Article IV: the pipeline's GUI gate keys on this declaration, never on
    // the id — see WriteVector.drivesGui.
    drivesGui: true,
    matrix: enabled ? enabledMatrix() : disabledMatrix(),
    async execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      if (!enabled) {
        return refusal(
          "the ui vector is disabled (`things config set ui-enabled true` to enable it, then " +
            "`things helpers setup --gui`).",
        );
      }
      if (invocation.recipe === undefined) {
        return refusal("ui invocation carried no recipe (compile bug).");
      }
      return drive(invocation.recipe, tracedRun, aux, budgetMs, reachCache);
    },
    // Pre-seed dialog seam for the promote orchestrators (MODALX1, #620): a
    // composite's FIRST leg mints a row through the URL scheme, which sails
    // straight past an open dialog — and every AppleScript leg after it then
    // fails, leaving a copy behind. The orchestrator asks this BEFORE it seeds.
    probeUiState: () => readUiState(tracedRun, CENSUS_TIMEOUT_MS, "when-not-ours"),
    // Pre-seed gate seam for the promote orchestrators (SESSGATE, #480): probe the
    // live session BEFORE they seed a row, so a locked/full-screen session refuses
    // with zero mutation. Present regardless of `enabled` (the orchestrator has
    // already cleared the H-UI-DRIVE ack by the time it consults this). Populates
    // the memo the in-drive gate reuses (PERF1).
    probeReachability: () => reachCache.probe(tracedRun, STEP_TIMEOUT_MS),
  };
}
