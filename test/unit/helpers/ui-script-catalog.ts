/**
 * THE UI SCRIPT CATALOG — every acting script the ui vector can emit, in one place.
 *
 * Two suites need the same enumeration and must never drift apart:
 *
 *  - `ui-script-syntax.test.ts` feeds it to `osacompile` (NEXTPOP1): every script
 *    must PARSE, in both settle shapes.
 *  - `ui-script-broker-safety.test.ts` feeds it the shape a deputy-routed host
 *    actually generates and asserts no script carries a phrase the deputy's
 *    broker refuses (#695).
 *
 * A script that only one of those two suites knows about is exactly how a
 * host-class regression ships, so the catalog is shared rather than copied. It
 * renders the FOLDED shape — resolution prelude, deadline loop and all — because
 * `commandForStep` alone yields precisely what is dispatched (DRVLAT1, #633).
 */
import {
  makeRepeatingRecipe,
  projectMakeRepeatingRecipe,
  projectPauseRepeatRecipe,
  projectRescheduleRepeatRecipe,
  pauseRepeatRecipe,
  rescheduleRepeatRecipe,
  resumeRepeatRecipe,
  type RepeatRuleExtras,
} from "../../../src/write/vectors/ui-recipes.ts";
import type { RepeatDialogShape, UiStep } from "../../../src/write/vectors/types.ts";
import {
  axAbortScript,
  axAuditDialogScript,
  axCancelDialogScript,
  axCancelFrameScript,
  axSetValueScript,
  axTypeTextScript,
  axVerifyPrefillDateAreasScript,
  axVerifyPrefillScript,
  commandForStep,
  jxaClickScript,
} from "../../../src/write/vectors/ui.ts";
import {
  jxaSidebarChevronClickScript,
  jxaSidebarLiveDragScript,
  jxaSidebarHeldScrollDragScript,
  jxaSidebarScrollScript,
  jxaSidebarScrollToScript,
  jxaSidebarSnapshotScript,
  jxaSidebarSparseChevronClickScript,
  jxaSidebarSparseScrollScript,
  jxaSidebarSparseScrollToScript,
  jxaSidebarSparseSnapshotScript,
  jxaSidebarVisibilityScript,
} from "../../../src/write/vectors/ui-drag.ts";
import {
  inertSettleInjector,
  type SettleInjector,
  settleInjectorFor,
} from "../../../src/write/vectors/ui-observer.ts";
import { axFocusGuardPrelude, axUiStateScript } from "../../../src/write/vectors/ui-state.ts";
import { jxaSessionLockScript } from "../../../src/write/vectors/session-lock.ts";

/** One rendered script, labeled by the recipe/shape/settle-shape that produced it. */
export interface CatalogScript {
  label: string;
  script: string;
  lang: string;
}

/** One settle shape to render the catalog in. */
export interface CatalogInjector {
  tag: string;
  obs: SettleInjector;
}

/** The polling shape: no sidecar, the scripts that shipped before VOPAT2. */
export const POLLING_SHAPE: CatalogInjector = { tag: "polling", obs: inertSettleInjector() };

/** The observed shape: a live sidecar, so every settle rides the socket. */
export const OBSERVED_SHAPE: CatalogInjector = {
  tag: "observed",
  obs: settleInjectorFor({
    transport: "sidecar",
    socketPath: "/tmp/things-api-observer/s-0123abcd.sock",
    token: "0123456789abcdef0123456789abcdef",
    logPath: "/tmp/things-api-observer/observer.log",
    registered: "16/16",
    pid: 4242,
  }),
};

/** Resolve a recipe's steps for one dialog shape, exactly as `drive()` does. */
function forShape(steps: UiStep[], shape: RepeatDialogShape): UiStep[] {
  return steps
    .filter((s) => s.onlyShape === undefined || s.onlyShape === shape)
    .map((s) => (s.shaped === undefined ? s : Object.assign({}, s, s.shaped[shape])));
}

/**
 * The full deadlined vocabulary — every optional control the dialog has, so no
 * conditional branch of the recipe goes ungenerated.
 */
const FULL: RepeatRuleExtras = {
  weekdays: ["monday", "thursday"],
  monthly: { day: 20 },
  yearly: { month: 8, day: 20 },
  ends: { kind: "after", count: 5 },
  reminder: "09:00",
  deadline: true,
  startDaysEarlier: 14,
  next: "2026-08-20",
};

export function everyUiScript(
  injectors: CatalogInjector[] = [POLLING_SHAPE, OBSERVED_SHAPE],
): CatalogScript[] {
  const recipes = [
    makeRepeatingRecipe("T-1", "yearly", 2, FULL),
    // THE SEEDED SHAPE (DEFAULTS2): the same vocabulary with a seed row whose
    // dates PROVE the pre-fill, so the verify-by-read branch and the tagged
    // setters are generated as well as the untagged ones.
    makeRepeatingRecipe("T-1", "weekly", 1, {
      weekdays: ["thursday"],
      reminder: "09:30",
      next: "2026-07-09",
      seed: {
        scheduled: "2026-07-09",
        today: "2026-07-05",
        deadline: null,
        reminder: "09:30",
      },
    }),
    makeRepeatingRecipe("T-1", "monthly", 1, { monthly: { weekday: "monday", ordinal: 2 } }),
    makeRepeatingRecipe("T-1", "weekly", 1, { weekdays: ["sunday"], afterCompletion: false }),
    makeRepeatingRecipe("T-1", "daily", 1, { afterCompletion: true }),
    makeRepeatingRecipe("T-1", "daily", 3),
    rescheduleRepeatRecipe("T-1", "yearly", 1, FULL),
    projectMakeRepeatingRecipe("AREA-1", "P-1", "A project", "monthly", 1, FULL),
    projectRescheduleRepeatRecipe("P-1", "weekly", 1, FULL),
    pauseRepeatRecipe("T-1"),
    resumeRepeatRecipe("T-1"),
    projectPauseRepeatRecipe("P-1"),
  ];
  const out: CatalogScript[] = [];
  const seen = new Set<string>();
  // ONE PASS PER SETTLE SHAPE the caller asked for. The syntax suite asks for
  // both (a settle snippet that does not parse fails mid-dialog); the
  // broker-safety suite asks only for the shape its host class generates.
  for (const recipe of recipes) {
    for (const shape of ["next-popup", "legacy"] as const) {
      for (const { tag, obs } of injectors) {
        for (const step of forShape(recipe.steps, shape)) {
          const cmd = commandForStep(step, recipe.targetUuid, obs);
          if (typeof cmd.script !== "string") continue;
          if (seen.has(cmd.script)) continue;
          seen.add(cmd.script);
          out.push({
            label: `${recipe.op} · ${shape} · ${tag} · ${cmd.label}`,
            script: cmd.script,
            lang: cmd.lang ?? "applescript",
          });
        }
      }
    }
  }
  // The scripts the DRIVER compiles rather than the recipe: the read-only
  // census, the cleanup ladder's two dismissals, and the pre-commit audit —
  // whose occurrence comparison carries the relative-date resolver (#625).
  for (const extra of [
    { label: "driver \u00b7 ui-state census", script: axUiStateScript() },
    // The FOLDED focus guard: the census prelude compiled in front of the very
    // keystroke script it guards (DRVLAT1). Both dialog invariants, since the
    // expected-sheet clause is generated only when one is latched.
    {
      label: "driver \u00b7 folded focus guard (no sheet latched) + set-value",
      script: `${axFocusGuardPrelude(null)}\n${axSetValueScript("text field 1 of sheet 1 of window 1", "3")}`,
    },
    {
      label: "driver \u00b7 folded focus guard (repeat sheet latched) + type-text",
      script: `${axFocusGuardPrelude("repeat")}\n${axTypeTextScript("Some Project")}`,
    },
    { label: "driver \u00b7 dismiss (Cancel)", script: axCancelDialogScript() },
    { label: "driver \u00b7 Cancel button frame", script: axCancelFrameScript() },
    { label: "driver \u00b7 abort (Escape)", script: axAbortScript() },
    {
      label: "driver \u00b7 pre-commit audit",
      script: axAuditDialogScript({
        shell: "sheet 1 of window 1",
        group: "group 1 of sheet 1 of window 1",
        controls: [
          {
            kind: "popup",
            label: "frequency",
            path: "pop up button 1 of sheet 1 of window 1",
            expected: ["daily"],
          },
          {
            kind: "group-number",
            label: "interval",
            numberTarget: "interval",
            expected: ["3"],
          },
          {
            kind: "occurrence-popup",
            label: "first occurrence",
            path: "pop up button 2 of group 1 of sheet 1 of window 1",
            expected: ["2026-08-20"],
          },
          {
            kind: "checkbox",
            label: "add reminders",
            path: "checkbox 1 of sheet 1 of window 1",
            expected: ["1"],
          },
          { kind: "weekdays", label: "weekdays", weekdayBase: 3, expected: ["Monday"] },
          { kind: "row-field", label: "start earlier", rowLabel: "days earlier", expected: ["14"] },
        ],
      }),
    },
    // THE VERIFY-BY-READ LEGS (DEFAULTS2). Both are driver-compiled for the
    // audit's reason — the plan's controls are addressed through the live shell
    // and the measured shape — so neither reaches osascript via a recipe step,
    // and both carry the relative-date resolver the #625 class needs.
    {
      label: "driver · verify-prefill (System Events leg)",
      script: axVerifyPrefillScript({
        shell: "sheet 1 of window 1",
        group: "group 1 of sheet 1 of window 1",
        controls: [
          {
            kind: "group-number",
            label: "interval",
            numberTarget: "interval",
            expected: ["1"],
            prefillKey: "interval",
          },
          {
            kind: "popup",
            label: "after-completion unit",
            path: "pop up button 1 of group 1 of sheet 1 of window 1",
            expected: ["week", "weeks"],
            prefillKey: "ac-unit",
          },
          {
            kind: "occurrence-popup",
            label: "first occurrence",
            path: "pop up button 2 of group 1 of sheet 1 of window 1",
            expected: ["2026-08-20"],
            prefillKey: "next",
          },
          {
            kind: "checkbox",
            label: "add reminders",
            path: 'checkbox "Add reminders" of sheet 1 of window 1',
            expected: ["1"],
            prefillKey: "add-reminders",
          },
          {
            kind: "weekdays",
            label: "weekdays",
            weekdayBase: 3,
            expected: ["Monday"],
            prefillKey: "weekdays",
          },
          {
            kind: "row-field",
            label: "start earlier",
            rowLabel: "days earlier",
            expected: ["14"],
            prefillKey: "start-earlier",
          },
        ],
      }),
    },
  ]) {
    if (seen.has(extra.script)) continue;
    seen.add(extra.script);
    out.push({ ...extra, lang: "applescript" });
  }
  // THE POINTER-GESTURE SCRIPTS (PTRGD1). JXA, driver-compiled, and every one of
  // them posts synthesized mouse events behind the pre-gesture guard — so both
  // suites that read this catalog must see them: `osacompile` proves the guard
  // and the gesture parse together, and the broker-safety suite proves the guard
  // reaches its verdicts without shelling out.
  const SIDEBAR_TITLES = ["Errands", "Reading"] as const;
  const SIDEBAR_ROW = { x: 12, y: 208, w: 240, h: 24 };
  for (const gesture of [
    {
      label: "driver · sidebar-drag (live-aim, insert above)",
      script: jxaSidebarLiveDragScript(
        180,
        220,
        420,
        SIDEBAR_ROW,
        SIDEBAR_TITLES,
        { title: "Reading", ordinal: 17, unique: true },
        1,
        40,
      ),
    },
    {
      label: "driver · sidebar-drag (live-aim, to last)",
      script: jxaSidebarLiveDragScript(180, 220, 420, SIDEBAR_ROW, SIDEBAR_TITLES, null, null, 40),
    },
    {
      label: "driver · sidebar-held-drag",
      script: jxaSidebarHeldScrollDragScript(180, 220, "Reading", 40, SIDEBAR_TITLES, SIDEBAR_ROW),
    },
    {
      label: "driver · sidebar-held-drag (to last)",
      script: jxaSidebarHeldScrollDragScript(180, 220, null, 40, SIDEBAR_TITLES, SIDEBAR_ROW),
    },
    {
      label: "driver · sidebar-chevron",
      script: jxaSidebarChevronClickScript("Errands", -1, SIDEBAR_TITLES),
    },
    {
      label: "driver · sidebar-scroll (wheel)",
      script: jxaSidebarScrollScript(-3, SIDEBAR_TITLES),
    },
    {
      label: "driver · sidebar-scroll (scrollbar)",
      script: jxaSidebarScrollToScript(0.5, SIDEBAR_TITLES),
    },
    { label: "driver · sidebar-snapshot", script: jxaSidebarSnapshotScript(SIDEBAR_TITLES) },
    {
      label: "driver · click-point",
      script: jxaClickScript(412, 388, "click the open dialog's Cancel button"),
    },
  ]) {
    if (seen.has(gesture.script)) continue;
    seen.add(gesture.script);
    out.push({ ...gesture, lang: "javascript" });
  }
  // ...AND THE SPARSE / ORDINAL-ADDRESSED FORMS the sidebar map enables (VOPAT2
  // PR 2). The census-addressed scripts above are what a drive generates with no
  // map — the first census, a prediction that did not confirm, or
  // `THINGS_API_SIDEBAR_SPARSE=0`; these are what it generates with one. Both
  // shapes are dispatched on every real move, so both must parse and both must
  // clear the broker.
  const SPARSE_ADDR = { paneIndex: 1, verifyOrdinal: 13, verifyTitle: "Errands" };
  for (const sparse of [
    {
      label: "driver · sidebar-snapshot (sparse, section starts)",
      script: jxaSidebarSparseSnapshotScript(SIDEBAR_TITLES, {
        paneIndex: null,
        ordinals: [],
        maxCandidates: 28,
      }),
    },
    {
      label: "driver · sidebar-snapshot (sparse, carried ordinals)",
      script: jxaSidebarSparseSnapshotScript(SIDEBAR_TITLES, {
        paneIndex: 1,
        ordinals: [13, 16],
        maxCandidates: 28,
      }),
    },
    {
      label: "driver · sidebar-snapshot (full sweep, escalated depth)",
      script: jxaSidebarSnapshotScript(SIDEBAR_TITLES, 6),
    },
    {
      label: "driver · sidebar-scroll (scrollbar, ordinal-addressed)",
      script: jxaSidebarSparseScrollToScript(0.5, SPARSE_ADDR),
    },
    {
      label: "driver · sidebar-scroll (wheel, ordinal-addressed)",
      script: jxaSidebarSparseScrollScript(-3, SPARSE_ADDR),
    },
    {
      label: "driver · sidebar-chevron (ordinal-addressed)",
      script: jxaSidebarSparseChevronClickScript(SPARSE_ADDR, SIDEBAR_ROW),
    },
    { label: "driver · sidebar-visibility (show)", script: jxaSidebarVisibilityScript("show") },
    { label: "driver · sidebar-visibility (hide)", script: jxaSidebarVisibilityScript("hide") },
  ]) {
    if (seen.has(sparse.script)) continue;
    seen.add(sparse.script);
    out.push({ ...sparse, lang: "javascript" });
  }
  // THE SESSION-LOCK PROBE (LOCKSCR1, #732) — dispatched ahead of the preamble
  // on every gated drive, and on a deputy-routed Mac it crosses the broker like
  // every other script, so both suites must see it.
  const lockProbe = {
    label: "driver · session-lock probe",
    script: jxaSessionLockScript(),
    lang: "javascript",
  };
  if (!seen.has(lockProbe.script)) {
    seen.add(lockProbe.script);
    out.push(lockProbe);
  }
  const jxa = {
    label: "driver · verify-prefill (date-area leg)",
    script: axVerifyPrefillDateAreasScript([
      { label: "reminder", target: "reminder", spec: "time:09:30", prefillKey: "reminder-time" },
    ]),
    lang: "javascript",
  };
  if (!seen.has(jxa.script)) {
    seen.add(jxa.script);
    out.push(jxa);
  }
  return out;
}
