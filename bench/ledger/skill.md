# AGENTBENCH refinement ledger — `skill` arm

Append-only. One entry per candidate (accepted, reverted, or parked). See
[README.md](README.md) for the format and the cross-arm feed-forward rule.
<!-- ledger-entry id="loop-skill-2b-skill-iter1" lesson="Add concise, authoritative rules for ambiguous data semantics and pair write guidance with exact dependency-ordered command patterns, while avoiding dense bundles that increase selection cost." -->
### 2026-07-18 · skill · iter 1 · **ACCEPTED**

- **change:** This adds only the missing interpretation and construction rules exposed by the failures: the JSON envelope path, summar — files: skills/things-cli/SKILL.md, skills/things-cli/references/writes.md; diff 2 file(s) [skills/things-cli/SKILL.md, skills/things-cli/references/writes.md], +5/-3
- **pre-hoc hypothesis:** This adds only the missing interpretation and construction rules exposed by the failures: the JSON envelope path, summary-versus-detail tags, authoritative view fields, structured replies, explicit area movement, and an outside-in nested-placement pattern. It avoids benchmark-specific titles and preserves existing behavior.
- **predicted blast radius:** Improves Inbox/search extraction, effective-tag and standalone-view reasoning, completion-location answers, area filing, and compound project construction. It should also reduce invalid relative-date arguments, though agents must still calculate the ISO date. Risk is low because the edits clarify existing contracts and do not introduce new operations.
- **measured deltas (before → after):**
  - dev: success 23/33 → 27/33; friction 0.74 → 0.22; median tokIn 17278 → 14822
  - validation: success 3/6 → 4/6; friction 2.00 → 1.00; median tokIn 21709 → 21917
- **debrief:** attribution — The explicit `.data` envelope and authoritative view-state rules most likely drove the large read/reasoning gains, while the concrete area-move, nested-placement, and ISO-date guidance reduced write friction and improved recovery. The isolated Today regression and higher token use on several reads suggest the dense guidance occasionally increased interpretation cost; effective-tag guidance showed no measurable benefit because those runs did not execute.; lesson — Add concise, authoritative rules for ambiguous data semantics and pair write guidance with exact dependency-ordered command patterns, while avoiding dense bundles that increase selection cost.; confidence — high
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-2b); checkpoint: bench/artifacts/loop-skill-2b/checkpoint.md

<!-- ledger-entry id="loop-skill-2b-skill-iter2" lesson="Add only narrowly validated guidance, because extra procedural rules can increase tool calls and failure modes even when they clarify edge cases." -->
### 2026-07-18 · skill · iter 2 · **REVERTED**

- **change:** These edits make three existing contracts operationally explicit: grouped Today output, authoritative effective-tag/view — files: skills/things-cli/SKILL.md, skills/things-cli/references/writes.md; diff 2 file(s) [skills/things-cli/SKILL.md, skills/things-cli/references/writes.md], +3/-3
- **pre-hoc hypothesis:** These edits make three existing contracts operationally explicit: grouped Today output, authoritative effective-tag/view evidence, and safe construction and recovery for nested writes. A single portability note removes the observed relative-date error without prescribing workflow.
- **predicted blast radius:** Should fix Today JSON extraction, inherited-tag and Anytime reasoning, reduce malformed heading placement, and prevent duplicate parents during compound-write recovery. It should also reduce relative-weekday date-calculation errors. Risk is low because no command capability or GUI fact is changed.
- **measured deltas (before → after):**
  - dev: success 27/33 → 21/33; friction 0.22 → 1.38; median tokIn 14822 → 14994
  - validation: success 4/6 → 2/6; friction 1.00 → 0.50; median tokIn 21917 → 16427
- **debrief:** attribution — The patch produced a broad regression with no measurable success gains: added dense, prescriptive guidance likely increased decision and tool-use complexity, while the Node.js date-arithmetic recommendation plausibly drove the large friction/token increases on scheduling; several unrelated declines and small sample sizes also suggest substantial run variance rather than a single factual defect.; lesson — Add only narrowly validated guidance, because extra procedural rules can increase tool calls and failure modes even when they clarify edge cases.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-2b); checkpoint: bench/artifacts/loop-skill-2b/checkpoint.md

<!-- ledger-entry id="loop-skill-2b-skill-iter3" lesson="Prefer narrowly scoped, verifiable guidance and validate aggregate behavior, since added rules can improve their target case without improving—and may destabilize—the broader arm." -->
### 2026-07-18 · skill · iter 3 · **REVERTED**

- **change:** These edits make three hidden structural rules explicit: Today output is grouped, summary fields cannot establish effect — files: skills/things-cli/SKILL.md, skills/things-cli/references/writes.md; diff 2 file(s) [skills/things-cli/SKILL.md, skills/things-cli/references/writes.md], +8/-3
- **pre-hoc hypothesis:** These edits make three hidden structural rules explicit: Today output is grouped, summary fields cannot establish effective tags or views, and create commands use one positional title plus parent flags. The recovery sentence prevents duplicate state when a compound write partially succeeds, while the runtime note removes a recurring relative-date construction error.
- **predicted blast radius:** Improves grouped-view reads, exact JSON responses, inherited-tag reasoning, view classification, nested project creation, partial-write recovery, and weekday scheduling. Main risk is a small increase in skill tokens; no command behavior or GUI semantics change.
- **measured deltas (before → after):**
  - dev: success 27/33 → 24/33; friction 0.22 → 0.75; median tokIn 14822 → 16564
  - validation: success 4/6 → 3/6; friction 1.00 → 0.00; median tokIn 21917 → 15778
- **debrief:** attribution — The explicit grouped-Today parsing likely produced the clear discovery gain, while UUID-based resume guidance reduced recovery friction. Overall results regressed, however, and several zero-token failures plus small samples make the unrelated read, reasoning, and GUI losses more consistent with brittle execution or run variance than with the targeted semantic edits.; lesson — Prefer narrowly scoped, verifiable guidance and validate aggregate behavior, since added rules can improve their target case without improving—and may destabilize—the broader arm.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-2b); checkpoint: bench/artifacts/loop-skill-2b/checkpoint.md

<!-- ledger-entry id="loop-skill-r2-skill-iter1" lesson="Make hidden command contracts explicit, but separate zero-execution failures and broad unrelated variance from patch effects when judging refinements." -->
### 2026-07-18 · skill · iter 1 · **REVERTED**

- **change:** These two narrow edits address the clearest graded root causes: recovery from candidate-bearing lookup failures and the  — files: skills/things-cli/SKILL.md, skills/things-cli/references/writes.md; diff 2 file(s) [skills/things-cli/SKILL.md, skills/things-cli/references/writes.md], +2/-2
- **pre-hoc hypothesis:** These two narrow edits address the clearest graded root causes: recovery from candidate-bearing lookup failures and the one-operation-per-call checklist contract. They add exact, general command behavior without inventing unsupported syntax or masking the evening verification defect.
- **predicted blast radius:** Candidate-based reads should recover more reliably for exact-title items, improving effective-tag and detail queries. Multi-action checklist tasks should avoid usage errors and preserve existing checked states. Risk is low: ambiguous candidates still require inspection, and the checklist guidance merely exposes the command's existing granular contract.
- **measured deltas (before → after):**
  - dev: success 48/54 → 45/54; friction 0.81 → 0.42; median tokIn 20508 → 20259
  - validation: success 14/18 → 11/18; friction 0.79 → 0.36; median tokIn 22683 → 19152
- **debrief:** attribution — The granular checklist guidance most likely caused the clear checklist friction reduction and dev success gain; candidate-retry guidance may explain small reasoning gains. The larger aggregate regression is diffuse across unrelated tasks, including a zero-token validation collapse, so it is more consistent with run variance or infrastructure effects than these narrow edits.; lesson — Make hidden command contracts explicit, but separate zero-execution failures and broad unrelated variance from patch effects when judging refinements.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-r2); checkpoint: bench/artifacts/loop-skill-r2/checkpoint.md

<!-- ledger-entry id="loop-skill-r2-skill-iter2" lesson="Document verified command atomicity with a dependency-ordered example, and judge impact primarily on targeted evaluations while discounting unrelated or zero-token anomalies." -->
### 2026-07-18 · skill · iter 2 · **REVERTED**

- **change:** This is the smallest verified fix for a concrete failure class: it makes the checklist operation's one-action-per-call c — files: skills/things-cli/references/writes.md; diff 1 file(s) [skills/things-cli/references/writes.md], +1/-1
- **pre-hoc hypothesis:** This is the smallest verified fix for a concrete failure class: it makes the checklist operation's one-action-per-call contract explicit and supplies the dependency-ordered command pattern without adding unrelated workflow guidance.
- **predicted blast radius:** Should improve checklist tasks that combine checking, adding, removing, renaming, or moving entries by preventing multi-action usage errors. Risk is low and confined to checklist writes. It intentionally does not paper over the evening verification defect or add unvalidated guidance for the less-specific failures.
- **measured deltas (before → after):**
  - dev: success 48/54 → 51/54; friction 0.81 → 0.63; median tokIn 20508 → 19835
  - validation: success 14/18 → 12/18; friction 0.79 → 0.50; median tokIn 22683 → 16027
- **debrief:** attribution — The explicit one-action-per-invocation rule and ordered example most likely reduced checklist-command misuse: targeted evaluations improved in success or friction, while unchanged outcomes and large unrelated swings—especially zero-token runs—suggest residual task difficulty and benchmark variance rather than broad patch effects.; lesson — Document verified command atomicity with a dependency-ordered example, and judge impact primarily on targeted evaluations while discounting unrelated or zero-token anomalies.; confidence — high
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-r2); checkpoint: bench/artifacts/loop-skill-r2/checkpoint.md

<!-- ledger-entry id="loop-skill-r3-skill-iter1" lesson="State the invocation preconditions (required flags, gating flags, the add-then-convert chain) at the verb's entry point — capability facts alone don't execute; contracts do." -->
### 2026-07-18 · skill · iter 1 (batch loop-skill-r3) · **ACCEPTED — RECONSTRUCTED**

- **provenance:** batch crashed at iteration 3 when the runner's token cap (exit 8) surfaced as an unhandled subprocess error instead of the loop's clean budget abort (bug queued); ledger written post-hoc from loop-state.json. The accept decision and commit (9d6dd7c) are the loop's own, gated normally. No debrief exists.
- **change:** one line in references/recurrence.md — `--interval` marked required (`--interval 1` for every unit), `--allow-disruptive` requirement surfaced (incl. dry runs), and a worked add-then-make-repeating chain with comma-separated multi-weekday in ONE rule. Files: skills/things-cli/references/recurrence.md, +1/-1.
- **measured deltas (before → after):**
  - dev: success 52/63 → 59/63; friction 0.90 → 0.83; median tokIn 19.5k → 19.7k
  - validation: success 15/24 → 20/24; friction 1.13 → 0.90
  - recurrence detail: multi-weekday 1/3 → 3/3 (decomposition failure mode eliminated); weekly/after-completion held 3/3; marquee held 2/3 (the curated v1 reference had already lifted it from 1/9).
- **debrief:** (lost to the crash — see provenance)
- **artifacts:** bench/artifacts/loop-skill-r3/ (no checkpoint; sweeps 1–4 present), loop-state.json batch loop-skill-r3.

<!-- ledger-entry id="loop-skill-r3-skill-iter2" lesson="Read-contract clarifications bundled with unrelated parsing guidance keep failing validation — the dense-bundle lesson holds even at two sentences." -->
### 2026-07-18 · skill · iter 2 (batch loop-skill-r3) · **REVERTED — RECONSTRUCTED**

- **provenance:** as above; reconstructed from loop-state.json, no debrief.
- **change:** read-contract clarification (overdue miss + grouped-Today parsing) — reverted on validation regression.
- **measured deltas:** validation success regressed vs the post-iter-1 level; details in loop-state.json.
