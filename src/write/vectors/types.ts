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
  | "wait"
  | "key";

export interface UiStep {
  primitive: UiPrimitive;
  /** Human-readable step label — surfaced in the partial-state report. */
  label: string;
  /** System Events element path (semantic) for resolve/press/set-value/wait. */
  path?: string;
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
}
