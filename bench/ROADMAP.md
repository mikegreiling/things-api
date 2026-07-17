# AGENTBENCH roadmap & state

Living state of the bench mini-project. Update in the same change as any bench work (root AGENTS.md rule). Doctrine lives in [CONSTITUTION.md](CONSTITUTION.md) — do not restate it here.

## ⟹ RESUME HERE

**Phase 0 (harness build) — IN PROGRESS, started 2026-07-17, branch `mg/bench-harness`.** Full plan: `/Users/mike/.claude/plans/cuddly-greeting-gadget.md` (session "things-skill-loop"). Nothing has run against a real model yet.

Phase 0 checklist:
- [ ] Simulator write vector + fence + fixture marker + unit tests (delegated)
- [x] Bench scaffolding: runner/sandbox/arms/grade/report + pseudo-agent smoke (delegated, worktree) — types/fixture/sandbox/arms/grade/report/runner + prompts/ + two sample tasks; `npm run bench -- --pseudo` exercises seed→sandbox→grade→report. Pi/just-bash API facts in [NOTES.md](NOTES.md).
- [ ] Task corpus v1 (~12 tasks, all families represented, splits assigned)
- [ ] Skill v0 (SKILL.md preamble + references skeleton; gui.md placeholder awaiting Mike's curation)
- [ ] Living docs (this file, CONSTITUTION, README) + root docs (roadmap §K pointer, AGENTS.md living-docs entry, CHANGELOG)
- [ ] PR for `mg/bench-harness`

## Phase ladder

0. **Harness** (current) — everything above, merged as one PR.
1. **Baselines** — three arms × pinned subject panel, all splits; failure-classification report identifies leverage before any copy edits. Subjects: small pinned OpenAI models (see constitution's roles; Anthropic-in-Pi is blocked by the third-party-harness policy — optional sanctioned `claude -p --model haiku` cell, low volume). Requires OPENAI_API_KEY in env.
2. **Refinement loops** — worktrees `mg/loop-cli-help` / `mg/loop-skill` / `mg/loop-mcp`, each round based on the same pinned integration commit; checkpoint digest to Mike per batch (≤5 iterations or 2 consecutive no-accepts).
3. **Integrate & merge** — promotion per constitution; A and C file-disjoint (parallel PRs), B rebases on integrated CLI; final cross-arm report.
4. **Parked** — CI smoke subset; Tart-VM replay validating simulator fidelity; VM-graded long-tail pack (ops the simulator can't apply — recurrence is the expected first tenant); open-weight subject panel; second model family for transfer testing; skill distribution in the npm package; `things help views` topic if the GUI-perception family shows bare-CLI need.

## Round history

(none yet — Phase 1 baselines will seed this. Format per round: date, arm, iterations run, candidates accepted/reverted with one-line rationale, scorecard path under results/.)

## Known limits & decisions log

- 2026-07-17: Simulator presents as the `url-scheme` vector; ops outside its coverage read as "unsupported" to the agent even where real Things supports them — corpus must stay within coverage until the VM pack exists.
- 2026-07-17: Corpus assertions are SQL + structured-final-answer matchers only (no library imports in grading), so grading stays decoupled from the surfaces under test.
