# AGENTBENCH knowledge ledger

The hard-won record of what works — and what does **not** — across refinement rounds, one file per surface (`cli.md`, `skill.md`, `mcp.md`). The loop driver ([`bench/loop.ts`](../loop.ts)) writes these; this file is the format contract.

## Why per-arm files

The three arms refine in parallel worktrees (`mg/loop-cli-help` / `mg/loop-skill` / `mg/loop-mcp`). A single shared ledger would conflict at every integration merge, so **each loop appends only to its own arm's file** (`bench/ledger/<arm>.md`). Merges stay clean because no two loops ever touch the same ledger file.

## Cross-arm rule (feed-forward vs. transfer)

- **Feed-forward (automatic):** a refiner charter is seeded with the most recent lessons **from its own arm's ledger only** (newest ~15, capped ~2k tokens, oldest dropped first). A cli loop never sees skill or mcp lessons at run time.
- **Cross-arm transfer (deliberate):** a lesson that generalizes across surfaces is promoted between arms **only at an integration checkpoint**, human- or orchestrator-mediated — never silently by the loop.

## Holdout hygiene

Lessons derive from the dev-split digest and the metric deltas only. The post-hoc debrief that produces a lesson is shown the patch, its pre-hoc hypothesis, and the per-task **numbers** (success / friction / tokensIn) for dev and validation — never any task prompt text, and never anything from the holdout. Lessons therefore cannot quote validation/holdout content by construction.

## Entry format

Append-only. **One entry per candidate**, rejected and parked candidates included (allowlist/gate/empty-patch/provider-error iterations carry no measured candidate and live only in `loop-state.json`). Each entry is a hidden marker line — `<!-- ledger-entry id="…" lesson="…" -->`, which makes appends idempotent (an id already present is skipped) and lets the feed-forward extractor pull lessons reliably — followed by the human-readable body:

- **date · arm · iteration · decision** (`ACCEPTED` / `REVERTED` / `NEEDS-MIKE`)
- **change:** first line of the refiner rationale — files touched + diff stat
- **pre-hoc hypothesis** and **predicted blast radius** (the refiner's own, before the re-bench)
- **measured deltas (before → after)** for dev and validation: success, friction, median tokensIn
- **debrief:** attribution + one transferable lesson + confidence (`high`/`medium`/`low`); `debrief-failed` when the post-hoc call never parsed, `debrief-skipped (budget)` when the token budget was spent
- **artifacts:** pointer to the batch's `loop-state.json` + `checkpoint.md`

The loop appends a batch's entries at batch end (the same flow that writes `checkpoint.md`) and commits the arm's ledger file so it rides that arm's PR.
