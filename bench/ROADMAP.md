# AGENTBENCH roadmap & state

Living state of the bench mini-project. Update in the same change as any bench work (root AGENTS.md rule). Doctrine lives in [CONSTITUTION.md](CONSTITUTION.md) — do not restate it here.

## ⟹ RESUME HERE

**Phase 0 (harness build) — IN PROGRESS, started 2026-07-17, branch `mg/bench-harness`.** Full plan: `/Users/mike/.claude/plans/cuddly-greeting-gadget.md` (session "things-skill-loop"). Nothing has run against a real model yet.

Phase 0 checklist:
- [x] Simulator write vector + fence + fixture marker + unit tests (fe27cf1; adversarially reviewed, findings fixed in ebbb1ff — fail-closed fence, `--db` split-brain, host-escape gating, applier-branch tests)
- [x] Bench scaffolding: runner/sandbox/arms/grade/report + pseudo-agent smoke — types/fixture/sandbox/arms/grade/report/runner + prompts/ + two sample tasks; `npm run bench -- --pseudo` exercises seed→sandbox→grade→report. Pi/just-bash API facts in [NOTES.md](NOTES.md).
- [x] Task corpus v1 (90659a3 — 12 tasks, 7 families, 2 validation + 2 holdout; encodings verified in tasks/AUTHORING.md)
- [x] Skill v0 (SKILL.md preamble + references skeleton; gui.md curated facts awaiting Mike's review)
- [x] Living docs (this file, CONSTITUTION, README) + root docs (roadmap §K pointer, AGENTS.md living-docs entry, CHANGELOG)
- [ ] PR for `mg/bench-harness`
- [x] Evergreen world profile (`bench/world.ts`, branch `mg/bench-world`) — lived-in library layered under task seeds; on by default (`--world-seed`, `--no-world`); worldSeed recorded per run

## Phase ladder

0. **Harness** (current) — everything above, merged as one PR.
1. **Baselines** — three arms × pinned subject panel, all splits; failure-classification report identifies leverage before any copy edits. Subjects: small pinned OpenAI models (see constitution's roles; Anthropic-in-Pi is blocked by the third-party-harness policy — optional sanctioned `claude -p --model haiku` cell, low volume). Requires OPENAI_API_KEY in env.
2. **Refinement loops** — worktrees `mg/loop-cli-help` / `mg/loop-skill` / `mg/loop-mcp`, each round based on the same pinned integration commit; checkpoint digest to Mike per batch (≤5 iterations or 2 consecutive no-accepts).
3. **Integrate & merge** — promotion per constitution; A and C file-disjoint (parallel PRs), B rebases on integrated CLI; final cross-arm report.
4. **Parked** — CI smoke subset; Tart-VM replay validating simulator fidelity; VM-graded long-tail pack (ops the simulator can't apply — recurrence is the expected first tenant); open-weight subject panel; second model family for transfer testing; skill distribution in the npm package; `things help views` topic if the GUI-perception family shows bare-CLI need.

## Round history

(none yet — Phase 1 baselines will seed this. Format per round: date, arm, iterations run, candidates accepted/reverted with one-line rationale, scorecard path under results/.)

## Known limits & decisions log

- 2026-07-17: Simulator presents as the `url-scheme` vector; ops outside its coverage read as "unsupported" to the agent even where real Things supports them — corpus must stay within coverage until the VM pack exists. Same fidelity gap applies to a forced `--vector applescript|shortcuts|ui` (reports unsupported where the real CLI would succeed).
- 2026-07-17: Corpus assertions are SQL + structured-final-answer matchers only (no library imports in grading), so grading stays decoupled from the surfaces under test.
- 2026-07-17: Adversarial review of fe27cf1 — CLEAN on the big fidelity questions (guards/when-validation/hazard gates all run on the simulator path; evening/someday encodings agree with the read path; undo round-trips; audit marker is display-only). Fixed in follow-up: fail-closed fence (half-set env no longer falls through to real transports), env-vs-`--db` split-brain, host-escape gating (`things open`, setup/doctor probes) under the sim fence. Open question parked: real-app behavior on duplicate `tag.add` titles (simulator inserts; app merge behavior unverified).
- 2026-07-17: Harness requirement (from the same review): the sandbox's `things` command must construct the child env from run config alone — agent-visible sandbox env state must not be able to unset `THINGS_DB`/`THINGS_SIM_WRITES`.
- 2026-07-17: **World profile SHIPPED** (`bench/world.ts`): ~8 areas / ~20 mixed-state projects / ~450 rows incl. ~3y logbook, 9 recurrence templates (all four frequencies, fixed + after-completion, nth-weekday incl. last-Sunday-of-December) as decoder-validated XML plist blobs + linked instances; enforced invariants: zero Today/overdue contribution from world rows (danger-zone read tasks stay exact), corpus-collision fence (normalized-equality + LIKE-pattern), deterministic (seed, clock) via rng-derived uuids. Sample task `reads-inbox-count` redesigned from a global inbox count (incompatible with a rotating world) to a scoped inbox lookup. Polish parked: verb-object pools can produce goofy combos ("Draft the bike tires") — harmless distractors.
- 2026-07-17 (Mike): **Evergreen world profile** — fixtures are regenerated per run from a declarative lived-in library (engineer-life areas/projects/years of logbook/checklists/reminders/recurring templates), all dates as OFFSETS from the pinned task clock (never absolute → never stale), seeded-PRNG inventory rotation, layered UNDER per-task seeds with a title-collision check and declared world invariants (v1 world is well-groomed: no stray open-overdue items, so global-count task assertions stay valid; a "messy world" profile is future work for truncation/recovery families). Prod DB consulted for SHAPE STATISTICS ONLY via scripts/prod-read.sh (survey in session scratchpad, never committed); zero content crosses over.
