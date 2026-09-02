/**
 * THE REPEAT DIALOG'S SHAPE MANIFEST (RDLAT2).
 *
 * A GUI driver that re-derives the dialog's structure at every step pays for it
 * in Accessibility round-trips, and on a real machine each of those costs an
 * order of magnitude more than it does on a lab clone (~20 ms against ~1.7 ms,
 * measured on the maintainer's M1 2026-09-02). The obvious economy is to
 * remember the shape instead of re-discovering it — but the Repeat dialog does
 * not HAVE a shape. It has a shape PER STATE: ticking "Add deadlines" mints a
 * text field on the shell (#646), selecting an ends bound INSERTS a numeric
 * field ahead of the interval (HXPC1/#589), switching the frequency rebuilds the
 * cadence group's labels and pop-ups outright (BEEP1).
 *
 * So this module is not a cache of a tree. It is the EXPECTATION the measured
 * laws produce for a given state, in the two forms the driver can act on:
 *
 *   1. {@link matchRepeatShell} — the dialog SHELL's control census, which is
 *      state-independent and therefore assertable the moment the dialog opens.
 *      A shell that does not match is not the dialog this driver knows, and the
 *      drive refuses rather than pressing into it (fail direction: over-caution,
 *      docs/lab/harness.md §AX-drive scrutiny).
 *   2. {@link cadenceExpectationFor} — the CADENCE GROUP's expected shape for
 *      the rule state a step has just produced. This one is ADVISORY by
 *      construction: a group that matches has demonstrably finished re-laying
 *      out, so the settle can stop early; a group that does not match is simply
 *      not-yet-settled, and the two-agreeing-reads rule (BEEP1) decides as it
 *      always has. A wrong expectation therefore costs a few milliseconds and
 *      can never cost correctness.
 *
 * INVALIDATION. Every expectation here was measured against ONE app generation
 * (CGRD1 §A/§B, Things 3.23 build 32300036). AX surfaces are undocumented
 * private APIs, so a different generation gets no fast path at all: the version
 * gate below is checked first, and an unrecognized build runs the full
 * discrimination on every step exactly as it did before this module existed.
 * The runtime match is still the authority — the gate only stops a KNOWN-foreign
 * build from being measured against expectations that were never about it.
 */
import { execFileSync } from "node:child_process";

/**
 * App generations these expectations were measured against, matched as version
 * PREFIXES.
 *
 * `3.23` covers 3.23, 3.23.1 and 3.23.2: the dialog was redesigned at 3.23
 * (RDLG2 — the `Next:` occurrence pop-up) and the point releases since have not
 * moved it, which is what the shell assertion re-proves on every single open. A
 * 3.24 would not match, and would run in full-discrimination mode until someone
 * sits the lab with it.
 */
export const REPEAT_SHAPE_VERSIONS: readonly string[] = ["3.23"];

/** `defaults read` wants the plist path WITHOUT the .plist extension. */
const THINGS_INFO_PLIST = "/Applications/Things3.app/Contents/Info";

let cachedVersion: string | null | undefined;

/**
 * The installed Things version, memoized for the process. Prompt-free (a plist
 * read inside the app bundle, never the app's data container — permissions
 * doctrine Article I), and never fatal: unreadable reads as null, which the
 * gate below treats as "unknown", i.e. no fast path.
 */
export function installedThingsVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const out = execFileSync(
      "defaults",
      ["read", THINGS_INFO_PLIST, "CFBundleShortVersionString"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    cachedVersion = out === "" ? null : out;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * Test seam: PIN the version this module reports (or, with `undefined`, forget
 * the memo so the next call reads the installed app again).
 *
 * The unit matrix must not depend on whether the machine running it happens to
 * have Things installed — a suite that passes on the maintainer's Mac and fails
 * on a CI runner is not a test. The shared setup pins a version; the cells that
 * exercise the unrecognized-build path pin their own.
 */
export function setInstalledThingsVersion(version: string | null | undefined): void {
  cachedVersion = version;
}

/** Is this app generation one the manifest was measured against? */
export function shapeManifestCoversVersion(version: string | null): boolean {
  if (version === null) return false;
  return REPEAT_SHAPE_VERSIONS.some(
    (prefix) => version === prefix || version.startsWith(`${prefix}.`),
  );
}

/** The dialog shell's direct-child role census, as the open snapshot reports it. */
export interface ShellRoleCensus {
  checkBoxes: number;
  popUps: number;
  buttons: number;
  groups: number;
  textFields: number;
  /** Every role the shell reported, in tree order — for the refusal's own words. */
  roles: readonly string[];
}

/** Count a shell's direct children by AX role. */
export function shellRoleCensus(roles: readonly string[]): ShellRoleCensus {
  const n = (role: string): number => roles.filter((r) => r === role).length;
  return {
    checkBoxes: n("AXCheckBox"),
    popUps: n("AXPopUpButton"),
    buttons: n("AXButton"),
    groups: n("AXGroup"),
    textFields: n("AXTextField"),
    roles: [...roles],
  };
}

/**
 * Is this shell the Repeat dialog this driver knows?
 *
 * The signature is the one the window/focus census already identifies the dialog
 * by (`src/write/vectors/ui-state.ts`, measured in docs/lab/rdlg1-323-repeat-dialog-census.md
 * §2.1 and re-measured across every state in CGRD1 §B): exactly two checkboxes
 * ("Add deadlines" / "Add reminders"), exactly one direct pop-up (the
 * frequency), exactly two buttons (OK / Cancel), exactly one group (the cadence
 * group), and AT MOST one direct text field — none until "Add deadlines" is
 * ticked, exactly one afterwards, and still exactly one when reminders are
 * ticked as well. Static texts and images are chrome and are not counted.
 *
 * Asserting it at the OPEN is new (RDLAT2) and is the point of the manifest: the
 * drive used to satisfy itself that `pop up button 1` resolved and then press on.
 * A dialog whose census has moved is a redesigned dialog, and pressing structural
 * indices into one is how a GUI driver writes the wrong rule.
 */
export function matchRepeatShell(
  roles: readonly string[],
): { ok: true; census: ShellRoleCensus } | { ok: false; why: string } {
  const census = shellRoleCensus(roles);
  const wrong: string[] = [];
  if (census.checkBoxes !== 2) wrong.push(`${census.checkBoxes} checkboxes (expected 2)`);
  if (census.popUps !== 1) wrong.push(`${census.popUps} pop-up buttons (expected 1)`);
  if (census.buttons !== 2) wrong.push(`${census.buttons} buttons (expected 2)`);
  if (census.groups !== 1) wrong.push(`${census.groups} groups (expected 1)`);
  if (census.textFields > 1) wrong.push(`${census.textFields} text fields (expected 0 or 1)`);
  if (wrong.length === 0) return { ok: true, census };
  return { ok: false, why: wrong.join(", ") };
}

/**
 * The expected shape of the CADENCE GROUP for one rule state — the three laws
 * CGRD1 §A measured, in the form the settle can check.
 *
 * Deliberately NOT a count of static texts: the group also renders an occurrence
 * PREVIEW ("8/5/26, 9/5/26, …") whose length depends on the rule, so a static
 * count is not a property of the state. What IS a property of the state is the
 * anchor labels and the number of numeric fields, and those are exactly what the
 * addressing rules turn on.
 */
export interface CadenceExpectation {
  /** How many numeric fields the group must show. */
  fields: number;
  /** Labels that must be present (matched exactly, as `cgLabelY` matches). */
  requiredLabels: readonly string[];
  /** Labels that must be absent. */
  forbiddenLabels: readonly string[];
}

/** The rule state a step has just produced, as far as the cadence group cares. */
export interface CadenceState {
  /** An after-completion rule has no calendar: no `Every`, no `Ends:`, one field. */
  afterCompletion: boolean;
  /** True once an `Ends: after N` bound has been selected — it INSERTS a second field. */
  endsAfter: boolean;
}

/**
 * The expectation for a state, or null when nothing may be asserted — in which
 * case the settle's own two-agreeing-reads rule (BEEP1) decides alone, exactly
 * as it always has.
 *
 * TWO reasons to return null, and the second is the important one.
 *
 * 1. The app generation is not one the manifest was measured against.
 *
 * 2. THE EXPECTATION WOULD NOT DISCRIMINATE. The settle exists because a
 *    frequency switch REBUILDS the cadence group, and reading it too early takes
 *    positions off controls that are still moving and types into a field being
 *    torn down. Letting a shape MATCH end the settle early is only sound when the
 *    shape is one the PREVIOUS state could not also have had — otherwise the
 *    match can be satisfied by the group the switch has not yet replaced, which
 *    is precisely the hazard the settle was built for.
 *
 *    Two states qualify, and only two:
 *      - AFTER COMPLETION, which carries neither `Every` nor `Ends:` — no fixed
 *        frequency can look like it (CGRD1 §A law 2);
 *      - ENDS-AFTER, which shows TWO numeric fields because the bound inserts the
 *        count ahead of the interval — no other state shows two (§A law 3).
 *
 *    A fixed frequency changing to another fixed frequency looks the same before
 *    and after (`Every` + `Ends:`, one field), so it gets no expectation and
 *    waits for the agreement. The manifest is not allowed to guess there.
 */
export function cadenceExpectationFor(
  state: CadenceState,
  version: string | null,
): CadenceExpectation | null {
  if (!shapeManifestCoversVersion(version)) return null;
  if (state.afterCompletion) {
    return { fields: 1, requiredLabels: [], forbiddenLabels: ["Every", "Ends:"] };
  }
  if (state.endsAfter) {
    return { fields: 2, requiredLabels: ["Every", "Ends:"], forbiddenLabels: [] };
  }
  return null;
}

/** What the dialog-open snapshot hop reports back. */
export interface DialogOpenSnapshot {
  /** 1-based index of the shell candidate that answered (1 = attached sheet). */
  index: number;
  /** The shell's direct-child AX roles, in tree order. */
  roles: string[];
}

/**
 * Parse the dialog-open snapshot hop's stdout: `idx=<n> roles=<r>,<r>,…`.
 * Returns null for anything else, including the hop's own "none" verdict.
 */
export function parseDialogOpenSnapshot(stdout: string): DialogOpenSnapshot | null {
  const line = stdout.trim();
  const match = /^idx=(\d+)\s+roles=(.*)$/s.exec(line);
  if (match === null) return null;
  const index = Number(match[1]);
  if (!Number.isFinite(index) || index < 1) return null;
  const roles = (match[2] ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");
  return { index, roles };
}
