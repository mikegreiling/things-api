# Repeating to-dos and projects

<!-- STATUS: v0 skeleton — rule-grammar specifics to be filled from `things capabilities` and command --help during bench rounds; do not assert unverified rule shapes. -->

Things supports repeating to-dos and repeating projects: a repeat rule generates the next instance on a schedule (after completion or on fixed dates). The CLI exposes this via the `make-repeating` / `create-repeating` / `reschedule-repeat` verbs on `todo` and `project` — check each verb's `--help` for the rule grammar it accepts.

Practical guidance:

- Inspect an existing repeating item (`things show <ref> --json`) to see how its rule is represented before composing a new one.
- A single rule expresses one pattern. If the user's request combines patterns that one rule cannot express, decompose it into multiple repeating items (e.g. two rules for two distinct weekly patterns) — verify what a single rule supports via the command's `--help` before deciding.
- `--dry-run` first: repeat rules are easy to get subtly wrong, and the plan output shows exactly what will be created.
