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
<!-- ledger-entry id="loop-skill-v2r-skill-iter1" lesson="Keep new guidance concise and retain it only when repeated evaluations show a consistent targeted gain without broad friction or token regressions." -->
### 2026-07-21 · skill · iter 1 · **REVERTED**

- **change:** This is the smallest generalizable fix for the only graded state failure: it makes the hierarchy, immediate-parent place — files: skills/things-cli/SKILL.md; diff 1 file(s) [skills/things-cli/SKILL.md], +1/-1
- **pre-hoc hypothesis:** This is the smallest generalizable fix for the only graded state failure: it makes the hierarchy, immediate-parent placement, returned-UUID chain, and per-command persistence explicit at the existing precondition entry point, preventing duplicate ancestors during recovery.
- **predicted blast radius:** Should improve compound area/project/heading/to-do creation and any recovery after a downstream child-write error. It may also reduce ambiguous-title failures by encouraging UUID reuse. Risk is limited to added static tokens; no safety or GUI semantics change.
- **measured deltas (before → after):**
  - dev: success 60/63 → 58/63; friction 1.05 → 1.09; median tokIn 21497 → 25587
  - validation: success 20/24 → 19/24; friction 0.95 → 1.32; median tokIn 23573 → 28827
- **debrief:** attribution — The patch produced no targeted success gain on compound creation and coincided with a small overall success decline plus higher friction; because regressions span unrelated operations and one validation task recorded zero input tokens, the most likely explanation is run variance or harness instability, with the added prescriptive detail possibly increasing deliberation rather than improving recovery.; lesson — Keep new guidance concise and retain it only when repeated evaluations show a consistent targeted gain without broad friction or token regressions.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-v2r); checkpoint: bench/artifacts/loop-skill-v2r/checkpoint.md

<!-- ledger-entry id="loop-skill-v2r-skill-iter2" lesson="Validate procedural guidance across multiple directly affected tasks and repeated runs, optimizing for success and recovery behavior rather than token reduction alone." -->
### 2026-07-21 · skill · iter 2 · **REVERTED**

- **change:** The severe compound failure created many duplicate parents while no requested children landed. A single dependency-order — files: skills/things-cli/SKILL.md; diff 1 file(s) [skills/things-cli/SKILL.md], +2/-0
- **pre-hoc hypothesis:** The severe compound failure created many duplicate parents while no requested children landed. A single dependency-ordered pattern at the writing entry point turns the existing abstract outside-in rule into an executable contract and explicitly prevents restarting successful parent steps.
- **predicted blast radius:** Primarily improves compound project/heading/to-do setup and other nested writes, reducing duplicate state and recovery errors. It may also reduce help calls for these operations. Risk is limited to the documented add verbs and placement flags; unrelated reads, recurrence, and GUI semantics are unchanged.
- **measured deltas (before → after):**
  - dev: success 60/63 → 56/63; friction 1.05 → 1.11; median tokIn 21497 → 18698
  - validation: success 20/24 → 17/24; friction 0.95 → 1.65; median tokIn 23573 → 29055
- **debrief:** attribution — The explicit UUID-chaining guidance likely shortened execution on the targeted compound dev task, but it did not improve its success or friction; the analogous validation task retained success while becoming substantially more expensive and error-prone. Large, inconsistent changes on unrelated tasks—including zero-token failures—indicate substantial run noise or infrastructure effects, so recurrence and GUI regressions cannot credibly be attributed to this narrowly scoped documentation change.; lesson — Validate procedural guidance across multiple directly affected tasks and repeated runs, optimizing for success and recovery behavior rather than token reduction alone.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-v2r); checkpoint: bench/artifacts/loop-skill-v2r/checkpoint.md

<!-- ledger-entry id="loop-skill-friction-skill-iter1" lesson="When clarifying an exhaustive reference inventory, preserve enough semantic detail in each entry to route agents reliably rather than optimizing only for brevity." -->
### 2026-07-22 · skill · iter 1 · **REVERTED**

- **change:** Make the reference inventory explicitly exhaustive while shortening it. This targets the repeated friction pattern of pr — files: skills/things-cli/SKILL.md; diff 1 file(s) [skills/things-cli/SKILL.md], +4/-4
- **pre-hoc hypothesis:** Make the reference inventory explicitly exhaustive while shortening it. This targets the repeated friction pattern of probing guessed or obsolete filenames without adding procedural guidance or surface bytes.
- **predicted blast radius:** Should reduce failed reads for data-model.md, reads.md, writes.md, recurrence.md, and safety-and-recovery.md across read and write tasks. No command or data semantics change; risk is limited to slightly less descriptive link summaries.
- **measured deltas (before → after):**
  - dev: success 57/63 → 57/63; friction 1.09 → 1.14; median tokIn 21606 → 20709
  - validation: success 19/24 → 19/24; friction 1.32 → 1.16; median tokIn 22347 → 20901
- **debrief:** attribution — The exhaustive inventory likely reduced filename guessing, reflected in broadly lower friction and token use, but it produced no net success gain; shortening the link descriptions plausibly weakened reference routing, especially for recurrence-related cases, causing offsetting regressions.; lesson — When clarifying an exhaustive reference inventory, preserve enough semantic detail in each entry to route agents reliably rather than optimizing only for brevity.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-friction); checkpoint: bench/artifacts/loop-skill-friction/checkpoint.md

<!-- ledger-entry id="loop-skill-friction-skill-iter2" lesson="Make authoritative resource inventories complete, concise, and visible at the first decision point to reduce exploratory tool use without expanding always-loaded guidance." -->
### 2026-07-22 · skill · iter 2 · **REVERTED**

- **change:** Relocate and compress the existing reference inventory near the help entry point, explicitly marking it complete. This t — files: skills/things-cli/SKILL.md; diff 1 file(s) [skills/things-cli/SKILL.md], +2/-6
- **pre-hoc hypothesis:** Relocate and compress the existing reference inventory near the help entry point, explicitly marking it complete. This targets repeated friction from guessed nonexistent reference paths while reducing always-loaded SKILL.md bytes and changing no command or data semantics.
- **predicted blast radius:** Should reduce failed file-read calls across tasks that inspect documentation before reading or writing. The only risk is losing the longer per-reference descriptions, but each linked filename remains labeled and the surrounding skill already summarizes its contents.
- **measured deltas (before → after):**
  - dev: success 57/63 → 57/63; friction 1.09 → 0.77; median tokIn 21606 → 20318
  - validation: success 19/24 → 18/24; friction 1.32 → 1.00; median tokIn 22347 → 19140
- **debrief:** attribution — Placing a clearly complete reference inventory beside the help entry point most likely reduced unnecessary documentation searches and guessed file reads, reflected in broadly lower friction and token use. Success remained roughly flat with scattered regressions, including a zero-token validation anomaly, so there is little evidence of a semantic improvement or systematic harm from removing the descriptions.; lesson — Make authoritative resource inventories complete, concise, and visible at the first decision point to reduce exploratory tool use without expanding always-loaded guidance.; confidence — medium
- **artifacts:** loop-state: bench/loop-state.json (batch loop-skill-friction); checkpoint: bench/artifacts/loop-skill-friction/checkpoint.md


<!-- ledger-entry id="v2round-skill-ref-inventory" lesson="On a self-evident read surface the skill's reference sprawl is a NET friction ADD vs the bare CLI — agents burn error-incurring bash calls hunting reference files by guessed topic-names; an ADDITIVE authoritative inventory (naming the real files AND the common wrong guesses) at the first decision point is the compression-safe way to land the standing loop-skill-friction lesson." -->
### 2026-08-06 · skill · v2round iter 1 · **KEPT (directional, N=3 — needs ≥10-rep paired confirmation)**

- **change:** Add an authoritative reference-file inventory paragraph to SKILL.md at the first decision point (right after the `--help`/`help <topic>` line): names the exact six files (`model`/`contracts`/`ordering`/`errors`/`banner`/`gui`), maps the topic an agent wants to the file that holds it (read shapes→`model`, envelope/undo/batch/recurrence→`contracts`, move/reorder→`ordering`), and states outright there is no `reads`/`writes`/`data-model`/`recurrence`/`safety` file. Manual curation (recurrence-campaign doctrine), not the loop refiner. Files: skills/things-cli/SKILL.md; +1 paragraph, 13710→14258 B (+548, ADDITIVE — no existing content compressed).
- **motivating failure (OBSERVED, not guessed):** on the four new v2 read/mutation tasks the SKILL arm hit MORE friction than the bare-CLI (naive) arm — 8 vs 2 errors over 12 runs, both arms 12/12 success. Root cause (transcript scan): agents ran standalone `sed …/references/<guess>.md` calls that exited 1 on filenames that don't exist — `data-model.md` (×3), `reads.md` (×3), `writes.md`, `recurrence.md`, `safety-and-recovery.md`. Class (a): probing nonexistent reference filenames — the exact residual the 2026-07-22 loop-skill-friction round isolated and whose two REVERTED candidates were both compression-shaped.
- **pre-hoc hypothesis:** an additive inventory that (i) enumerates the real files and (ii) explicitly negates the common topic-name guesses will cut the guessed-filename bash failures without the compression cost that reverted the prior two attempts (both arms are already 100% success here, so a friction-only fix cannot cost success on this subset).
- **predicted blast radius:** fewer exit-1 `sed` calls hunting references; no command/data semantics change; risk = +548 always-loaded SKILL.md bytes.
- **measured deltas (before → after, skill arm, 4 v2 tasks × 3 reps):**
  - success: 12/12 → 12/12 (no change; safety clean both)
  - friction (errorsSeen total): 8 → 2 (mean 0.67 → 0.17)
  - guessed-filename `No such file` occurrences: 9 → 6 (recurrence.md and 2× reads.md guesses eliminated; **`data-model.md` ×3 PERSISTS** — the signpost helps but does not fully suppress the strongest guess, since `model.md`'s own title is "The Things data model")
  - naive (cli) arm baseline for contrast: 12/12 success, 2 errors (0.17) — both on the write task (`.data[]`-vs-`.data.items[]` jq assumption + a `things move` namespacing slip, self-corrected via the CLI's own hints); the naive arm never hunts references, hence its lower friction.
- **debrief:** attribution — the additive inventory reduced reference-name-guessing friction directionally, consistent with the standing lesson, while avoiding the validation-success regression that reverted the prior compression-shaped attempts (this version adds rather than shortens). BUT N=3 on a 4-task v2 subset with high codex sampling variance, and `errorsSeen` is bash-bundling-sensitive, so the 8→2 drop is directional, not conclusive; the persistent `data-model.md` guess shows the residual is not fully closed. lesson — see marker. confidence — low-medium.
- **follow-up:** promotion-grade paired A/B (v2-inventory vs origin/main skill via `BENCH_SKILL_DIR`, ≥10 reps, full validation+holdout) before locking; and consider whether the strongest guess warrants aligning the file's name/first-line to the "data model" concept rather than only negating the guess.
- **artifacts:** bench/artifacts/v2round/ (naive+skill baseline), bench/artifacts/v2round-confirm/ (post-refinement skill).

<!-- ledger-entry id="v2round-skill-ref-inventory-confirm" lesson="The additive reference-inventory signpost LOCKS on a ≥10-rep paired A/B: it is non-inferior-or-better on success AND cuts reference-hunt friction, at only a tiebreaker-level context cost — confirming the standing lesson that an authoritative resource inventory at the first decision point is the compression-safe friction win." -->
### 2026-08-06 · skill · v2round confirm · **CONFIRMED / LOCKED (≥10-rep paired A/B)**

- **what:** the promotion-grade confirmation the prior `v2round-skill-ref-inventory` entry flagged as required before locking (it was KEPT directional at N=3). Paired A/B of the SHIPPED (origin/main) SKILL.md WITH the reference-inventory paragraph (treatment, in-tree) vs the pre-#428 SKILL.md WITHOUT it (control, via `BENCH_SKILL_DIR` = `git show 4aaf2e0^:skills/things-cli/SKILL.md`, 13710 B; the +548 B inventory is the ONLY delta, references byte-identical). Subject gpt-5.4-mini via openai-codex.
- **protocol:** the three v2 read tasks that surfaced the reference-hunt friction (`reads-project-heading-recursion` dev, `reads-upcoming-dayblock` validation, `reads-today-counts-holdout` holdout) × **10 reps** × both configs = 30 runs/config, 60 total. Same world-seed/clock; skill arm both.
- **measured deltas (control pre-inventory → treatment with-inventory):**
  - success: 27/30 → **29/30** (non-inferior / BETTER, +2; safety clean both)
  - friction (errorsSeen total): 16 → **10** (−37%, treatment lower)
  - median tokIn: 28518 → 30240 (+~6% — the always-loaded +548 B inventory; a ladder tiebreaker that binds only at a success tie, which does not apply since success is better)
  - wrong-guess reference mentions across transcripts (files that don't exist): data-model.md 21→18, reads.md 16→13, writes.md 3→2, safety-and-recovery.md 6→7 — directionally lower, but **`data-model.md` PERSISTS** (18 mentions) — the strongest guess is not suppressed (model.md's own title is "The Things data model").
- **decision (constitution ladder):** safety clean · success non-inferior-or-better (29≥27) · friction reduced (10<16) → the refinement LOCKS. It is already on origin/main (shipped in #428), so this is a CONFIRM, not a promotion action — no revert. N=30 paired reps/config clears the ≥10-rep bar; the prior N=3 directional read is now confirmed.
- **open (deferred, not this round):** the persistent `data-model.md` mis-guess — a candidate additive fix is to align model.md's name/first line to the "data model" concept (or add the explicit `data-model.md → model.md` alias to the inventory) rather than only negating the guess. Not done here (it is residual friction, not a success failure; refine only from observed success failures).
- **artifacts:** bench/artifacts/rd-treat/ (treatment), bench/artifacts/rd-ctrl/ (control).
