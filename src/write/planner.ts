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
  },
): Plan {
  const considered: { vector: VectorId; why: string }[] = [];
  const viable: PlanCandidate[] = [];

  for (const vector of vectors) {
    if (options.forcedVector !== undefined && vector.id !== options.forcedVector) continue;
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
