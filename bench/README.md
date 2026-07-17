# AGENTBENCH — agent-ergonomics bench for the things-api surfaces

A mini-project measuring how well **zero-context, non-frontier agents** can use the three consumer surfaces — the bare CLI (help system only), the CLI plus the agent skill (`skills/things-cli/`), and the MCP server — and a refinement loop that hones each surface's copy against those measurements.

Start here, then: [CONSTITUTION.md](CONSTITUTION.md) (invariants — metric ladder, promotion rules, content doctrine), [ROADMAP.md](ROADMAP.md) (current state, resume pointer, round history), and [ledger/](ledger/README.md) (the append-only per-arm knowledge ledgers — what worked and what didn't, one file per surface, written by the refinement loop). All are living documents under the root AGENTS.md update-in-the-same-change rule.

## How it works

Each run seeds a synthetic fixture Things DB, sandboxes the subject model (pi-agent-core agent; just-bash VFS for the CLI arms — the only escape hatch is the `things` command itself, routed to `bin/things.js` with a fenced env), lets it attempt one task, then grades deterministically (SQL assertions on the post-state, structured final-answer matchers, DB-unchanged checks for refusal tasks). Writes execute through the real write pipeline against the fixture via the fenced simulator vector (`THINGS_SIM_WRITES=1`, see `src/write/vectors/simulator.ts`) — the pipeline's read-after-write verification audits every simulated mutation. No run can touch a real Things database.

## Running

```sh
npm run bench -- --arm cli --tasks bench/tasks --split dev --pseudo        # zero-cost harness smoke (scripted pseudo-agent)
npm run bench -- --arm cli --model <pinned-model> --provider openai --split dev --reps 3
npm run bench -- --arm cli --model <pinned-model> --provider openai-codex --split dev   # ChatGPT-subscription OAuth
npm run bench -- --arm skill ... / --arm mcp ...                           # other arms
```

Real runs authenticate one of two ways (artifacts always land in gitignored `bench/artifacts/`):

- **`--provider openai`** reads `OPENAI_API_KEY` from the environment (never committed).
- **`--provider openai-codex`** uses a ChatGPT-subscription OAuth credential (OpenAI's "openai-codex" provider). Sign in once:

  ```sh
  npm run bench:login          # opens the pi-ai OAuth flow for the openai-codex provider
  ```

  The token is stored at `~/.config/things-api-bench/auth.json` (0600, **outside the repo**) and refreshed automatically per turn. A run started without a stored credential fails fast with a message pointing back at `npm run bench:login` — it never falls back to an interactive prompt mid-run.

  Caveats for codex-OAuth subjects:
  - **Subscription rate caps apply.** These calls draw on your ChatGPT plan's usage limits, not a metered API balance — a large sweep (many tasks × reps × arms) can hit the plan's rate/usage ceiling and stall or error mid-run, unlike a pay-as-you-go API key. Size batches accordingly and expect throttling.
  - **Softer model pinning.** The codex catalog exposes ChatGPT-product model ids (e.g. `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `gpt-5.6-sol`) whose backing weights and defaults can shift under you without an id change, so a codex-OAuth cell is a weaker reproducibility anchor than a dated API model id. Record the exact id and run date; treat cross-date comparisons on this path with care.

Reports: `bench/report.ts` aggregates `runs.jsonl` into a scorecard; accepted-round scorecards are committed under `bench/results/`.

## Layout

- `runner.ts` / `sandbox.ts` / `arms.ts` / `fixture.ts` / `grade.ts` / `report.ts` — the harness
- `prompts/` — fixed, versioned system prompts (hashes recorded per run)
- `tasks/` — the task corpus (`TaskSpec` JSON; families, tiers, dev/validation/holdout splits, paraphrases)
- `results/` — committed scorecards; `artifacts/` — gitignored raw runs/transcripts
- `NOTES.md` — build-time API facts (pi SDK, just-bash) worth keeping
