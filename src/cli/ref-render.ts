/**
 * The CLI's process-wide render-time ref promoter — the same module-state
 * pattern the render clock (./clock.ts) and width fit (./width.ts) use. The read
 * driver sets it (from `client.refPromoter()`) before rendering human output and
 * clears it after, so the pure renderers can decide whether an INLINE container
 * hint should promote its uuid prefix — `(Family)` → `(Family [TC9yozLk])` —
 * using the SAME round-trip predicate the JSON `*Uuid` promotion uses (no fork).
 * Unset (the default, and in unit tests that import the renderers directly) it is
 * null, so a container hint stays the bare `(title)` — byte-identical output.
 */
import type { RefPromoter } from "../index.ts";

let promoter: RefPromoter | null = null;

export function setRenderRefPromoter(p: RefPromoter | null): void {
  promoter = p;
}

/** The active render-time promoter, or null (host default — no inline promotion). */
export function renderRefPromoter(): RefPromoter | null {
  return promoter;
}
