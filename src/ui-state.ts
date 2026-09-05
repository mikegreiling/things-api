/**
 * The window-state diagnostic (issue #620): a read-only answer to "what is on
 * the screen right now?", for the two questions a GUI drive and a sync problem
 * both end up asking — is a dialog open in Things, and who owns the keyboard?
 *
 * ITS CLI HOME IS `things doctor --ui-state`. The stand-alone `ui-state`
 * command is gone: `things rescue status` (src/rescue.ts) answers the same
 * questions and adds the change lock and the acting verbs beside them.
 *
 * It reads and reports; it never clicks, types, activates, or dismisses
 * anything. The census itself lives with the ui vector
 * (src/write/vectors/ui-state.ts) because the drive's per-step guard and its
 * cleanup ladder use the same one shape; this module is the surface accessor —
 * the capability gate plus the reporting shape the CLI renders.
 *
 * PERMISSIONS DOCTRINE. Reading another app's Accessibility tree is a granted
 * capability, so the gate comes FIRST and prompt-free: a machine that has not
 * granted it is told so, with the remediation, and nothing is attempted. No
 * surface may raise a consent dialog outside the two setup ceremonies.
 */
import { uiAllowed, uiCapability as uiCapabilityDefault, type UiCapability } from "./capability.ts";
import {
  describeUiState,
  describeUnprovenProbes,
  SYNC_GATE_WARNING,
  type UiProbe,
  type UiState,
} from "./write/vectors/ui-state.ts";
import {
  describeSessionLock,
  type SessionLockVerdict,
  UNKNOWN_SESSION_LOCK,
} from "./write/vectors/session-lock.ts";
import { readLiveSessionLock, readLiveUiState } from "./write/vectors/ui.ts";

export type {
  UiFocusOwner,
  UiProbe,
  UiSheetForm,
  UiSheetKind,
  UiState,
} from "./write/vectors/ui-state.ts";

export interface UiStateReport {
  /**
   * Is this Mac's screen locked? (LOCKSCR1, #732.) Read FIRST and reported
   * always — it needs no grant, and it is the fact that says whether an empty
   * census below means "Things has no window" or "nothing on this screen is
   * readable by anyone".
   */
  session: SessionLockVerdict;
  /** Could the screen be read at all on this machine? */
  available: boolean;
  /** One sentence: the summary when available, the reason when not. */
  detail: string;
  /** What to do about it; empty when there is nothing to fix. */
  remediation: string[];
  /** The census; null when unavailable, or when the read itself did not answer. */
  state: UiState | null;
  /** Consequences worth stating — currently the open-dialog sync gate. */
  warnings: string[];
}

export interface UiStateDeps {
  /** Test seam: the prompt-free capability verdict. */
  capability?: () => UiCapability;
  /** Test seam: the live census read. */
  read?: () => Promise<UiState | null>;
  /** Test seam: the prompt-free session-lock read. */
  session?: () => Promise<SessionLockVerdict>;
}

/**
 * Read the current window/focus state, gated on the prompt-free capability
 * verdict. Never throws: an unreadable screen is a REPORTED state, because the
 * cases this diagnostic exists for are exactly the ones where something is
 * wrong with the screen.
 */
export async function readUiStateReport(deps: UiStateDeps = {}): Promise<UiStateReport> {
  // LOCKSCR1: read AHEAD of the capability gate on purpose. The session read is
  // prompt-free and needs no grant, so a machine that has granted nothing is
  // still told that its screen is locked (which is why its census is empty).
  const session = await (deps.session ?? readLiveSessionLock)().catch(() => UNKNOWN_SESSION_LOCK);
  const capability = (deps.capability ?? (() => uiCapabilityDefault()))();
  if (!uiAllowed(capability)) {
    return {
      session,
      available: false,
      detail: `the Things window cannot be read on this machine — ${capability.detail}`,
      remediation: capability.remediation,
      state: null,
      warnings: [],
    };
  }
  const state = await (deps.read ?? readLiveUiState)();
  if (state === null) {
    return {
      session,
      available: true,
      detail:
        "the window and focus state could not be read — Things may have stopped answering, or a " +
        "system dialog is covering the screen",
      remediation: ["check that Things is running and responding, then run this again"],
      state: null,
      warnings: [],
    };
  }
  const unproven = state.stalledProbes.length > 0 || state.failedProbes.length > 0;
  if (!state.thingsRunning && !unproven) {
    return {
      session,
      available: true,
      detail: "Things is not running, so it has no window and no dialog open",
      remediation: [],
      state,
      warnings: [],
    };
  }
  return {
    session,
    available: true,
    detail: describeUiState(state),
    // #629: a probe that did not answer is REPORTED, with what to do about it —
    // never swallowed into a confident-looking summary, and never collapsed
    // into a bare "nothing could be read". Everything the other probes DID
    // prove is in `state` and in the summary above.
    remediation: unproven
      ? [
          "one or more of the screen reads did not answer; check that Things is responding, then " +
            "run this again",
        ]
      : [],
    state,
    warnings: state.sheetOpen ? [SYNC_GATE_WARNING] : [],
  };
}

/** Render the per-probe verdicts, or "" when every probe answered. */
function probeLine(state: UiState): string[] {
  const unprovenText = describeUnprovenProbes(state);
  return unprovenText === "" ? [] : [`unproven:   ${unprovenText}`];
}

/** The human render of the window-state section, for `things doctor --ui-state`. */
export function uiStateLines(report: UiStateReport): string[] {
  const lines = [
    "── Window state ──",
    // LOCKSCR1 (#732): FIRST row, because it is the row that says how to read
    // every row under it. A locked Mac shows an empty window inventory, and this
    // section used to render that emptiness as if it were a fact about Things.
    `session:     ${describeSessionLock(report.session)}`,
    `summary:     ${report.detail}`,
  ];
  const state = report.state;
  if (state !== null) {
    // #629: a row whose probe did not answer says so. Printing the field's
    // unset default ("none", "unknown") next to rows that WERE measured is what
    // made a stalled inspection read as a clean screen.
    const unproven = (p: UiProbe): boolean =>
      state.stalledProbes.includes(p) || state.failedProbes.includes(p);
    lines.push(
      `frontmost:   ${
        unproven("frontmost")
          ? "not established"
          : `${state.frontmostApp ?? (unproven("frontapp") ? "not established" : "unknown")}${
              state.thingsFrontmost ? " (Things)" : ""
            }`
      }`,
      `dialog:      ${
        unproven("dialog")
          ? "not established"
          : `${state.sheetKind}${
              state.sheetKind === "none"
                ? ""
                : ` (${state.sheetForm}; ${state.sheetControls ?? "no census"})`
            }`
      }`,
      `focus:       ${
        unproven("focus")
          ? "not established"
          : state.focusOwner === null
            ? "unknown"
            : `${state.focusOwner.app} · ${state.focusOwner.role || "no focused element"}${
                state.focusOwner.subrole === null ? "" : ` / ${state.focusOwner.subrole}`
              }`
      }`,
      `inspectable: ${state.inspectable ? "yes" : "no — a system dialog macOS does not expose"}`,
      ...probeLine(state),
    );
  }
  for (const warning of report.warnings) lines.push(`  warning:   ${warning}`);
  for (const step of report.remediation) lines.push(`  next:      ${step}`);
  return lines;
}
