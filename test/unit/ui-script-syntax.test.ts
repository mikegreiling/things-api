/**
 * EVERY generated AppleScript must COMPILE (NEXTPOP1).
 *
 * The scripts in `ui.ts` are assembled as template strings and only ever parsed
 * by `osascript` on the far side of a GUI drive. A script that does not compile
 * therefore surfaces as a *drive failure mid-dialog*, indistinguishable from a
 * control that moved or an app that changed — the settle step added for NEXTPOP1
 * shipped with `set before to …`, and `before` is one of AppleScript's own
 * positional keywords, so it failed to parse. Nothing caught it until a whole
 * certification pass came back red with "Expected expression but found “to”".
 *
 * This suite feeds every script the repeat/heading/clone recipes generate through
 * `osacompile`, which PARSES without executing: no application is launched, no
 * event is sent, nothing is driven. It is the cheapest possible guard against
 * shipping a script that cannot run, and it catches the whole reserved-word class
 * (`before`, `after`, `now`, `id`, `count`, …) rather than the one instance of it.
 *
 * macOS only — `osacompile` is a system tool. On Linux the suite skips, which is
 * why the repo's macOS CI job runs it explicitly.
 *
 * TWO host capabilities, not one. `osacompile` gives the parser; the THINGS
 * DICTIONARY gives the vocabulary. The handful of scripts that `tell application
 * "Things3"` directly cannot be parsed at all where Things is not installed
 * (`selected to dos` degrades to the preposition `to`), so on a hosted runner
 * they are skipped and the System Events majority — 47 of the 50 scripts, and
 * where the reserved-word class this suite was written for lives — is checked.
 * On a development Mac and in the lab VM, all 50 are.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  makeRepeatingRecipe,
  projectMakeRepeatingRecipe,
  projectPauseRepeatRecipe,
  projectRescheduleRepeatRecipe,
  pauseRepeatRecipe,
  rescheduleRepeatRecipe,
  resumeRepeatRecipe,
  type RepeatRuleExtras,
} from "../../src/write/vectors/ui-recipes.ts";
import type { RepeatDialogShape, UiStep } from "../../src/write/vectors/types.ts";
import {
  axAbortScript,
  axAuditDialogScript,
  axCancelDialogScript,
  axCancelFrameScript,
  commandForStep,
} from "../../src/write/vectors/ui.ts";
import { axUiStateScript } from "../../src/write/vectors/ui-state.ts";

const DARWIN = process.platform === "darwin";

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

/**
 * A step's `path` is bound at DRIVE time, once the AX probe has picked whichever
 * of its `pathCandidates` resolves. Bind the first candidate here so the script
 * is generated in the shape it is actually dispatched in — an empty path would
 * make every addressed script a false failure.
 */
function bindPath(step: UiStep): UiStep {
  const first = step.pathCandidates?.[0];
  return first === undefined || step.path !== undefined ? step : { ...step, path: first };
}

function everyScript(): { label: string; script: string; lang: string }[] {
  const recipes = [
    makeRepeatingRecipe("T-1", "yearly", 2, FULL),
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
  const out: { label: string; script: string; lang: string }[] = [];
  const seen = new Set<string>();
  for (const recipe of recipes) {
    for (const shape of ["next-popup", "legacy"] as const) {
      for (const step of forShape(recipe.steps, shape)) {
        const cmd = commandForStep(bindPath(step), recipe.targetUuid);
        if (typeof cmd.script !== "string") continue;
        if (seen.has(cmd.script)) continue;
        seen.add(cmd.script);
        out.push({
          label: `${recipe.op} · ${shape} · ${cmd.label}`,
          script: cmd.script,
          lang: cmd.lang ?? "applescript",
        });
      }
    }
  }
  // The scripts the DRIVER compiles rather than the recipe: the read-only
  // census, the cleanup ladder's two dismissals, and the pre-commit audit —
  // whose occurrence comparison carries the relative-date resolver (#625).
  for (const extra of [
    { label: "driver \u00b7 ui-state census", script: axUiStateScript() },
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
  ]) {
    if (seen.has(extra.script)) continue;
    seen.add(extra.script);
    out.push({ ...extra, lang: "applescript" });
  }
  return out;
}

/**
 * Does this script address the Things application ITSELF, rather than driving its
 * process through System Events?
 *
 * The distinction is a COMPILE-TIME dependency, not a stylistic one. `tell
 * application "Things3"` resolves the app's own scripting dictionary at parse
 * time, so terms like `selected to dos` are only words a parser knows where
 * Things is installed; without it, `to` falls back to the preposition and the
 * script fails with `A to:dos can't go after this id`. `tell application "System
 * Events" to tell process "Things3"` needs nothing but System Events, which every
 * macOS host has — so those scripts parse anywhere.
 *
 * The distinction is why this suite reds on a hosted CI runner but passes on a
 * development Mac, which is exactly the trap the suite exists to catch: an
 * environment-dependent parse. Kept as a positive check on the app-addressed
 * scripts where Things IS present (a dev Mac, the lab VM), and skipped where it
 * is not — never silently downgraded to "compiles" on a host that cannot know.
 */
function needsThingsDictionary(script: string): boolean {
  return script.includes('tell application "Things3"');
}

/**
 * Is Things installed on THIS host? `osascript -e 'id of application "Things3"'`
 * is the cheap dictionary-free probe — it consults the Launch Services registry
 * and never launches anything.
 */
function thingsInstalled(): boolean {
  try {
    execFileSync("osascript", ["-e", 'id of application "Things3"'], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse-only. `osacompile` never launches the target app or sends an event — it
 * resolves the target's dictionary at most (see {@link needsThingsDictionary}).
 */
function compileError(script: string, lang: string, dir: string, n: number): string | null {
  const jxa = lang === "javascript";
  const src = join(dir, `s${n}.${jxa ? "js" : "applescript"}`);
  writeFileSync(src, script, "utf8");
  try {
    const args = jxa ? ["-l", "JavaScript"] : [];
    execFileSync("osacompile", [...args, "-o", join(dir, `s${n}.scpt`), src], { stdio: "pipe" });
    return null;
  } catch (err) {
    const e = err as { stderr?: Buffer };
    return (e.stderr?.toString() ?? String(err)).trim();
  }
}

describe.skipIf(!DARWIN)("every generated AppleScript compiles (NEXTPOP1)", () => {
  it("osacompile accepts every script the repeat recipes emit", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-script-syntax-"));
    const all = everyScript();
    // A recipe set that generated nothing would pass vacuously.
    expect(all.length).toBeGreaterThan(30);

    // Where Things is absent (a hosted CI runner), the app-addressed scripts
    // cannot be PARSED at all, so a verdict on them would be about the host.
    // The System Events scripts — which is where the reserved-word class the
    // suite was written for lives — are checked everywhere.
    const haveThings = thingsInstalled();
    const scripts = haveThings ? all : all.filter((s) => !needsThingsDictionary(s.script));
    // The System Events majority must survive the filter, or a missing app would
    // quietly empty the suite.
    expect(scripts.length).toBeGreaterThan(30);

    const failures = scripts
      .map((s, i) => ({ label: s.label, error: compileError(s.script, s.lang, dir, i) }))
      .filter((r) => r.error !== null)
      .map((r) => `${r.label}\n    ${r.error}`);
    expect(failures).toEqual([]);
  });

  // The filter above must never become the reason the suite is green. On a host
  // WITH Things every script is checked, app-addressed ones included.
  it("checks the app-addressed scripts too wherever Things is installed", () => {
    const appAddressed = everyScript().filter((s) => needsThingsDictionary(s.script));
    expect(appAddressed.length).toBeGreaterThan(0);
    if (!thingsInstalled()) return;
    const dir = mkdtempSync(join(tmpdir(), "ui-script-syntax-app-"));
    const failures = appAddressed
      .map((s, i) => ({ label: s.label, error: compileError(s.script, s.lang, dir, i) }))
      .filter((r) => r.error !== null)
      .map((r) => `${r.label}\n    ${r.error}`);
    expect(failures).toEqual([]);
  });

  // The specific trap that cost a certification pass: proof the guard above has
  // teeth, and a standing note of WHY those variables are named as they are.
  it("`before` really is a reserved word (the guard is not vacuous)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-script-syntax-neg-"));
    const bad = 'tell application "System Events"\n  set before to "x"\n  return before\nend tell';
    expect(compileError(bad, "applescript", dir, 0)).toMatch(/Expected expression but found/);
  });
});
