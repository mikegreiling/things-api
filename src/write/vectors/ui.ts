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

import type { ThingsApiConfig } from "../../config.ts";
import { UI_DRIVE_OPS } from "../operations.ts";
import { escapeAppleScript } from "./applescript.ts";
import { certificationOf } from "./ui-certification.ts";
import type {
  CompiledInvocation,
  ExecuteResult,
  UiPrimitive,
  UiRecipe,
  UiStep,
  VectorMatrix,
  WriteVector,
} from "./types.ts";

/** GUI driving can stall on an unanswered sheet; give each step headroom. */
const STEP_TIMEOUT_MS = 15_000;
/** Poll interval while waiting for a dynamic element (sheet/popover). */
const WAIT_POLL_MS = 300;
/**
 * Settle after the reveal/activate preamble so the menu bar repopulates for the
 * newly-selected target before the canary reads it (UIC1: the Items ▸ Repeat
 * submenu appears only once a repeating item is selected, and the update is not
 * instantaneous).
 */
const SETTLE_AFTER_REVEAL_MS = 1500;

/**
 * Command-level primitives. Extends the recipe `UiPrimitive` set with the two
 * INTERNAL sub-steps a `click-element` recipe step decomposes into: read the
 * target's on-screen frame from the live AX tree (`resolve-frame`), then post a
 * synthetic HID click at its center (`click-point`). Splitting them keeps each
 * subprocess call behind the injectable `run` seam (unit-testable without a GUI).
 */
export type UiCommandPrimitive = UiPrimitive | "resolve-frame" | "click-point";

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
}

export interface UiRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * Low-level dispatch seam. Injectable so the driver's recipe orchestration,
 * canary, and abort logic are unit-testable WITHOUT ever touching a real GUI
 * (CLAUDE.md safety rails — the production app is never a valid target).
 */
export type UiRunner = (command: UiCommand, timeoutMs: number) => Promise<UiRunResult>;

const SE = `tell application "System Events" to tell process "Things3"`;

/** resolve-element: does the element exist right now? Returns "true"/"false". */
export function axResolveScript(path: string): string {
  return `${SE} to return (exists (${path}))`;
}
/** press: AXPress the element. */
export function axPressScript(path: string): string {
  return `${SE} to click (${path})`;
}
/** set-field-value: type a value into a text/pop-up field. */
export function axSetValueScript(path: string, value: string): string {
  return `${SE} to set value of (${path}) to "${escapeAppleScript(value)}"`;
}
/**
 * select-popup: choose an item in a pop-up button by NAME. Setting `value` on a
 * Things pop-up button is a silent no-op (UIC1 / UI2-i) — the control must be
 * opened and the menu item clicked, with a settle between so the menu renders
 * before the click lands (a press before render falls through to the control
 * beneath). One stable command shape per primitive.
 */
export function axSelectPopupScript(path: string, value: string): string {
  return `${SE}
  set pu to (${path})
  click pu
  delay 0.6
  click menu item "${escapeAppleScript(value)}" of menu 1 of pu
end tell`;
}
/** activate: foreground Things (the fallback preamble step). */
export function axActivateScript(): string {
  return `tell application "Things3" to activate`;
}
/** key: a space-separated keystroke spec (e.g. "down down return"). */
export function axKeyScript(keys: string): string {
  const KEY_CODES: Record<string, number> = { return: 36, escape: 53, down: 125, up: 126, tab: 48 };
  const lines = keys
    .split(/\s+/)
    .filter((k) => k !== "")
    .map((k) =>
      KEY_CODES[k] !== undefined
        ? `key code ${KEY_CODES[k]}`
        : `keystroke "${escapeAppleScript(k)}"`,
    );
  return `tell application "System Events" to tell process "Things3"\n  ${lines.join("\n  ")}\nend tell`;
}
/** The abort keystroke sent to dismiss a half-open sheet/popover on failure. */
export function axAbortScript(): string {
  return `tell application "System Events" to key code 53`; // Escape
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
function clickPointCommand(x: number, y: number, label: string): UiCommand {
  return { primitive: "click-point", label, lang: "javascript", script: jxaClickScript(x, y) };
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

function defaultRun(command: UiCommand, timeoutMs: number): Promise<UiRunResult> {
  return new Promise((resolve) => {
    let bin: string;
    let args: string[];
    if (command.primitive === "reveal") {
      [bin, args] = ["open", [command.url ?? ""]];
    } else if (command.lang === "javascript") {
      // JXA (ObjC bridge) for the mouse-synthesis primitive; one stable shape.
      [bin, args] = ["osascript", ["-l", "JavaScript", "-e", command.script ?? ""]];
    } else {
      [bin, args] = ["osascript", ["-e", command.script ?? ""]];
    }
    execFile(bin, [...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
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

/** The element paths the preflight canary resolves (static steps only). */
function canaryPaths(recipe: UiRecipe): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  for (const step of recipe.steps) {
    if (step.dynamic === true) continue;
    if (
      step.primitive !== "press" &&
      step.primitive !== "set-value" &&
      step.primitive !== "resolve" &&
      step.primitive !== "click-element"
    ) {
      continue;
    }
    const path = step.canaryPath ?? step.path;
    if (path !== undefined) out.push({ path, label: step.label });
  }
  return out;
}

function refusal(detail: string): ExecuteResult {
  return { exitCode: 1, stdout: "", stderr: detail };
}

/** Compile one recipe step into its primitive command (no dispatch). */
export function commandForStep(step: UiStep, targetUuid: string): UiCommand {
  switch (step.primitive) {
    case "reveal":
      return { primitive: "reveal", label: step.label, url: revealUrl(step.value ?? targetUuid) };
    case "activate":
      return { primitive: "activate", label: step.label, script: axActivateScript() };
    case "press":
      return { primitive: "press", label: step.label, script: axPressScript(step.path ?? "") };
    case "resolve":
      return { primitive: "resolve", label: step.label, script: axResolveScript(step.path ?? "") };
    case "set-value":
      return {
        primitive: "set-value",
        label: step.label,
        script: axSetValueScript(step.path ?? "", step.value ?? ""),
      };
    case "select-popup":
      return {
        primitive: "select-popup",
        label: step.label,
        script: axSelectPopupScript(step.path ?? "", step.value ?? ""),
      };
    case "wait":
      return { primitive: "wait", label: step.label, script: axResolveScript(step.path ?? "") };
    case "key":
      return { primitive: "key", label: step.label, script: axKeyScript(step.keys ?? "") };
    case "click-element":
      // Phase 1 of the click: read the target's frame. driveClickElement runs
      // this, then posts the click at the resolved center and asserts the outcome.
      return {
        primitive: "resolve-frame",
        label: step.label,
        lang: "applescript",
        script: axFrameScript(step.path ?? ""),
      };
  }
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
    return {
      ok: false,
      why:
        "its on-screen position did not resolve — a Things update may have moved the control, " +
        "or the app is not in the expected state; no click was sent",
    };
  }
  const clickRes = await run(clickPointCommand(center.x, center.y, step.label), STEP_TIMEOUT_MS);
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
    const ok = await waitForElement(
      {
        primitive: "wait",
        label: step.assertLabel ?? step.label,
        script: axResolveScript(step.assertPath),
      },
      step.assertTimeoutMs ?? STEP_TIMEOUT_MS,
      run,
    );
    if (!ok) {
      return {
        ok: false,
        why: `${step.assertLabel ?? "the expected element"} did not appear after the click`,
        needsAbort: true,
      };
    }
  }
  return { ok: true };
}

async function drive(recipe: UiRecipe, run: UiRunner): Promise<ExecuteResult> {
  const done: string[] = [];
  const abort = (): Promise<UiRunResult> =>
    run({ primitive: "key", label: "abort (Escape)", script: axAbortScript() }, STEP_TIMEOUT_MS);
  const partial = (failed: string, why: string): ExecuteResult =>
    refusal(
      `ui drive stopped at "${failed}" (${why}). Completed: ${done.join(" → ") || "nothing"}. ` +
        "The open sheet/popover was dismissed (Escape).",
    );

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
    // oxlint-disable-next-line no-await-in-loop -- the preamble steps are strictly sequential (select, then foreground) and each must land before the next
    const res = await run(commandForStep(step, recipe.targetUuid), STEP_TIMEOUT_MS);
    if (!res.ok) {
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
      );
    }
    done.push(step.label);
    idx += 1;
  }
  // Let the selection settle so the menu bar repopulates before the canary reads it.
  if (idx > 0) await new Promise((r) => setTimeout(r, SETTLE_AFTER_REVEAL_MS));

  // 1. Recipe canary: resolve every statically-reachable element (now that the
  //    target is selected). A miss refuses the whole drive before anything is
  //    pressed. (This is also the localization check: English titles must resolve.)
  for (const { path, label } of canaryPaths(recipe)) {
    // oxlint-disable-next-line no-await-in-loop -- the canary resolves elements one at a time; a single miss aborts before anything is pressed, so parallelizing would waste work and blur which element failed
    const res = await run(
      { primitive: "resolve", label, script: axResolveScript(path) },
      STEP_TIMEOUT_MS,
    );
    if (!res.ok || res.stdout.trim() !== "true") {
      return refusal(
        `ui preflight refused: element for "${label}" did not resolve (${path}) — a Things ` +
          "update may have changed the menu, Accessibility may not be granted, Things may not " +
          "be running, or the app may not be in English. Nothing was pressed.",
      );
    }
  }

  // 2. Execute the remaining steps in order; a dynamic element is waited-for.
  for (let i = idx; i < recipe.steps.length; i += 1) {
    const step = recipe.steps[i] as UiStep;
    const command = commandForStep(step, recipe.targetUuid);
    if (step.primitive === "wait") {
      // oxlint-disable-next-line no-await-in-loop -- steps are strictly sequential: this wait must resolve before the step that acts on the awaited element runs
      const ok = await waitForElement(command, step.timeoutMs ?? STEP_TIMEOUT_MS, run);
      if (!ok) {
        // oxlint-disable-next-line no-await-in-loop -- the abort keystroke must land before returning the partial-state report
        await abort();
        return partial(step.label, "the expected element never appeared within the timeout");
      }
      done.push(step.label);
      continue;
    }
    if (step.primitive === "click-element") {
      // A mouse click at an AX-resolved frame center (the NATIVE1 primitive),
      // used only where AXPress is inert (Things' custom `…`/repeat-bar popover).
      // oxlint-disable-next-line no-await-in-loop -- the click depends on the UI state the previous step produced
      const outcome = await driveClickElement(step, run);
      if (!outcome.ok) {
        // oxlint-disable-next-line no-await-in-loop -- dismiss whatever the click opened before reporting
        if (outcome.needsAbort === true) await abort();
        return partial(step.label, outcome.why ?? "the click failed");
      }
      done.push(step.label);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- each recipe step depends on the UI state the previous step produced; they cannot be parallelized
    const res = await run(command, STEP_TIMEOUT_MS);
    if (!res.ok) {
      // oxlint-disable-next-line no-await-in-loop -- dismiss the half-open sheet/popover before reporting partial state
      if (step.primitive !== "reveal" && step.primitive !== "activate") await abort();
      return partial(
        step.label,
        res.timedOut === true ? "the step timed out" : res.stderr.trim() || "the step failed",
      );
    }
    done.push(step.label);
  }
  return { exitCode: 0, stdout: `drove ${done.length} step(s): ${done.join(" → ")}`, stderr: "" };
}

async function waitForElement(
  command: UiCommand,
  timeoutMs: number,
  run: UiRunner,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling the same element until it appears is inherently sequential
    const res = await run(command, STEP_TIMEOUT_MS);
    if (res.ok && res.stdout.trim() === "true") return true;
    if (Date.now() >= deadline) return false;
    // oxlint-disable-next-line no-await-in-loop -- inter-poll delay between sequential existence checks
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
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
        "set ui-enabled true`, then grant Accessibility to this process (see docs/setup.md). " +
        "It drives the local Things GUI and is intended for a dedicated always-on Mac.",
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
export function createUiVector(config: ThingsApiConfig, run: UiRunner = defaultRun): WriteVector {
  const enabled = config.ui.enabled;
  return {
    id: "ui",
    matrix: enabled ? enabledMatrix() : disabledMatrix(),
    async execute(invocation: CompiledInvocation): Promise<ExecuteResult> {
      if (!enabled) {
        return refusal(
          "the ui vector is disabled (`things config set ui-enabled true` to enable it).",
        );
      }
      if (invocation.recipe === undefined) {
        return refusal("ui invocation carried no recipe (compile bug).");
      }
      return drive(invocation.recipe, run);
    },
  };
}
