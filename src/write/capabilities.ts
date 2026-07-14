/**
 * The operation × vector support table — lab-validated matrices flattened
 * for discovery. Shared by `things capabilities`, the MCP capabilities tool,
 * and library consumers.
 */
import { OPERATION_KINDS, type OperationKind } from "./operations.ts";
import { REVERSIBILITY, type ReversibilityEntry } from "./reversibility.ts";
import { certificationOf, type CertificationEntry } from "./vectors/ui-certification.ts";
import { defaultVectors } from "./vectors/registry.ts";
import type { VectorId, VectorSupport } from "./vectors/types.ts";

export interface CapabilityEntry {
  op: OperationKind;
  /** What `things undo` can do with this operation afterward (test-locked per op). */
  undo: ReversibilityEntry;
  vectors: ({ vector: VectorId } & (VectorSupport | { support: "no" }))[];
  /**
   * ui-vector ops only: the on-device certification status. `uncertified`
   * means the GUI recipe is wired but not yet confirmed on real hardware (see
   * docs/lab/ui-certification-runbook.md); the op still runs, but a successful
   * drive carries a warning to that effect.
   */
  certification?: CertificationEntry;
}

export function capabilitiesTable(op?: OperationKind): CapabilityEntry[] {
  const vectors = defaultVectors();
  const ops = op !== undefined ? [op] : [...OPERATION_KINDS];
  return ops.map((kind) => {
    const cert = certificationOf(kind);
    const entry: CapabilityEntry = {
      op: kind,
      undo: REVERSIBILITY[kind],
      // oxlint-disable-next-line no-map-spread -- building fresh capability rows, not mutating
      vectors: vectors.map((v) => ({ vector: v.id, ...(v.matrix[kind] ?? { support: "no" }) })),
    };
    if (cert !== undefined) entry.certification = cert;
    return entry;
  });
}
