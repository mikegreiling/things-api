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

