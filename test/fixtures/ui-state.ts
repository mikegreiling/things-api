/**
 * A fake screen for the ui-driver tests (issue #620).
 *
 * Every keystroke-class and pointer-class hop is now preceded by the read-only
 * window/focus census, and the audited cleanup ladder reads it too — so a mock
 * runner that answers nothing sensible makes the guard refuse, which is
 * correct behavior and useless as a fixture. This models the screen instead: a
 * mutable state the census reports, which the dismissal commands change the way
 * the real app would.
 */
import {
  UI_STATE_MARKER,
  type UiSheetForm,
  type UiSheetKind,
} from "../../src/write/vectors/ui-state.ts";
import type { UiCommand, UiRunResult } from "../../src/write/vectors/ui.ts";

export interface FakeScreen {
  /** The frontmost application's process name. */
  front: string;
  thingsRunning: boolean;
  kind: UiSheetKind;
  form: UiSheetForm;
  census: string;
  role: string;
  subrole: string;
  /** False models a secure system modal macOS will not expose. */
  inspectable: boolean;
  /** When false, no dismissal command clears the dialog (the stranded case). */
  dismissable: boolean;
}

/** Things frontmost, its Repeat dialog open, everything readable. */
export function healthyScreen(overrides: Partial<FakeScreen> = {}): FakeScreen {
  return {
    front: "Things3",
    thingsRunning: true,
    kind: "repeat",
    form: "attached",
    census: "cb:2 pu:1 bt:2 gp:1 tf:0",
    role: "AXTextField",
    subrole: "",
    inspectable: true,
    dismissable: true,
    ...overrides,
  };
}

export function censusStdout(s: FakeScreen): string {
  return [
    `front=${s.front}`,
    `running=${s.thingsRunning}`,
    `form=${s.kind === "none" ? "none" : s.form}`,
    `kind=${s.kind}`,
    `census=${s.kind === "none" ? "" : s.census}`,
    `role=${s.role}`,
    `subrole=${s.subrole}`,
    `inspectable=${s.inspectable}`,
  ].join("\n");
}

export function isCensusCommand(c: UiCommand): boolean {
  return (c.script ?? "").includes(UI_STATE_MARKER);
}

/**
 * Answer the commands that READ or CHANGE the screen, and nothing else:
 * returns null for every command the test's own `answer` should handle.
 *
 * The dismissal rungs behave as the app does — Cancel, Escape and the window
 * close+reopen each close a dismissable dialog and are inert on a stranded one
 * — so a test only has to say what kind of screen it is modelling.
 */
export function screenAnswer(screen: FakeScreen, c: UiCommand): UiRunResult | null {
  const script = c.script ?? "";
  if (isCensusCommand(c)) {
    return { ok: true, stdout: censusStdout(screen), stderr: "" };
  }
  if (script.includes('button "Cancel"')) {
    if (screen.kind === "none") return { ok: true, stdout: "NO-DIALOG", stderr: "" };
    if (screen.dismissable) screen.kind = "none";
    return { ok: true, stdout: "OK", stderr: "" };
  }
  if (script.includes("key code 53")) {
    if (screen.dismissable) screen.kind = "none";
    return { ok: true, stdout: "", stderr: "" };
  }
  if (script.includes("reopen")) {
    if (screen.dismissable) screen.kind = "none";
    return { ok: true, stdout: "OK", stderr: "" };
  }
  if (script.includes('tell application "Things3" to activate')) {
    screen.front = "Things3";
    return { ok: true, stdout: "", stderr: "" };
  }
  return null;
}
