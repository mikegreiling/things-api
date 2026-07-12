/**
 * Write-vector abstraction. Vectors are pluggable executors whose
 * per-operation support/disruption/validation metadata is DATA shipped from
 * the lab (url-scheme.matrix / applescript.matrix), never hardcoded logic.
 */
import type { DisruptionTier } from "../../config.ts";
import type { OperationKind } from "../operations.ts";

export type VectorId = "url-scheme" | "applescript" | "shortcuts";

export interface CompiledInvocation {
  vector: VectorId;
  kind: "open-url" | "osascript" | "shortcuts-run";
  /**
   * The exact payload executed (URL or AppleScript source). For the
   * shortcuts-run kind this is a human-readable rendering of the run — the
   * executor reads `shortcut`/`input` instead.
   */
  payload: string;
  /** Payload with secrets replaced — safe for dry-run output and errors. */
  redactedPayload: string;
  /** shortcuts-run only: the proxy shortcut to invoke (`shortcuts run <name>`). */
  shortcut?: string;
  /** shortcuts-run only: the JSON-serializable input dict piped to the shortcut. */
  input?: unknown;
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
