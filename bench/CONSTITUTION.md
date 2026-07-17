# AGENTBENCH constitution

Invariants of the agent-ergonomics bench. This file changes only by explicit decision from Mike — routine sessions update [ROADMAP.md](ROADMAP.md), never this. If a proposed change conflicts with this document, the change is wrong or this document needs Mike's sign-off first.

## Purpose

Make the three consumer surfaces — bare CLI help, the agent skill, and MCP — maximally usable by **zero-context, non-frontier agents**. "Usable" means the agent *understands* Things (data model, capabilities, how humans see results), not merely that mutations land.

## The metric ladder (lexicographic, strict)

1. **Safety** — no prohibited or unintended state changes; refusal tasks must leave the DB untouched. A candidate that regresses safety is dead regardless of other gains.
2. **Task success** — graded by machine-checkable evidence only (DB state, exit codes, envelopes, structured final answers). Never by an LLM judge, never by "looks right".
3. **Friction** — count of error responses the agent saw en route (failed commands, usage errors, invalid tool calls). Errors-then-success still counts as success, but every error counts against a candidate.
4. **Context tokens** — static (system prompt, tool defs, skill bytes) + dynamic (help output, results, errors).
5. **Tool calls / latency.**

Efficiency metrics (3–5) are compared **only across successful paired runs**. A fast wrong answer never beats a slow right one.

## Zero-context definition

The subject model receives no README, no source, no design docs, no hints beyond what the surface under test itself provides. Pretraining knowledge cannot be erased; we control only what we supply. Each arm gets exactly one surface: bare CLI (bash + `things` only), CLI + skill (identical CLI build, frozen during skill rounds), MCP (server instructions + tools, no bash).

## Content doctrine

- **Non-opinionated**: surfaces teach capabilities and structure, never GTD workflow advice. Consistent with docs/design/surface-copy.md.
- **GUI facts live in the skill only** (references/gui.md), curated by Mike. The loop cannot verify GUI claims, so the refiner may compress or relocate them but never add or alter their semantics; any semantic change requires Mike's explicit checkpoint approval.
- All bench content is **fully synthetic** (public repo): no real task data, no PII, no credentials outside gitignored artifacts.

## Overfitting defenses

- Splits: **dev** (refiner-visible) / **validation** (gates every revision) / **holdout** (never appears in any refiner or digester prompt, ever).
- Paraphrase variants and rotating synthetic inventories (names, counts, UUIDs re-rolled) guard the copy against memorizing benchmark phrasing.
- Model versions are pinned per baseline so a model update is never mistaken for a copy regression.
- Promotion requires improvement on validation AND holdout, not just dev.

## Promotion & stopping rules

Promote a candidate only if: no safety regression; success improves or is non-inferior on validation and holdout; ties broken in order by friction reduction, then ≥~10–15% context reduction on successful runs. Reps: ≥3 exploring, ≥10 for promotion decisions — treat small-N deltas as directional. Stop refining a surface when two consecutive iterations produce no promotable change, gains fall below rep variance, or remaining failures are tool defects (those become issues, not copy edits).

## Roles

Subject models execute. Deterministic assertions grade. The frontier refiner (GPT-5.6 Sol class) analyzes failures and proposes the smallest generalizable patch — it never executes tasks and never grades. Every failure is classified before any copy change: (a) couldn't discover the command, (b) misunderstood its behavior, (c) misunderstood the data model, (d) wrong argument construction, (e) failed recovery, (f) tool defect.

## Safety rails (inherited from the repo, non-negotiable)

The production Things DB is never touched — bench runs point every child process at a fenced synthetic fixture (`THINGS_SIM_WRITES=1` + `THINGS_DB` + the `benchFixture` marker); the simulator vector refuses anything else. Real-app validation happens only in disposable Tart VMs via the existing lab.
