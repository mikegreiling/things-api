# AGENTBENCH — agent-ergonomics bench for the things-api surfaces

A mini-project measuring how well **zero-context, non-frontier agents** can use the three consumer surfaces — the bare CLI (help system only), the CLI plus the agent skill (`skills/things-cli/`), and the MCP server — and a refinement loop that hones each surface's copy against those measurements.

Start here, then: [CONSTITUTION.md](CONSTITUTION.md) (invariants — metric ladder, promotion rules, content doctrine), [ROADMAP.md](ROADMAP.md) (current state, resume pointer, round history). Both are living documents under the root AGENTS.md update-in-the-same-change rule.

## How it works

Each run seeds a synthetic fixture Things DB, sandboxes the subject model (pi-agent-core agent; just-bash VFS for the CLI arms — the only escape hatch is the `things` command itself, routed to `bin/things.js` with a fenced env), lets it attempt one task, then grades deterministically (SQL assertions on the post-state, structured final-answer matchers, DB-unchanged checks for refusal tasks). Writes execute through the real write pipeline against the fixture via the fenced simulator vector (`THINGS_SIM_WRITES=1`, see `src/write/vectors/simulator.ts`) — the pipeline's read-after-write verification audits every simulated mutation. No run can touch a real Things database.

## Running

```sh
npm run bench -- --arm cli --tasks bench/tasks --split dev --pseudo        # zero-cost harness smoke (scripted pseudo-agent)
npm run bench -- --arm cli --model <pinned-model> --provider openai --split dev --reps 3
npm run bench -- --arm skill ... / --arm mcp ...                           # other arms
```

Requires `OPENAI_API_KEY` for real runs (never committed; artifacts land in gitignored `bench/artifacts/`). Reports: `bench/report.ts` aggregates `runs.jsonl` into a scorecard; accepted-round scorecards are committed under `bench/results/`.

## Layout

- `runner.ts` / `sandbox.ts` / `arms.ts` / `fixture.ts` / `grade.ts` / `report.ts` — the harness
- `prompts/` — fixed, versioned system prompts (hashes recorded per run)
- `tasks/` — the task corpus (`TaskSpec` JSON; families, tiers, dev/validation/holdout splits, paraphrases)
- `results/` — committed scorecards; `artifacts/` — gitignored raw runs/transcripts
- `NOTES.md` — build-time API facts (pi SDK, just-bash) worth keeping
