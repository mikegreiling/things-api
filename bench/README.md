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
npm run bench -- --arm claude-cli   --model claude-haiku-4-5-20251001 --split dev  # Claude Code, bare
npm run bench -- --arm claude-skill --model claude-haiku-4-5-20251001 --split dev  # Claude Code, native skill
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

- **`--arm claude-cli` / `--arm claude-skill`** run the subject through the **Claude Code engine** (`claude -p`, subscription auth) instead of a pi provider. No `--provider` flag is needed (it is pinned to `claude-code`). These arms rebuild the real-shell fence from scratch (see `NOTES.md` → the `claude-code` arms) — a per-run throwaway HOME/workdir, a fenced PATH whose only escape hatch is a `things` shim, tools locked to Bash, and a fail-closed preflight. Auth resolves from `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`) or the `claude auth login` keychain item — **never `ANTHROPIC_API_KEY`**, so there is no metered API spend.

  Caveats for the Claude Code subscription arms:
  - **Subscription usage limits apply.** Calls draw on your Claude plan's rate/weekly usage caps (Haiku is the cheapest tier, but not free) — a large sweep (tasks × reps × arms) can hit the plan ceiling and throttle or stall mid-run. Size batches accordingly; pin the subject to `claude-haiku-4-5-20251001` and never default to a larger model.
  - **Bundled skills are constant, not absent.** Claude Code's own bundled skills (dataviz, code-review, run, …) appear in both arms' skill sets; they are identical across arms (pinned to the recorded Claude Code version) and cancel in the paired comparison. The only skill-set delta between `claude-cli` and `claude-skill` is `things-cli`.
  - **Token accounting maps but is not identical to the pi arms.** `tokensIn`/`cached`/`tokensOut`/turns/friction map cleanly from `result.usage`; `static` context is *measured* (first-turn cache-write) rather than text-estimated and includes Claude Code's internal harness prompt — compare `static` across the claude arms only, and use `tokensIn` as the cross-engine headline.

Reports: `bench/report.ts` aggregates `runs.jsonl` into a scorecard; accepted-round scorecards are committed under `bench/results/`.

## Layout

- `runner.ts` / `sandbox.ts` / `arms.ts` / `fixture.ts` / `grade.ts` / `report.ts` — the harness
- `claude-code.ts` — the `claude-cli` / `claude-skill` arms: the rebuilt real-shell fence + `claude -p` driver
- `prompts/` — fixed, versioned system prompts (hashes recorded per run)
- `tasks/` — the task corpus (`TaskSpec` JSON; families, tiers, dev/validation/holdout splits, paraphrases)
- `results/` — committed scorecards; `artifacts/` — gitignored raw runs/transcripts
- `NOTES.md` — build-time API facts (pi SDK, just-bash) worth keeping
