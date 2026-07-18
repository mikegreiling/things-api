# AGENTBENCH refinement ledger — `cli` arm

Append-only. One entry per candidate (accepted, reverted, or parked). See
[README.md](README.md) for the format and the cross-arm feed-forward rule.
<!-- ledger-entry id="loop-cli-1-cli-iter1" lesson="Expose canonical output structure at the earliest discovery surface, but require consistent cross-split gains before treating a small documentation clarification as a general fix." -->
### 2026-07-18 · cli · iter 1 · **REVERTED**

- **change:** The dominant cross-task failure is misreading the universal JSON envelope, especially using .items or .item and then con — files: src/cli/help.ts; diff 1 file(s) [src/cli/help.ts], +1/-1
- **pre-hoc hypothesis:** The dominant cross-task failure is misreading the universal JSON envelope, especially using .items or .item and then constructing empty references. Naming the exact result path in the top-level help fixes that root cause at the first surface every agent inspected, without changing command behavior.
- **predicted blast radius:** Should improve all JSON-backed reads and writes, especially ID extraction in compound tasks and structured-answer tasks. It adds only one short top-level help clarification; no state-changing behavior or GUI semantics change.
- **measured deltas (before → after):**
  - dev: success 24/33 → 24/33; friction 0.71 → 0.75; median tokIn 7584 → 9151
  - validation: success 0/6 → 1/6; friction 0.00 → 0.00; median tokIn 0 → 5970
- **debrief:** attribution — The explicit .data guidance likely prevented some envelope-path mistakes, matching gains on two dev tasks and one validation task, but it produced no net dev success increase and coincided with regressions and higher token use elsewhere; the evidence supports a narrow, noisy benefit rather than the predicted broad improvement.; lesson — Expose canonical output structure at the earliest discovery surface, but require consistent cross-split gains before treating a small documentation clarification as a general fix.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-cli-1); checkpoint: bench/artifacts/loop-cli-1/checkpoint.md

<!-- ledger-entry id="loop-cli-1-cli-iter2" lesson="Place critical contract details at discovery points, but keep global signposts concise and verify gains across task families rather than inferring broad impact from a few failures." -->
### 2026-07-18 · cli · iter 2 · **REVERTED**

- **change:** Two failed tasks share the same root cause: agents correctly selected commands but guessed a conventional .items/.item J — files: src/cli/help.ts; diff 1 file(s) [src/cli/help.ts], +3/-1
- **pre-hoc hypothesis:** Two failed tasks share the same root cause: agents correctly selected commands but guessed a conventional .items/.item JSON shape instead of the documented envelope's .data payload. Putting the shape directly on the top-level --json signpost is the smallest general fix and also clarifies how to interpret omitted optional fields.
- **predicted blast radius:** Improves JSON parsing for every read and write command, especially compound scripts that capture UUIDs and list queries consumed with jq. It may also help reasoning over entities with omitted container fields. No command behavior or database mutation semantics change; risk is limited to a slightly longer top-level help line.
- **measured deltas (before → after):**
  - dev: success 24/33 → 22/33; friction 0.71 → 0.55; median tokIn 7584 → 10472
  - validation: success 0/6 → 2/6; friction 0.00 → 1.00; median tokIn 0 → 8305
- **debrief:** attribution — The explicit `.data` guidance likely reduced schema-guessing in some complex flows and contributed to the validation gain, but it did not generalize: dev success fell from 24/33 to 22/33, with broad token inflation and read-task regressions. The mixed result suggests a useful clarification packaged into an overly dense global signpost, compounded by small-sample variance.; lesson — Place critical contract details at discovery points, but keep global signposts concise and verify gains across task families rather than inferring broad impact from a few failures.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-cli-1); checkpoint: bench/artifacts/loop-cli-1/checkpoint.md

<!-- ledger-entry id="loop-cli-r2-cli-iter1" lesson="Document machine-readable output shapes at the earliest discovery surface, naming both the wrapper and the exact payload path." -->
### 2026-07-18 · cli · iter 1 · **ACCEPTED**

- **change:** The repeated cross-family root cause is assuming a conventional top-level .items array. This one-line clarification plac — files: src/cli/help.ts; diff 1 file(s) [src/cli/help.ts], +3/-1
- **pre-hoc hypothesis:** The repeated cross-family root cause is assuming a conventional top-level .items array. This one-line clarification places the canonical envelope structure at the earliest surface every failing agent consulted, without changing command behavior or adding workflow advice.
- **predicted blast radius:** Should reduce empty jq results and downstream malformed writes across list, search, trash, snapshot, and mutation tasks, especially compound-garden-shed, longtail-trash-restore, longtail-undo-rename, and reads-inbox-count. It adds only a few static tokens and has no state-change risk. It will not address the independently identified checklist, project-count, or verb-hint defects.
- **measured deltas (before → after):**
  - dev: success 38/54 → 44/54; friction 0.66 → 0.59; median tokIn 12307 → 12324
  - validation: success 7/18 → 9/18; friction 0.14 → 0.44; median tokIn 9782 → 9479
- **debrief:** attribution — The explicit JSON-envelope schema most likely prevented some agents from querying a nonexistent top-level array, contributing to the net success gain (dev +6, validation +2), especially on structured-output workflows; mixed regressions and large token swings indicate substantial run variance, so not all changes are attributable to the patch.; lesson — Document machine-readable output shapes at the earliest discovery surface, naming both the wrapper and the exact payload path.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-cli-r2); checkpoint: bench/artifacts/loop-cli-r2/checkpoint.md

<!-- ledger-entry id="loop-cli-r2-cli-iter2" lesson="Document ambiguous output schemas at the command’s discovery point, but keep guidance compact and validate across splits to distinguish targeted reasoning gains from stochastic regressions." -->
### 2026-07-18 · cli · iter 2 · **REVERTED**

- **change:** The two domain-reasoning failures share one data-model gap: agents used or saw to-do detail without knowing where it liv — files: src/cli/commands/show.ts; diff 1 file(s) [src/cli/commands/show.ts], +5/-2
- **pre-hoc hypothesis:** The two domain-reasoning failures share one data-model gap: agents used or saw to-do detail without knowing where it lives in the show envelope or how direct tags, inherited tags, and absent containers are represented. Adding that contract at the show discovery point is the smallest generalizable documentation change and does not alter execution.
- **predicted blast radius:** Should improve tasks that determine a to-do's effective tags or container membership after resolving it through search/show. It adds only a short help paragraph and makes no state-changing behavior; risk is limited to a small help-token increase.
- **measured deltas (before → after):**
  - dev: success 44/54 → 40/54; friction 0.59 → 0.70; median tokIn 12324 → 9991
  - validation: success 9/18 → 15/18; friction 0.44 → 0.60; median tokIn 9479 → 11231
- **debrief:** attribution — The added show-envelope schema guidance most likely drove the gains in inheritance and missing-container reasoning, especially on validation; because execution was unchanged and unrelated dev tasks regressed inconsistently, those losses are more plausibly run variance or extra discovery distraction than a behavioral defect.; lesson — Document ambiguous output schemas at the command’s discovery point, but keep guidance compact and validate across splits to distinguish targeted reasoning gains from stochastic regressions.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-cli-r2); checkpoint: bench/artifacts/loop-cli-r2/checkpoint.md

<!-- ledger-entry id="loop-cli-r2-cli-iter3" lesson="Add concise guidance at the main discovery point, but judge it by replicated gains in the targeted task family rather than noisy suite-wide movement." -->
### 2026-07-18 · cli · iter 3 · **REVERTED**

- **change:** The highest-priority failure is an unintended duplicate area creation. One concise discovery-point contract distinguishe — files: src/cli/help.ts; diff 1 file(s) [src/cli/help.ts], +3/-0
- **pre-hoc hypothesis:** The highest-priority failure is an unintended duplicate area creation. One concise discovery-point contract distinguishes creation from selecting an existing container and simultaneously exposes the namespaced write grammar that caused repeated bare-verb errors.
- **predicted blast radius:** Should prevent duplicate container creation and reduce errors in compound creation tasks, bare add tasks, and other writes involving --area or --project. It adds one help signpost only; command behavior and database semantics are unchanged.
- **measured deltas (before → after):**
  - dev: success 44/54 → 38/54; friction 0.59 → 0.92; median tokIn 12324 → 11981
  - validation: success 9/18 → 11/18; friction 0.44 → 0.82; median tokIn 9479 → 8694
- **debrief:** attribution — The signpost likely improved discovery of namespaced writes and existing-container selection, matching gains in the targeted validation cases; however, the overall success decline is dispersed across unrelated tasks and, with only three runs each and no behavior change, is more consistent with run variance than a systematic patch effect.; lesson — Add concise guidance at the main discovery point, but judge it by replicated gains in the targeted task family rather than noisy suite-wide movement.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-cli-r2); checkpoint: bench/artifacts/loop-cli-r2/checkpoint.md

