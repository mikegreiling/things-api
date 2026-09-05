/**
 * RAWAX1 — the Repeat drive as an ordered list of AX OPERATIONS.
 *
 * WHY A LIST AND NOT A SCRIPT. The obvious port is "rewrite each generated
 * AppleScript in JXA", and it would work — and it would bake the transport into
 * the recipe layer a second time, which is what makes the first one expensive to
 * change. So a recipe step compiles instead to plain JSON: an ordered list of
 * operations over STRUCTURED element descriptors, carrying the measured
 * addressing laws as DATA rather than as generated text.
 *
 * Two properties follow, and both are the point.
 *
 *  1. **The executor is data-driven.** {@link renderRawAxScript} emits ONE JXA
 *     script — the primitive layer, the op list as a JSON literal, and a small
 *     interpreter. A future deputy-side executor (Swift, in-process, no
 *     `osascript` at all) interprets the identical list, because the list holds
 *     no AppleScript and no JavaScript. That door is left open by construction
 *     rather than by intention.
 *  2. **Every discrimination law is preserved as data.** `{ field: "group",
 *     target: "interval" }` IS the CGRD1 §A law; `tolerance` is `ROW_TOLERANCE`;
 *     `{ in: "group", role: "AXPopUpButton", ordinal: 2 }` is the measured index
 *     RAWAX1-1 proved carries across the transport. The interpreter fails closed
 *     on anything but exactly one match and reports the same inventory the
 *     AppleScript handlers report, in the same words.
 *
 * AND IT IS WHAT MAKES THE HOP MERGE AFFORDABLE. RDLAT2 §10 declined to fold the
 * frequency/unit/interval hops together on the grounds that folding costs the
 * per-step trace granularity and per-step failure attribution that make field
 * reports readable. Every op here reports itself — label, duration, calls,
 * elements, verdict — so node gets strictly more than a hop boundary gave it,
 * and the objection does not survive the change of transport.
 */
import type { CadenceExpectation } from "./ui-shape.ts";
import type { RepeatDialogShape } from "./types.ts";

/**
 * WHERE AN OPERATION'S TARGET LIVES — a structured address, never a path string.
 *
 * Every form here is a measured law rather than a spelling. The `ordinal` forms
 * are the ones RAWAX1-1 licensed: the role-filtered `AXChildren` ordinal IS
 * System Events' `<class> N` index, in all five dialog states, so the indices
 * `ui-recipes.ts` certified port unchanged — and stay fenced by the same
 * `positional-ok:` discipline, which `test/unit/positional-addressing.test.ts`
 * now enforces on this shape too.
 */
export type ElementRef =
  /** The dialog shell itself (attached sheet or detached editor — resolved live). */
  | { readonly at: "shell" }
  /** The cadence group: the shell's only `AXGroup` (CGRD1 §B census). */
  | { readonly at: "group" }
  /** A menu-bar item by pinned English path, e.g. `["Items", "Repeat…"]`. */
  | { readonly at: "menu"; readonly path: readonly string[] }
  /** The Nth control of a role inside a container — the RAWAX1-1 ordinal. */
  | {
      readonly in: "shell" | "group";
      readonly role: string;
      readonly ordinal: number;
      /** Why this ordinal is safe — the `positional-ok:` justification, as data. */
      readonly because: string;
    }
  /** A control of a role carrying an exact pinned English title. */
  | { readonly in: "shell" | "group"; readonly role: string; readonly title: string }
  /** A cadence numeric field, addressed by the CGRD1 §A label-row law. */
  | {
      readonly field: "group";
      readonly target: "interval" | "ends-count";
      readonly tolerance: number;
    }
  /** A shell text field addressed by the pinned English label sharing its row. */
  | { readonly field: "shell"; readonly rowLabel: string; readonly tolerance: number }
  /** One of the dialog's `AXDateTimeArea`s, by the ANCH2 discriminator. */
  | { readonly dateArea: "next" | "ends" | "reminder" };

/** One control the pre-commit audit or the verify-by-read hop reads. */
export interface AxControlCheck {
  /** Human name of the control, as a mismatch report should say it. */
  readonly label: string;
  readonly ref: ElementRef;
  /** How the value is read and compared. */
  readonly kind: "popup" | "checkbox" | "number" | "occurrence" | "weekdays" | "date-area";
  /** Accepted observed values — ANY one satisfies (the singular/plural pair). */
  readonly expected: readonly string[];
  /** How the intended value should READ in the report ("checked", not "1"). */
  readonly expectedLabel?: string;
  /** weekdays: the group pop-up ordinal of the first weekday row. */
  readonly weekdayBase?: number;
  /** date-area: `date:YYYY-MM-DD` or `time:HH:mm`. */
  readonly spec?: string;
  /** verify-by-read only: the pre-fill key this control answers for. */
  readonly prefillKey?: string;
}

/**
 * ONE OPERATION. Every op carries its own `label` (what the trace and any
 * refusal call it) and may carry `unlessPrefilled` — the DEFAULTS2 tag whose
 * actuation the verify op's verdict can skip. The step stays in the list either
 * way, so it still contributes its control to the audit: dropping it here would
 * silently shrink the audit, which is how this optimization would become the
 * #589 class wearing a new hat.
 */
export type AxOp = { readonly label: string; readonly unlessPrefilled?: string } &
  /** Assert the shell's direct-child role census — the shape manifest's gate. */
  (
    | { readonly op: "census-shell"; readonly expectRoles: true }
    /**
     * Measure which Repeat dialog is open (RDLG2). `poll` false is the single-round
     * form a live sidecar — or, since DEPOBS3, a routed host whose NODE already
     * waited out the cadence rebuild — has always generated.
     */
    | { readonly op: "probe-shape"; readonly tolerance: number; readonly poll: boolean }
    /** Wait for the cadence group to stop re-laying out (the BEEP1 agreement gate). */
    | {
        readonly op: "settle-group";
        readonly expect: CadenceExpectation | null;
        readonly reads: number;
        readonly pollMs: number;
      }
    /** Open a pop-up and press the first candidate item that exists. */
    | { readonly op: "select-popup"; readonly ref: ElementRef; readonly titles: readonly string[] }
    /** Converge a checkbox to a target state — read, press only on a mismatch, confirm. */
    | {
        readonly op: "ensure-checkbox";
        readonly ref: ElementRef;
        readonly target: boolean;
        readonly attempts: number;
      }
    /**
     * THE TYPING LOOP, entire (RAWAX1-2): focus, prove focus, keystroke,
     * Tab-commit, read back, retry. It is here rather than an attribute write
     * because the attribute write is a repaint — measured against the committed
     * rule, not inferred.
     */
    | {
        readonly op: "type-into";
        readonly ref: ElementRef;
        readonly value: string;
        readonly what: string;
        readonly attempts: number;
      }
    /** Converge the weekly dialog's weekday rows onto an exact target set (RRD1). */
    | {
        readonly op: "converge-weekdays";
        readonly base: number;
        readonly titles: readonly string[];
      }
    /** Set an `AXDateTimeArea` through the ObjC bridge (the one write that always was raw). */
    | {
        readonly op: "set-datetime";
        readonly target: "next" | "ends" | "reminder";
        readonly spec: string;
      }
    /** Pick the 3.23 `Next:` occurrence from its bounded menu, by PARSED date. */
    | {
        readonly op: "select-occurrence";
        readonly ref: ElementRef;
        readonly iso: string;
        readonly levels: number;
        readonly sampleItems: number;
      }
    /** Read every control the seed row should have pre-filled and report per key. */
    | { readonly op: "verify-prefill"; readonly controls: readonly AxControlCheck[] }
    /** Re-read every control this drive set, and COMMIT when they all agree. */
    | {
        readonly op: "audit";
        readonly controls: readonly AxControlCheck[];
        readonly expect: CadenceExpectation | null;
        readonly commit: ElementRef | null;
      }
  );

/** What the executor is handed: an ordered op list plus the drive-level context. */
export interface AxProgram {
  /**
   * The shell the `dialog-open` census banked, or null when the drive never
   * banked one (an app build the shape manifest was never sat with). Null means
   * the executor resolves the shell in the shipped priority order instead.
   */
  readonly shellIndex: number | null;
  /** The measured dialog shape, or null when no shape-dependent op is present. */
  readonly shape: RepeatDialogShape | null;
  readonly ops: readonly AxOp[];
}

/**
 * ONE OP'S RECORD, as the executor reports it and node parses it back.
 *
 * This is the structure that replaces a hop boundary. `durationMs`, `axCalls`
 * and `axElems` are what the per-hop trace carried; `verdict` and `detail` are
 * more than it carried, because a hop could only say "ok" or "not ok" and this
 * says which control, with what value, under which law.
 */
export interface AxOpRecord {
  readonly label: string;
  readonly op: string;
  readonly durationMs: number;
  readonly axCalls: number;
  readonly axElems: number;
  /** `ok` · `skipped` (pre-filled, or already correct) · `refused` · `failed`. */
  readonly verdict: "ok" | "skipped" | "refused" | "failed";
  /** Why, in the words the caller should read. Present on anything but `ok`. */
  readonly detail?: string;
  /** verify-prefill only: the keys the dialog CONFIRMED. */
  readonly confirmed?: readonly string[];
  /** verify-prefill only: what each unconfirmed key actually showed. */
  readonly missed?: readonly string[];
  /** probe-shape only: the measured verdict. */
  readonly shape?: string;
}

/**
 * Parse the executor's per-op report out of a hop's stderr, and REMOVE it.
 *
 * Same contract as `parseElemLog` and `parseSettleLog`: a refusal a caller reads
 * must never carry the machinery, and a line that does not parse is dropped
 * rather than guessed at.
 */
export function parseRawAxReport(
  stderr: string,
  prefix: string,
): { records: AxOpRecord[]; stderr: string } {
  const kept: string[] = [];
  const records: AxOpRecord[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(prefix)) {
      kept.push(line);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line.slice(prefix.length));
      if (parsed !== null && typeof parsed === "object") records.push(parsed as AxOpRecord);
    } catch {
      // A record that does not parse is machinery either way: it is not a
      // caller-facing sentence, so it is dropped rather than surfaced.
    }
  }
  return { records, stderr: kept.join("\n") };
}

/**
 * The `positional-ok:` justifications for every ordinal address the compiler
 * emits, in ONE place so the fence is reviewable as a list rather than hunted
 * through generated text.
 *
 * Each is the measured reason from CGRD1 §A/§B and RAWAX1 §5.1, and each is
 * carried into the op list as `because`, so a refusal or a review can quote the
 * evidence for the index it used.
 */
export const ORDINAL_JUSTIFICATIONS = {
  frequency:
    "positional-ok: the shell's ONLY direct pop-up in every reachable state " +
    "(CGRD1 §B census: popups=1, all four frequencies + after-completion); " +
    "RAWAX1-1 re-measured the same ordinal through the raw API",
  acUnit:
    "positional-ok: an after-completion cadence group has popups=1 and no " +
    "`Ends:` label at all (CGRD1 §A), so this is the sole pop-up of a state the " +
    "recipe emits exactly one of; its item set is disjoint from the ends bound's",
  ends:
    "positional-ok: the ends bound is group pop-up 1 in every FIXED frequency " +
    "(CGRD1 §A; RAWAX1-1 read `never` first in AXChildren order in all four)",
  nextPopup:
    "positional-ok: the 3.23 `Next:` occurrence pop-up is group pop-up 2, " +
    "reachable only under a MEASURED `next-popup` shape (RAWAX1-1 read `Today` " +
    "second in AXChildren order in all four fixed frequencies)",
  anchor:
    "positional-ok: the shape-MEASURED index CGRD1 §A counts per frequency " +
    "(daily 2 · weekly 3 · monthly 4 · yearly 5 group pop-ups); RAWAX1-1 " +
    "confirmed monthly mode/ordinal at 3/4 and yearly month/mode/ordinal at 3/4/5",
} as const;
