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

import { everyUiScript } from "./helpers/ui-script-catalog.ts";

const DARWIN = process.platform === "darwin";

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
    const all = everyUiScript();
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
    // Each script is its own `osacompile` process; the set is large enough that
    // the default 5s budget is a flake under a loaded parallel run, not a signal.
  }, 60_000);

  // The filter above must never become the reason the suite is green. On a host
  // WITH Things every script is checked, app-addressed ones included.
  it("checks the app-addressed scripts too wherever Things is installed", () => {
    const appAddressed = everyUiScript().filter((s) => needsThingsDictionary(s.script));
    expect(appAddressed.length).toBeGreaterThan(0);
    if (!thingsInstalled()) return;
    const dir = mkdtempSync(join(tmpdir(), "ui-script-syntax-app-"));
    const failures = appAddressed
      .map((s, i) => ({ label: s.label, error: compileError(s.script, s.lang, dir, i) }))
      .filter((r) => r.error !== null)
      .map((r) => `${r.label}\n    ${r.error}`);
    expect(failures).toEqual([]);
  }, 60_000);

  // The specific trap that cost a certification pass: proof the guard above has
  // teeth, and a standing note of WHY those variables are named as they are.
  it("`before` really is a reserved word (the guard is not vacuous)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-script-syntax-neg-"));
    const bad = 'tell application "System Events"\n  set before to "x"\n  return before\nend tell';
    expect(compileError(bad, "applescript", dir, 0)).toMatch(/Expected expression but found/);
  });
});
