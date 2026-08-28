/**
 * The `ui-state` diagnostic (issue #620): a read-only answer to "what is on the
 * screen right now?", for the two questions a GUI drive and a sync problem both
 * end up asking — is a dialog open in Things, and who owns the keyboard?
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
import { readLiveUiState } from "./write/vectors/ui.ts";

export type {
  UiFocusOwner,
  UiProbe,
  UiSheetForm,
  UiSheetKind,
  UiState,
} from "./write/vectors/ui-state.ts";

export interface UiStateReport {
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
}

/**
 * Read the current window/focus state, gated on the prompt-free capability
 * verdict. Never throws: an unreadable screen is a REPORTED state, because the
 * cases this diagnostic exists for are exactly the ones where something is
 * wrong with the screen.
 */
export async function readUiStateReport(deps: UiStateDeps = {}): Promise<UiStateReport> {
  const capability = (deps.capability ?? (() => uiCapabilityDefault()))();
  if (!uiAllowed(capability)) {
    return {
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
      available: true,
      detail: "Things is not running, so it has no window and no dialog open",
      remediation: [],
      state,
      warnings: [],
    };
  }
  return {
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

/** The human render, shared by `things ui-state` and `things doctor --ui-state`. */
export function uiStateLines(report: UiStateReport): string[] {
  const lines = ["── Window state ──", `summary:     ${report.detail}`];
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
