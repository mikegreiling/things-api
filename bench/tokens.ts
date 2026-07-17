/**
 * Deterministic token estimation. The bench records real provider token usage on
 * live runs (from the assistant message usage), but static/dynamic context split and
 * pseudo-mode records need a provider-free estimate. ~4 chars/token is the standard
 * rough heuristic; good enough for the relative comparisons the metric ladder makes.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
