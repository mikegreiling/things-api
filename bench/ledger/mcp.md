# AGENTBENCH refinement ledger — `mcp` arm

Append-only. One entry per candidate (accepted, reverted, or parked). See
[README.md](README.md) for the format and the cross-arm feed-forward rule.
<!-- ledger-entry id="loop-mcp-3-mcp-iter1" lesson="Make instruction edits narrowly testable, then require repeated gains on targeted tasks without regressions before attributing aggregate changes to the wording." -->
### 2026-07-18 · mcp · iter 1 · **REVERTED**

- **change:** A single conventions edit clarifies the misunderstood data-model boundaries: headings are project-scoped, Inbox is a vie — files: src/mcp/server.ts; diff 1 file(s) [src/mcp/server.ts], +8/-5
- **pre-hoc hypothesis:** A single conventions edit clarifies the misunderstood data-model boundaries: headings are project-scoped, Inbox is a view, effective tags require container inheritance, and todaySection is not list membership. It changes no execution behavior or write safety.
- **predicted blast radius:** Should reduce invalid area/project references, premature heading creation, incomplete effective-tag answers, and false Today classifications across read and compound tasks. Risk is limited to a small increase in static instruction tokens.
- **measured deltas (before → after):**
  - dev: success 25/33 → 23/33; friction 0.60 → 0.35; median tokIn 35945 → 36146
  - validation: success 3/6 → 3/6; friction 0.67 → 0.67; median tokIn 24072 → 24189
- **debrief:** attribution — The mixed deltas are most consistent with run variance rather than a reliable patch effect: the Inbox clarification plausibly drove the isolated 1/3→2/3 gain, but the effective-tags task never executed, validation was unchanged, and unrelated regressions provide no evidence of broad benefit. The small token increases on comparable runs match the added static instructions.; lesson — Make instruction edits narrowly testable, then require repeated gains on targeted tasks without regressions before attributing aggregate changes to the wording.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-mcp-3); checkpoint: bench/artifacts/loop-mcp-3/checkpoint.md

<!-- ledger-entry id="loop-mcp-3-mcp-iter2" lesson="Validate instruction refinements with repeated, nonzero-token trials that directly exercise the clarified semantics before attributing aggregate changes to the wording." -->
### 2026-07-18 · mcp · iter 2 · **REVERTED**

- **change:** One existing data-semantics convention is made operational and explicit. It addresses the recurring confusion between bu — files: src/mcp/server.ts; diff 1 file(s) [src/mcp/server.ts], +6/-4
- **pre-hoc hypothesis:** One existing data-semantics convention is made operational and explicit. It addresses the recurring confusion between built-in views and containers, direct and inherited tags, and todaySection versus actual view membership without adding workflow advice or changing behavior.
- **predicted blast radius:** Should reduce failed searches that use built-in view names as areas, improve effective-tag answers, and prevent active unscheduled items from being mislabeled as Today. It may modestly increase static instruction tokens. It does not directly alter compound-write behavior, avoiding risky or task-specific mutation guidance.
- **measured deltas (before → after):**
  - dev: success 25/33 → 24/33; friction 0.60 → 0.50; median tokIn 35945 → 36043
  - validation: success 3/6 → 4/6; friction 0.67 → 0.25; median tokIn 24072 → 24032
- **debrief:** attribution — The clarification produced no measurable targeted gain: effective-tag reasoning remained 0/3 with zero-token runs, while most completed tasks were unchanged apart from the expected small instruction-token increase. The Inbox regression also had zero tokens after the patch, so it is more consistent with a run anomaly than the wording change; the isolated validation gain and large compound-task efficiency improvement are insufficiently linked to this diff and likely reflect variance.; lesson — Validate instruction refinements with repeated, nonzero-token trials that directly exercise the clarified semantics before attributing aggregate changes to the wording.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-mcp-3); checkpoint: bench/artifacts/loop-mcp-3/checkpoint.md

<!-- ledger-entry id="loop-mcp-1-mcp-iter1" lesson="Operational conventions (resolve-then-pass dates, dry-run creates no state, direct-vs-effective tags, view-state semantics) in server instructions moved mini-class success where per-tool copy nudges did not." -->
### 2026-07-17 · mcp · iter 1 (batch loop-mcp-1) · **ACCEPTED — RECONSTRUCTED**

- **provenance:** this entry was reconstructed by the orchestrator after the batch process was externally killed mid-iteration-2 (before batch-end ledger writing); the accept decision and commit (3037621) are the loop's own, gated normally. No post-hoc debrief exists (the debrief call never ran).
- **change:** buildInstructions() conventions — resolve relative calendar phrases against the exposed Calendar/clock context then pass explicit dates; dry-run previews create no state (later calls cannot reference dry-run-only items); direct vs effective (inherited) tags; todaySection ≠ membership in Today; open unscheduled start=active ⇒ Anytime; completed ⇒ Logbook; pass limit OR all:true, never both; clock exposed in startup instructions. Files: src/mcp/server.ts, +15/-3.
- **pre-hoc hypothesis:** compact conventions clarification for the recurring model and argument errors, plus exposing the existing effective clock in startup instructions; changes no mutation behavior, avoids task-specific wording.
- **measured deltas (before → after, from bench/artifacts/loop-mcp-1/bench/{1,2}):**
  - dev: success 21/33 → 25/33; friction 0.33 → 0.40; median tokIn 35406 → 35945
  - validation: success 2/6 → 3/6; friction 0.00 → 0.33; median tokIn 23652 → 23968
- **debrief:** (lost to the kill — see provenance)
- **artifacts:** bench/artifacts/loop-mcp-1/ (killed batch; no checkpoint); stability corroborated by batch loop-mcp-3 (checkpoint.md: dev held 25/33 across 2 further reverted candidates; holdout 5/6).
