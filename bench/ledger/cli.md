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

