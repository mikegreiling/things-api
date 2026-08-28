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
  /** What is open RIGHT NOW. Drives start with nothing open (the precondition). */
  kind: UiSheetKind;
  /**
   * What a MENU-BAR press raises — the app opening the recipe's dialog. `none`
   * models a recipe whose menu press opens nothing (a plain menu action).
   */
  opens: UiSheetKind;
  /** How many dialogs are stacked (the census's `depth`). */
  depth: number;
  form: UiSheetForm;
  census: string;
  role: string;
  subrole: string;
  /** False models a secure system modal macOS will not expose. */
  inspectable: boolean;
  /** When false, no dismissal command clears the dialog (the stranded case). */
  dismissable: boolean;
  /**
   * Probes that did not answer within their budget (issue #629). A CRITICAL one
   * here (`running` / `frontmost` / `dialog`) makes the census unverifiable, so
   * the guard refuses and the cleanup skips straight to the semantic Cancel.
   */
  stalled: string[];
  /** Probes that errored rather than timing out (the secure-modal signature). */
  failed: string[];
}

/**
 * Things frontmost, NOTHING open, everything readable — the state a drive is
 * allowed to start from (issue #620's open-dialog precondition). Pressing a
 * menu-bar item raises `opens`, the way the app does.
 */
export function healthyScreen(overrides: Partial<FakeScreen> = {}): FakeScreen {
  return {
    front: "Things3",
    thingsRunning: true,
    kind: "none",
    opens: "repeat",
    depth: 0,
    form: "attached",
    census: "cb:2 pu:1 bt:2 gp:1 tf:0",
    role: "AXTextField",
    subrole: "",
    inspectable: true,
    dismissable: true,
    stalled: [],
    failed: [],
    ...overrides,
  };
}

/**
 * Render the census record the way the real script does — INCLUDING its
 * short-circuit: a decision-critical probe that does not answer stops the
 * census there, so every probe after it reports its unset default. That is the
 * property #629 turns on (a stalled census must never render as a clean
 * screen), so the fake has to have it too.
 */
export function censusStdout(s: FakeScreen): string {
  const ORDER = ["running", "frontmost", "dialog", "frontapp", "focus"];
  const CRITICAL = new Set(["running", "frontmost", "dialog"]);
  const halt = [...s.stalled, ...s.failed].find((p) => CRITICAL.has(p));
  const ran = (probe: string): boolean =>
    halt === undefined || ORDER.indexOf(probe) < ORDER.indexOf(halt);
  const open = s.kind !== "none" && ran("dialog");
  // The addressed frontmost probe NAMES Things itself; the enumeration runs
  // only to name somebody else.
  const frontName = !ran("frontmost")
    ? ""
    : s.front === "Things3"
      ? "Things3"
      : ran("frontapp")
        ? s.front
        : "";
  return [
    `front=${frontName}`,
    `isfront=${ran("frontmost") && s.front === "Things3"}`,
    `running=${ran("running") && s.thingsRunning}`,
    `form=${open ? s.form : "none"}`,
    `depth=${open ? Math.max(1, s.depth) : 0}`,
    `kind=${open ? s.kind : "none"}`,
    `census=${open ? s.census : ""}`,
    `role=${ran("focus") ? s.role : ""}`,
    `subrole=${ran("focus") ? s.subrole : ""}`,
    `inspectable=${s.inspectable}`,
    `stalled=${s.stalled.join(" ")}`,
    `failed=${s.failed.join(" ")}`,
  ].join("\n");
}

export function isCensusCommand(c: UiCommand): boolean {
  return (c.script ?? "").includes(UI_STATE_MARKER);
}

/**
 * The ADDRESSED "is a dialog open?" read (issue #629) — the narrow question the
 * cleanup proves itself with when the full census will not answer. Deliberately
 * NOT handled by {@link screenAnswer}: tests that model a leftover sheet the
 * census cannot see have to answer it themselves, which is the whole point of
 * having a second, independent oracle.
 */
export function isSheetOpenProbe(c: UiCommand): boolean {
  return (c.script ?? "").includes("set sheetOpen to false");
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
  // A menu-bar press is how a recipe raises its dialog; the test's own answer
  // still decides whether the press "succeeded".
  if (c.primitive === "press" && script.includes("of menu bar 1") && screen.kind === "none") {
    screen.kind = screen.opens;
    if (screen.opens !== "none") screen.depth = Math.max(1, screen.depth);
    return null;
  }
  const close = (): void => {
    if (!screen.dismissable) return;
    screen.depth = Math.max(0, screen.depth - 1);
    if (screen.depth === 0) screen.kind = "none";
  };
  // The Cancel button's frame, for the pointer fallback.
  if (script.includes("position of _b")) {
    if (screen.kind === "none") return { ok: false, stdout: "", stderr: "no dialog is open" };
    return { ok: true, stdout: "300 400 80 24", stderr: "" };
  }
  if (c.primitive === "click-point" && c.label.includes("Cancel")) {
    close();
    return { ok: true, stdout: "", stderr: "" };
  }
  if (script.includes('button "Cancel"')) {
    if (screen.kind === "none") return { ok: true, stdout: "NO-DIALOG", stderr: "" };
    close();
    return { ok: true, stdout: "OK", stderr: "" };
  }
  if (script.includes("key code 53")) {
    close();
    return { ok: true, stdout: "", stderr: "" };
  }
  if (script.includes("reopen")) {
    // The window goes, and the whole stack with it.
    if (screen.dismissable) {
      screen.kind = "none";
      screen.depth = 0;
    }
    return { ok: true, stdout: "OK", stderr: "" };
  }
  if (script.includes('tell application "Things3" to activate')) {
    screen.front = "Things3";
    return { ok: true, stdout: "", stderr: "" };
  }
  return null;
}
