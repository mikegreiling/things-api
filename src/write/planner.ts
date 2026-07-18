/**
 * Vector selection under the disruption policy. Effective tier accounts for
 * the ensure-running step: when Things is closed, the pipeline background-
 * launches it first (tier 1) — required because both a plain `open` and an
 * AppleEvent to a closed Things steal focus (U01, A40/A41).
 */
import type { DisruptionTier } from "../config.ts";
import type { OperationKind } from "./operations.ts";
import type { VectorId, VectorSupport, WriteVector } from "./vectors/types.ts";

export interface PlanCandidate {
  vector: WriteVector;
  support: VectorSupport;
  /** Tier this call will actually incur, given current app state. */
  effectiveTier: DisruptionTier;
}

export type Plan =
  | { kind: "selected"; candidate: PlanCandidate }
  | { kind: "unsupported"; considered: { vector: VectorId; why: string }[] }
  | {
      kind: "tier-blocked";
      requiredTier: DisruptionTier;
      maxDisruption: DisruptionTier;
      considered: { vector: VectorId; tier: DisruptionTier }[];
    };

export function planVector(
  op: OperationKind,
  vectors: WriteVector[],
  options: {
    maxDisruption: DisruptionTier;
    appRunning: boolean;
    forcedVector?: VectorId;
    /** Config gate for `experimental: true` matrix entries (default off). */
    allowExperimental?: boolean;
  },
): Plan {
  const considered: { vector: VectorId; why: string }[] = [];
  const viable: PlanCandidate[] = [];

  for (const vector of vectors) {
    // A simulating vector stands in for EVERY transport (it applies structured
    // op/params as SQL, not a compiled payload), so a leg that forces a vector —
    // e.g. the repeating-project orchestrators forcing `ui`, or a `url-scheme`
    // coercion leg — must still resolve to the simulator under the bench fence.
    if (
      options.forcedVector !== undefined &&
      vector.id !== options.forcedVector &&
      vector.simulates !== true
    ) {
      continue;
    }
    const support = vector.matrix[op];
    if (support === undefined) {
      considered.push({ vector: vector.id, why: "no matrix entry for this operation" });
      continue;
    }
    if (support.support === "no") {
      considered.push({
        vector: vector.id,
        why: support.notes ?? "operation not supported by this vector",
      });
      continue;
    }
    if (support.validation !== "validated") {
      considered.push({
        vector: vector.id,
        why: `capability is ${support.validation} — not lab-validated`,
      });
      continue;
    }
    if (support.experimental === true && options.allowExperimental !== true) {
      considered.push({
        vector: vector.id,
        why:
          "rides an undocumented app surface — enable it with " +
          "`things config set allow-experimental true`",
      });
      continue;
    }
    const launchTier: DisruptionTier = options.appRunning ? 0 : 1;
    const effectiveTier = Math.max(support.disruption, launchTier) as DisruptionTier;
    viable.push({ vector, support, effectiveTier });
  }

  if (viable.length === 0) return { kind: "unsupported", considered };

  const allowed = viable.filter((c) => c.effectiveTier <= options.maxDisruption);
  if (allowed.length === 0) {
    const requiredTier = Math.min(...viable.map((c) => c.effectiveTier)) as DisruptionTier;
    return {
      kind: "tier-blocked",
      requiredTier,
      maxDisruption: options.maxDisruption,
      considered: viable.map((c) => ({ vector: c.vector.id, tier: c.effectiveTier })),
    };
  }

  // Lowest tier wins; registry order breaks ties.
  allowed.sort((a, b) => a.effectiveTier - b.effectiveTier);
  const winner = allowed[0];
  if (winner === undefined) return { kind: "unsupported", considered };
  return { kind: "selected", candidate: winner };
}
