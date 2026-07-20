# Skill distribution & the CLI↔skill version ratchet

Status: **TENTATIVE PLAN** (decided 2026-07-20, Mike + session "things-skill-loop"). Execution is gated on the skill-v2 demarcation experiment (below); revisit this doc after that experiment reports. Bench context in `bench/ROADMAP.md`; the refinement evidence cited here lives in `bench/results/` and `bench/ledger/`.

## Goal

A user should arrive at a fully working CLI + agent-skill setup from ANY of three entry angles, with each side able to nudge the other up-to-date (a self-improving ratchet, no manual version bookkeeping):

1. `npm install -g things-api` → the help footer suggests installing the agent skill.
2. `npx things-api ...` directly (no install) → same suggestion, same command.
3. Skill installed first (no CLI anywhere) → the skill itself drives `npx -y things-api@latest` and routes around stale global binaries.

README promise: *install the skill, and everything else — CLI access via npx, mechanics via help, update nudges — is self-maintaining.*

## Load-bearing decision: the demarcation (skill-v2)

The staleness problem is mostly dissolved by content placement, not tooling:

- **The skill carries slow-moving truth**: the data model (containers, headings, tag inheritance, Inbox-as-state), glossary, GUI rendering facts, the stable JSON envelope contract (`.data` never `.items` — apiVersion-stable), and pointers into the help/topic system.
- **`--help` and `things help <topic>` carry fast-moving mechanics**: verbs, flags, per-op preconditions, response details. These automatically version with whatever binary the agent invokes — in npx mode they are *never* stale.

A version-tolerant skill makes drift low-stakes; the ratchet below only has to notice *significant* drift, not prevent all of it. Bench evidence for feasibility: the cli arm reached success parity with the skill arm on help alone (~89% dev), and the `help repeating` topic replicated skill-grade contract curation on the bare CLI (11/18→17/18). Known cost to verify: the skill arm's friction/turn advantage (cli spent 52% of invocations on `--help` discovery vs 33%) — the v2 experiment's paired sweep (v2 vs v0.2, success/friction/context, per model tier) decides whether the demarcation ships.

## Install mechanism: shell out to the `skills` CLI, with `--copy`

Research (2026-07-20, `skills` v1.5.19, vercel-labs/skills):

- **CLI-only** — bins `skills`/`add-skill`, no `main`/`exports`, no programmatic TypeScript API. Embedding as a library is not an option; shelling out is the integration.
- `skills add` accepts GitHub shorthand/URLs (incl. repo subdirectories), git URLs, and **local paths** — the latter is what lets a skill bundled inside an installed npm package be handed over directly.
- It maintains a canonical `~/.agents/skills/` (or project `.agents/skills/`), auto-detects installed harnesses (70+: Claude Code, Codex, Cursor, OpenCode, Pi, Cline, …), and materializes into each agent-specific dir (`~/.claude/skills/`, `~/.codex/skills/`, …).
- **Sandbox-verified layout semantics (2026-07-20, v1.5.19, fake-HOME probe with a local-path source):** the canonical `~/.agents/skills/<name>/` entry is ALWAYS a **real physical copy** of the source — distinct inodes, no link back to the source path — so nothing ever references the package-manager-controlled location after install (npx cache pruning / pnpm store moves / asdf node switches are all harmless). The `--copy` flag governs ONLY the canonical→agent-dir hop ("Copy files instead of symlinking to agent directories"); the default there is a dedup symlink, though the claude-code adapter was observed copying even by default (adapter-dependent). Either materialization is safe for us.
- Non-interactive: `-y`, `-g` (global vs project), `-a <agent>`, `-s <skill>`, `--all`, `--list`. A `skills update` exists (re-pulls from the recorded source). Also spotted: `skills experimental_sync` — "Sync skills from node_modules into agent directories" — their own native npm-bundled-skill flow; experimental today, but track it, since it could eventually replace our shell-out entirely.

Decisions:

- **`things install-skill` = resolve own package root → shell out** to `npx -y skills add <pkg>/skills/things-cli -g -y`. The binary resolving its *own* install location kills the "wherever npm/pnpm/bun put the package" fragility — no discovery heuristics.
- **Use their DEFAULT materialization (no `--copy`).** An earlier draft mandated `--copy` on the theory that the default symlink pointed into the unstable package path — the sandbox probe DISPROVED that (canonical is always a physical copy; see research above). The default canonical→agent-dir symlink is desirable dedup (one source of truth across N agent dirs), exactly per Mike's preference (2026-07-20).
- **Soft dependency, not a package dependency.** Shelling to `npx -y skills@latest` keeps their fast-moving harness-detection current and adds nothing to our install weight. Fallback when npx/network is unavailable: a built-in plain copy into `~/.agents/skills/` + `~/.claude/skills/` (the two we can place without detection logic), with a note that `skills` covers the rest.
- **Idempotent; re-running IS the update.** `things install-skill --check` compares installed stamp vs bundled without writing.
- Alternate channel (documented, not primary): `npx skills add mikegreiling/things-api` straight from GitHub — works for skill-first users with zero npm knowledge; installs whatever the repo's `skills/things-cli/` currently holds.

## The drift ratchet

Principle: **never spend agent reasoning on version math** — bench data says small models fumble incidental comparisons, and a per-session check burns tokens on a rare event. The binary does the noticing; the skill does the routing.

- **Publish-time stamp**: the release build writes the package version into `SKILL.md` frontmatter (`version:`). `install-skill` copies it through.
- **CLI-side passive check** (binary newer than skill): on help/human output paths ONLY (never inside `--json` envelopes), stat the well-known skill locations (`~/.agents/skills/things-cli/`, `~/.claude/skills/things-cli/`, project-level equivalents), read the stamp, and when the installed skill is a **minor version or more behind** the bundled copy, append one stderr line: `note: installed agent skill vX predates bundled vY — run 'things install-skill' to update`. Zero agent cost — it rides output the agent was already reading (the skill's own init instruction is "run things --help"). Kill switch: `THINGS_API_NO_SKILL_CHECK=1`. The path probe is disclosed in README + `--help` (a CLI reading `~/.claude/` should never be a surprise).
- **Skill-side routing** (skill newer than binary): one preamble line — use `things` if on PATH, else substitute `npx -y things-api@latest`; and if `things --version` reports below the skill's stamped `minSupported`, prefer the npx form. No pinned `@version` in the skill: the demarcation makes the skill deliberately version-tolerant, and npx mode always pairs current mechanics with current help.
- Whichever side is newer nudges the other; neither side hard-fails on drift.

## Execution phases (after the v2 experiment reports)

1. **Skill-v2 restructure** — concepts/contracts/GUI + topic pointers; fold six references into ~three (`model`, `contracts`, `gui`) to also kill the observed hallucinated-path tax (9 bench runs cat'd nonexistent reference names). Validated by the paired sweep; abort demarcation if the turn-tax outweighs the context savings at the mini tier.
2. **Distribution PR** — `install-skill` (shell-out + fallback + `--check`), help-footer suggestion, SKILL.md npx preamble + `minSupported`, README section, `skills/` in the npm `files` list.
3. **Ratchet PR** — publish-time stamping, CLI passive drift check.
4. **Re-sweep + refinement round** on the shipped composition (including the `repeating` response block from #236), then release.

## Open questions (resolve during phase 2 build)

- ~~Verify `skills add <local-path>` layout semantics~~ **ANSWERED 2026-07-20 (sandbox probe, v1.5.19)**: canonical is a real copy of the source, `--copy` governs only the agent-dir hop — see research section. Still open from that probe: re-add behavior (clean overwrite vs error — decides whether `install-skill` needs a `remove` first) and the agent-dir symlink-vs-copy variance across adapters (claude-code copied even by default). Build a small integration test around the shell-out either way.
- The CLI drift check should stat the CANONICAL `~/.agents/skills/things-cli/` first (agent dirs may be symlinks to it), falling back to agent-specific dirs for skills installed by other means.
- Whether `install-skill` defaults to `-g` (probably yes; `--project` opt-in for repo-local installs).
- Whether `skills update` records a local-path source usefully for our copies, or whether our re-run-install-skill story fully supersedes it (likely the latter; if so say so in README to avoid two competing update paths).
- Exact "significant drift" threshold (minor-or-more proposed; revisit once real release cadence exists).
