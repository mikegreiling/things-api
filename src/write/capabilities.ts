/**
 * The operation × vector support table — lab-validated matrices flattened
 * for discovery. Shared by `things capabilities`, the MCP capabilities tool,
 * and library consumers.
 */
import { OPERATION_KINDS, type OperationKind } from "./operations.ts";
import { defaultVectors } from "./vectors/registry.ts";
import type { VectorId, VectorSupport } from "./vectors/types.ts";

export interface CapabilityEntry {
  op: OperationKind;
  vectors: ({ vector: VectorId } & (VectorSupport | { support: "no" }))[];
}

export function capabilitiesTable(op?: OperationKind): CapabilityEntry[] {
  const vectors = defaultVectors();
  const ops = op !== undefined ? [op] : [...OPERATION_KINDS];
  return ops.map((kind) => ({
    op: kind,
    vectors: vectors.map((v) => ({ vector: v.id, ...(v.matrix[kind] ?? { support: "no" }) })),
  }));
}
