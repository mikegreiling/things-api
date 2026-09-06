/**
 * RAWAX1 — compiling a recipe's steps into an {@link AxProgram}, and deciding
 * where the hop boundaries go.
 *
 * THE FOLD TEST, as the maintainer ruled it: *a hop boundary survives only where
 * node must DECIDE or SETTLE between operations; otherwise fold it and report
 * per op.* Applied to the recipe as it actually stands, that protects two
 * boundaries inside what looked like one mergeable run, and one of them was
 * created by [DEPOBS3](#736) the commit before this campaign started:
 *
 *  - **the frequency selection ends a group.** Its step carries
 *    `crossHopSettle: "cadence-rebuild"`, which on a ROUTED host is node
 *    absorbing the cadence group's rebuild over the deputy-hosted ledger so the
 *    shape probe's script can drop its polling rounds. Folding the selection
 *    into the probe would put that wait back INSIDE a script that cannot settle
 *    on a socket — regressing #736 on exactly the host class this port exists
 *    for. A step with any `crossHopSettle` therefore ends its group.
 *  - **`settle-occurrences` ends a group.** With an observer it dispatches
 *    NOTHING (node awaits the ledger), and its two skips — `seen === 0`, and
 *    "no setter has run since the shape was measured" — are facts about the
 *    drive that only node holds.
 *
 * Everything between folds. The SHAPE fork travels with the ops rather than
 * being resolved by node (`onlyShape` / `shapedRef` / `shapedBase`), which is
 * what lets the probe sit inside the merged hop: the decision is made from a
 * read the executor itself took.
 *
 * FAIL CLOSED, AND FALL BACK RATHER THAN GUESS. A step whose address this file
 * cannot express structurally — an unregistered path, a primitive with no op —
 * makes {@link compileRawAxGroups} return null for the WHOLE recipe, and the
 * drive keeps the certified AppleScript transport. A port that silently
 * half-applied would be the worst of both.
 */
import type { CadenceExpectation } from "./ui-shape.ts";
import { cadenceExpectationFor, installedThingsVersion } from "./ui-shape.ts";
import { cadenceFieldRef, dialogRefFor, startEarlierRef } from "./ui-recipes.ts";
import type { AxControlCheck, AxOp, ElementRef } from "./ui-rawax-ops.ts";
import type { DialogAuditControl, RepeatDialogShape, UiStep } from "./types.ts";

/** How many attempts the typing loop and the checkbox converge get. */
const ATTEMPTS = 3;
/** `cgSettle`'s budget, carried across unchanged (BEEP1). */
const SETTLE_READS = 40;
const SETTLE_POLL_MS = 100;
/** How many of the Next: menu's own titles a miss reports back (NEXTPOP1). */
const SAMPLE_ITEMS = 5;
/** How deep the occurrence cascade is walked. */
const OCCURRENCE_LEVELS = 6;

/**
 * ONE MERGED HOP: the ops that run in a single script, plus the recipe steps
 * they came from so the driver can report the trail it always reported.
 */
export interface AxGroup {
  readonly ops: readonly AxOp[];
  /** The recipe steps folded into this hop, in order. */
  readonly steps: readonly UiStep[];
  /** True when the group's last op commits — the driver then swallows the OK step. */
  readonly commits: boolean;
}

/**
 * Does this step END its merge group (a node DECIDE or SETTLE boundary)?
 *
 * `crossHopSettle` is the whole test, and it is CONDITIONAL by design —
 * `ui-recipes.ts` arms it only on the seeded make/add path, because that is the
 * only path where the announcement node waits for is certain to come (DEFAULTS1
 * §2: a freshly minted seed's dialog opens on `after completion, every 1 week`
 * byte for byte, so any other frequency is necessarily a CHANGE and
 * `AXValueChanged` fires; a reschedule opens on an existing rule and proves
 * nothing).
 *
 * Tracking it exactly is what keeps both directions right. WITH the marker the
 * boundary survives, because folding would put node's cross-hop wait back inside
 * a script that cannot settle on a socket — the #736 regression. WITHOUT it the
 * step folds, and nothing is lost: node was never going to wait there, so
 * `nodeSettled` can never carry the observable and the probe polls in-script
 * exactly as the AppleScript path does today. Both halves are pinned in
 * `test/unit/ui-rawax-compile.test.ts`.
 */
function endsGroup(step: UiStep): boolean {
  return step.crossHopSettle !== undefined;
}

/** Is this step a node-side boundary that cannot be folded at all? */
function isBoundary(step: UiStep): boolean {
  return step.primitive === "settle-occurrences";
}

/**
 * The primitives that belong to the DIALOG-ENTRY run — the region the fold test
 * was applied to. Everything before it (reveal, activate, eligibility, the menu
 * press, `dialog-open`) keeps its hop for reasons §3.2a states, and this file
 * does not touch it.
 */
const FOLDABLE: ReadonlySet<string> = new Set([
  "select-popup",
  "probe-dialog-shape",
  "verify-prefill",
  "set-group-number",
  "set-row-field",
  "set-value",
  "ensure-checkbox",
  "converge-weekdays",
  "select-next-occurrence",
  "set-datetime",
  "audit-dialog",
  // The trailing OK press, which rides the audit's own script (RDLAT2 §4d).
  // It is a MEMBER of the region but never its START — see FOLD_START.
  "press",
]);

/**
 * The primitives that may BEGIN the foldable region.
 *
 * `press` is deliberately absent, and leaving it in cost this compiler its first
 * run: the recipe's FIRST press is `Items ▸ Repeat…`, three steps ahead of the
 * dialog even existing, so starting there swept in `dialog-open` — which is a
 * node DECIDE boundary, is not foldable, and correctly aborted the whole
 * compile. The region starts at the first step that acts on the OPEN dialog.
 */
const FOLD_START: ReadonlySet<string> = new Set([...FOLDABLE].filter((p) => p !== "press"));

/** The weekday converge encodes `<base>|<Weekday>,<Weekday>…` in `value`. */
function weekdayBaseOf(value: string): number {
  const base = Number(value.split("|", 1)[0]);
  return Number.isFinite(base) && base > 0 ? Math.trunc(base) : 2;
}
function weekdayTitlesOf(value: string): string[] {
  return value
    .slice(value.indexOf("|") + 1)
    .split(",")
    .filter((t) => t !== "");
}

/** The structured ref for a step's address, or null when it is unregistered. */
function refForStep(step: UiStep): ElementRef | null {
  if (step.primitive === "set-group-number") {
    return cadenceFieldRef(step.numberTarget ?? "interval");
  }
  if (step.primitive === "set-row-field") return startEarlierRef();
  const path = step.pathCandidates?.[0] ?? step.path;
  return path === undefined ? null : dialogRefFor(path);
}

/** Both shapes' refs for a shaped step, or null when either is unregistered. */
function shapedRefFor(step: UiStep): Readonly<Record<RepeatDialogShape, ElementRef>> | null {
  if (step.shaped === undefined) return null;
  const out: Partial<Record<RepeatDialogShape, ElementRef>> = {};
  for (const shape of ["next-popup", "legacy"] as const) {
    const path = step.shaped[shape]?.pathCandidates?.[0];
    if (path === undefined) continue;
    const ref = dialogRefFor(path);
    if (ref === null) return null;
    out[shape] = ref;
  }
  if (out["next-popup"] === undefined || out.legacy === undefined) return null;
  return out as Record<RepeatDialogShape, ElementRef>;
}

/** The shape-forked weekday base, when the step carries one. */
function shapedBaseFor(step: UiStep): Readonly<Record<RepeatDialogShape, number>> | null {
  if (step.shaped === undefined) return null;
  const next = step.shaped["next-popup"]?.value;
  const legacy = step.shaped.legacy?.value;
  if (next === undefined || legacy === undefined) return null;
  return { "next-popup": weekdayBaseOf(next), legacy: weekdayBaseOf(legacy) };
}

/**
 * Translate one audit/verify control into the executor's own check shape.
 *
 * NO SHAPE IS TAKEN, and that is the point: the probe that measures it runs
 * INSIDE the merged hop, so there is no verdict at compile time to filter
 * against. Both shapes' addresses travel with the control and the interpreter
 * picks — the same treatment an op's address gets, for the same reason.
 */
function controlFor(raw: DialogAuditControl): AxControlCheck | null {
  const merged = { ...raw, ...(raw.shaped === undefined ? {} : raw.shaped["next-popup"]) };
  const expected = merged.expected ?? [];
  const shapedRef = shapedControlRef(raw);
  const shapedBase = shapedControlBase(raw);
  const base = {
    label: merged.label,
    expected,
    ...(merged.expectedLabel !== undefined && { expectedLabel: merged.expectedLabel }),
    ...(raw.prefillKey !== undefined && { prefillKey: raw.prefillKey }),
    ...(raw.onlyShape !== undefined && { onlyShape: raw.onlyShape }),
    ...(shapedRef === null ? {} : { shapedRef }),
    ...(shapedBase === null ? {} : { shapedBase }),
  };
  switch (merged.kind) {
    case "group-number":
      return {
        ...base,
        kind: "number",
        ref: cadenceFieldRef(merged.numberTarget ?? "interval"),
      };
    case "row-field":
      return { ...base, kind: "number", ref: startEarlierRef() };
    case "date-area":
      return {
        ...base,
        kind: "date-area",
        ref: { dateArea: merged.dtTarget ?? "next" },
        spec: merged.dtSpec ?? "",
      };
    case "weekdays":
      return {
        ...base,
        kind: "weekdays",
        ref: { at: "group" },
        weekdayBase: merged.weekdayBase ?? 2,
      };
    case "popup":
    case "checkbox":
    case "occurrence-popup": {
      const path = merged.pathCandidates?.[0];
      const ref = path === undefined ? null : dialogRefFor(path);
      if (ref === null) return null;
      return {
        ...base,
        kind: merged.kind === "occurrence-popup" ? "occurrence" : merged.kind,
        ref,
      };
    }
  }
}

/** Both shapes' refs for a shaped audit control, or null when it has none. */
function shapedControlRef(
  raw: DialogAuditControl,
): Readonly<Record<RepeatDialogShape, ElementRef>> | null {
  if (raw.shaped === undefined) return null;
  const out: Partial<Record<RepeatDialogShape, ElementRef>> = {};
  for (const shape of ["next-popup", "legacy"] as const) {
    const path = raw.shaped[shape]?.pathCandidates?.[0];
    if (path === undefined) continue;
    const ref = dialogRefFor(path);
    if (ref === null) return null;
    out[shape] = ref;
  }
  if (out["next-popup"] === undefined || out.legacy === undefined) return null;
  return out as Record<RepeatDialogShape, ElementRef>;
}

/** Both shapes' weekday bases for a shaped weekday check, or null. */
function shapedControlBase(
  raw: DialogAuditControl,
): Readonly<Record<RepeatDialogShape, number>> | null {
  if (raw.shaped === undefined) return null;
  const next = raw.shaped["next-popup"]?.weekdayBase;
  const legacy = raw.shaped.legacy?.weekdayBase;
  if (next === undefined || legacy === undefined) return null;
  return { "next-popup": next, legacy };
}

/** The cadence expectation for a step's declared state, or null. */
function expectationFor(cadence: UiStep["cadence"]): CadenceExpectation | null {
  if (cadence === undefined) return null;
  return cadenceExpectationFor(cadence, installedThingsVersion());
}

/**
 * One recipe step -> its ops. Returns null when the step cannot be expressed,
 * which aborts the whole compile (see the module note on failing closed).
 *
 * `poll` is the shape probe's own fork, decided by node exactly as it is for the
 * AppleScript generator: a live sidecar, or a routed host whose node already
 * absorbed the cadence rebuild (DEPOBS3), gets the single-round form.
 */
function opsForStep(step: UiStep, probePolls: boolean): AxOp[] | null {
  const label = step.label;
  const common = {
    label,
    ...(step.unlessPrefilled !== undefined && { unlessPrefilled: step.unlessPrefilled }),
    ...(step.onlyShape !== undefined && { onlyShape: step.onlyShape }),
  };
  const shapedRef = shapedRefFor(step);
  const withShape = shapedRef === null ? {} : { shapedRef };

  switch (step.primitive) {
    case "probe-dialog-shape":
      return [{ ...common, op: "probe-shape", tolerance: 8, poll: probePolls }];

    case "select-popup": {
      const titles = step.valueCandidates ?? [step.value ?? ""];
      const ref = shapedRef === null ? refForStep(step) : { at: "group" as const };
      if (ref === null) return null;
      return [{ ...common, ...withShape, op: "select-popup", ref, titles }];
    }

    case "ensure-checkbox": {
      const ref = refForStep(step);
      if (ref === null) return null;
      return [
        {
          ...common,
          op: "ensure-checkbox",
          ref,
          target: step.checkboxTarget === true,
          attempts: ATTEMPTS,
        },
      ];
    }

    case "set-group-number":
    case "set-row-field":
    case "set-value": {
      const ref = refForStep(step);
      if (ref === null) return null;
      const value = step.value ?? "";
      const what =
        step.primitive === "set-group-number"
          ? `type "${value}" into the ${step.numberTarget ?? "interval"} field`
          : step.primitive === "set-row-field"
            ? `type "${value}" into the "${step.rowLabel ?? ""}" field`
            : `type "${value}" into the field`;
      // The cadence group is settled BEFORE the field is addressed, exactly as
      // `axSetGroupNumberScript` settles it — the addressing decision is made on
      // the instant the settle vouched for (RDLAT2 §4a).
      const settle: AxOp[] =
        step.primitive === "set-group-number"
          ? [
              {
                label: `${label} (settle the cadence group)`,
                op: "settle-group",
                expect: expectationFor(step.cadence),
                reads: SETTLE_READS,
                pollMs: SETTLE_POLL_MS,
                ...(step.unlessPrefilled !== undefined && {
                  unlessPrefilled: step.unlessPrefilled,
                }),
              },
            ]
          : [];
      return [...settle, { ...common, op: "type-into", ref, value, what, attempts: ATTEMPTS }];
    }

    case "converge-weekdays": {
      const shapedBase = shapedBaseFor(step);
      // THE VALUE IS SHAPE-SELECTED, and reading only the top-level one shipped
      // an op with NO weekday titles — which reached the guest as
      // `the weekday pop-up offers no item "undefined"` (RAWAX1 phase 2, run 1).
      // The recipe encodes `<base>|<Weekday>,…` per shape because the BASE forks
      // (3 under `next-popup`, 2 under `legacy`) while the titles do not, so the
      // titles come from whichever shape is present and the base keeps its fork.
      const value =
        step.value ?? step.shaped?.["next-popup"]?.value ?? step.shaped?.legacy?.value ?? "";
      const titles = weekdayTitlesOf(value);
      if (titles.length === 0) return null;
      return [
        {
          ...common,
          op: "converge-weekdays",
          base: weekdayBaseOf(value),
          titles,
          ...(shapedBase === null ? {} : { shapedBase }),
        },
      ];
    }

    case "select-next-occurrence": {
      const ref = refForStep(step);
      if (ref === null) return null;
      return [
        {
          ...common,
          op: "select-occurrence",
          ref,
          iso: step.value ?? "",
          levels: OCCURRENCE_LEVELS,
          sampleItems: SAMPLE_ITEMS,
        },
      ];
    }

    case "set-datetime":
      return [
        {
          ...common,
          op: "set-datetime",
          target: step.dtTarget ?? "next",
          spec: step.value ?? "",
        },
      ];

    case "verify-prefill": {
      const plan = step.audit;
      if (plan === undefined) return null;
      const controls: AxControlCheck[] = [];
      for (const raw of plan.controls) {
        if (raw.prefillKey === undefined) continue;
        const control = controlFor(raw);
        if (control === null) return null;
        controls.push(control);
      }
      if (controls.length === 0) return [];
      return [{ ...common, op: "verify-prefill", controls }];
    }

    case "audit-dialog": {
      const plan = step.audit;
      if (plan === undefined) return null;
      const controls: AxControlCheck[] = [];
      for (const raw of plan.controls) {
        const control = controlFor(raw);
        if (control === null) return null;
        controls.push(control);
      }
      const commitPath = plan.commits?.[0];
      const commit = commitPath === undefined ? null : dialogRefFor(commitPath);
      if (commitPath !== undefined && commit === null) return null;
      return [
        {
          ...common,
          op: "audit",
          controls,
          expect: expectationFor(plan.cadence),
          commit,
        },
      ];
    }

    // The OK press rides the audit's own script (RDLAT2 §4d), so it emits no op
    // of its own — the driver still names it in the trail, because it happened.
    case "press":
      return [];

    default:
      return null;
  }
}

/**
 * Compile a recipe's DIALOG-ENTRY steps into merged groups, or null when any of
 * them cannot be expressed structurally.
 *
 * `startIndex` is the first foldable step; every step before it keeps its own
 * hop and is driven by the existing dispatcher untouched.
 */
export function compileRawAxGroups(
  steps: readonly UiStep[],
  probePolls: boolean,
): { readonly startIndex: number; readonly groups: readonly AxGroup[] } | null {
  const startIndex = steps.findIndex((s) => FOLD_START.has(s.primitive));
  if (startIndex < 0) return null;

  const groups: AxGroup[] = [];
  let ops: AxOp[] = [];
  let members: UiStep[] = [];
  let commits = false;

  const flush = (): void => {
    if (members.length === 0) return;
    groups.push({ ops, steps: members, commits });
    ops = [];
    members = [];
    commits = false;
  };

  for (let i = startIndex; i < steps.length; i += 1) {
    const step = steps[i] as UiStep;
    if (isBoundary(step)) {
      // A node-side settle: it is not part of any group, and the driver runs it
      // exactly as it does today.
      flush();
      groups.push({ ops: [], steps: [step], commits: false });
      continue;
    }
    if (!FOLDABLE.has(step.primitive)) return null;
    const stepOps = opsForStep(step, probePolls);
    if (stepOps === null) return null;
    ops.push(...stepOps);
    members.push(step);
    if (
      step.primitive === "audit-dialog" &&
      stepOps.some((o) => o.op === "audit" && o.commit !== null)
    ) {
      commits = true;
    }
    if (endsGroup(step)) flush();
  }
  flush();
  return { startIndex, groups };
}
