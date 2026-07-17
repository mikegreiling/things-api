/**
 * Write-vector abstraction. Vectors are pluggable executors whose
 * per-operation support/disruption/validation metadata is DATA shipped from
 * the lab (url-scheme.matrix / applescript.matrix), never hardcoded logic.
 */
import type { DisruptionTier } from "../../config.ts";
import type { OperationKind } from "../operations.ts";

export type VectorId = "url-scheme" | "applescript" | "shortcuts" | "ui";

export interface CompiledInvocation {
  vector: VectorId;
  kind: "open-url" | "osascript" | "shortcuts-run" | "ui-drive";
  /**
   * The exact payload executed (URL or AppleScript source). For the
   * shortcuts-run kind this is a human-readable rendering of the run — the
   * executor reads `shortcut`/`input` instead. For the ui-drive kind this is
   * a human-readable rendering of the recipe — the executor reads `recipe`.
   */
  payload: string;
  /** Payload with secrets replaced — safe for dry-run output and errors. */
  redactedPayload: string;
  /** shortcuts-run only: the proxy shortcut to invoke (`shortcuts run <name>`). */
  shortcut?: string;
  /** shortcuts-run only: the JSON-serializable input dict piped to the shortcut. */
  input?: unknown;
  /** ui-drive only: the ordered Accessibility recipe the driver executes. */
  recipe?: UiRecipe;
  /**
   * STRUCTURED input for the simulator write vector (bench harness): the
   * resolved operation kind and its (uuid/when-normalized) params. Populated by
   * the pipeline right after {@link CommandSpec.compile}; the real transport
   * vectors ignore them entirely. They exist so a synthetic SQL applier never
   * has to reverse-engineer the payload URL / AppleScript to learn the intent.
   */
  op?: OperationKind;
  /** @see op — the resolved params object for the simulator applier. */
  opParams?: unknown;
}

/**
 * A compiled Accessibility recipe: the target to reveal plus an ordered list
 * of element-addressed steps. Element paths are SEMANTIC (System Events),
 * never coordinates. Every path is marked provisional-pending-certification
 * in its source (see docs/design/ui-vector.md).
 */
export interface UiRecipe {
  op: OperationKind;
  /** The item the recipe acts on (revealed/selected via things:///show?id=). */
  targetUuid: string;
  steps: UiStep[];
}

export type UiPrimitive =
  | "reveal"
  | "activate"
  | "resolve"
  | "press"
  | "set-value"
  | "select-popup"
  | "wait"
  | "key"
  /**
   * Synthesize a MOUSE click at an AX-resolved element's frame center (the
   * NATIVE1 JXA ObjC-bridge / HID-tap primitive). Used ONLY for Things' custom
   * `…` menu / repeat-bar popover, whose items are AX-readable but inert to
   * AXPress (UIC2). The frame is read from the live AX tree (`position`/`size`)
   * — never a guessed pixel — so a resolution miss fails closed exactly like a
   * canaried AX press. Requires Things frontmost (the HID tap posts to the
   * foreground surface, NATIVE1-e), so a recipe using it must activate first.
   */
  | "click-element"
  /**
   * Synthesize a MOUSE DRAG that reorders a sidebar AREA row (the AXDRAG1
   * primitive). The driver resolves the source row and the destination slot
   * boundary from the live AX tree per gesture, pre-scrolls (or multi-hops)
   * when the sidebar is longer than the viewport, and asserts the database
   * order after every gesture — see src/write/vectors/ui-drag.ts. Foreground-
   * bound like click-element.
   */
  | "drag-reorder"
  /**
   * Select a PROJECT as a content-table ROW by matching its title, purely via
   * AX (UIC4-a): the content table's `AXSelectedRows` is settable, so the
   * driver walks the table's rows, sets each as the selection, and reads back
   * `Things3 → name of selected to dos` — leaving the row whose readback equals
   * the target title selected, or reporting no match. Coordinate-free and
   * background-capable (no focus steal); the readback IS the
   * selection-landed verification. `path` is the content table; `value` the
   * title to match.
   */
  | "select-row"
  /**
   * Select a HEADING as a content-table ROW by POSITION, purely via AX
   * (HEADCERT1). A heading is not `things:///show`-selectable and its row
   * exposes no stable AX title handle (only a hover-dependent "More" affordance
   * carries the title), so identity is positional: the driver walks the
   * revealed PROJECT view's content table and selects the Nth row that is
   * genuinely selectable (`AXSelected` lands) AND reads back an EMPTY
   * `Things3 → name of selected to dos` — the signature of a heading, since a
   * heading is not a to-do (a to-do row's readback is its title; header/spacer
   * rows do not take selection). Coordinate-free and background-capable. `path`
   * is the content table; `value` the 0-based heading ordinal (its position
   * among the project's headings in `index` order). With the heading selected,
   * `Items ▸ Convert to Project…` enables.
   */
  | "select-heading-row"
  /**
   * Set the Repeat dialog's date/time control (the reminder time, the "ends on
   * date" bound) — an `AXDateTimeArea` whose value is an NSDate, NOT a text
   * field (UIC6). System Events cannot set it (`set value … to <date>` errors
   * -10000), so the driver sets `AXValue` to an NSDate through the ObjC bridge
   * (JXA), the same bridge the mouse-synthesis primitive rides. `value` is the
   * spec: `time:HH:mm` (keep the control's date, set the time-of-day, for the
   * reminder) or `date:YYYY-MM-DD` (set the calendar date, for the end bound).
   * The control is located by role within the open dialog and fails closed if
   * it is absent.
   */
  | "set-datetime";

export interface UiStep {
  primitive: UiPrimitive;
  /** Human-readable step label — surfaced in the partial-state report. */
  label: string;
  /** System Events element path (semantic) for resolve/press/set-value/wait. */
  path?: string;
  /**
   * Alternative element paths, tried in order — the driver dispatches against
   * the FIRST that resolves at run time (fail-closed if none do). Used where a
   * control has two equally-valid shapes: the make-repeating Repeat editor is
   * an attached `AXSheet` when Things is frontmost but a DETACHED top-level
   * `AXUnknown` window when backgrounded (UIC4-a), and its controls sit at
   * different depths in each form. Overrides `path` when present.
   */
  pathCandidates?: string[];
  /**
   * Preflight-canary path when the step's own `path` is not statically
   * resolvable (a nested submenu item only populates once its parent opens):
   * the canary resolves this first-level ancestor instead, still catching a
   * menu that a Things update renamed or removed. Falls back to `path`.
   */
  canaryPath?: string;
  /** set-value: the string typed into the field. */
  value?: string;
  /** key: a keyboard spec (e.g. "down down return" for a dropdown pick). */
  keys?: string;
  /** wait: how long to poll for the element before aborting. */
  timeoutMs?: number;
  /**
   * click-element only: the element expected to appear right AFTER the click
   * (a popover opening, a sheet appearing). The driver polls for it and, on
   * mismatch, sends Escape to dismiss whatever DID open and aborts fail-closed
   * — so a click that lands somewhere unexpected never cascades into blind
   * presses. Omitted for a TERMINAL click (one that dismisses the popover with
   * no successor element); the write pipeline's read-after-write check is the
   * outcome verifier there.
   */
  assertPath?: string;
  /** click-element only: human-readable name of the asserted element (report). */
  assertLabel?: string;
  /** click-element only: how long to poll for `assertPath` before aborting. */
  assertTimeoutMs?: number;
  /**
   * The element appears only AFTER a preceding press (a sheet/popover), so it
   * is NOT resolvable in the preflight canary — the driver waits for it at run
   * time instead. Static steps (menu-bar paths) are canary-resolved up front.
   */
  dynamic?: boolean;
  /** How the element is addressed — pinned English title, or a stable AXIdentifier. */
  addressing?: "title" | "axidentifier";
  /**
   * activate only: this foregrounding step is a fallback that may be skipped
   * once certification proves background AXPress works (see the runbook).
   */
  activateFallback?: boolean;
  /** drag-reorder only: the sidebar move the drag driver performs. */
  drag?: import("./ui-drag.ts").SidebarDragSpec;
}

export interface VectorSupport {
  support: "yes" | "partial" | "no";
  /**
   * Disruption tier observed by the lab WITH THINGS ALREADY RUNNING. The
   * pipeline guarantees that state via its ensure-running step (an
   * AppleEvent or plain open to a closed Things steals focus — A40/A41).
   */
  disruption: DisruptionTier;
  validation: "validated" | "assumed" | "unvalidated";
  /** Probe ids backing this entry (u-suite / a-suite evidence). */
  evidence?: string[];
  /**
   * Rides an UNDOCUMENTED app surface (e.g. `_private_experimental_` sdef
   * commands). Requires config allowExperimental AND the pipeline's sdef
   * canary — the surface can vanish in any Things update.
   */
  experimental?: boolean;
  notes?: string;
}

export type VectorMatrix = Partial<Record<OperationKind, VectorSupport>>;

export interface ExecuteResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** The transport was killed by its own deadline — the signature of an unanswered consent dialog. */
  timedOut?: boolean;
}

export interface WriteVector {
  id: VectorId;
  matrix: VectorMatrix;
  execute(invocation: CompiledInvocation): Promise<ExecuteResult>;
  /**
   * The bench-harness SIMULATOR vector (src/write/vectors/simulator.ts). It
   * presents under a real {@link VectorId} but applies mutations via SQL from
   * the structured `invocation.op`/`opParams`, never from a compiled payload.
   * A single VectorId cannot satisfy the transport-specific `spec.compile` of
   * EVERY operation (some are url-scheme-only, others applescript/shortcuts), so
   * the pipeline SKIPS compile for a simulator and hands it structured input
   * directly. Undefined/false for every real transport vector.
   */
  simulates?: boolean;
}
