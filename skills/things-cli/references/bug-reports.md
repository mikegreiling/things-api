# Filing a bug report against things-api

Read this when a command does something that looks wrong — a refusal that should have been allowed, a result that does not match what the command said it would do, a crash, an outcome you cannot determine, or a capability the CLI plainly ought to express and does not. It applies to every install: a published release, an `npx` invocation, or a source checkout.

This is guidance, not a gate. Nothing here blocks you from working, and you never need permission to describe a problem to your user. But a report that stops at "the command didn't work" cannot be acted on, and a report built from the checklist below usually can be — the maintainer can often reproduce it without a single follow-up question. Spend the extra two minutes; it is the difference between a fixed defect and a closed-as-unreproducible one.

**Filing is a public act taken on the user's behalf.** Show the user what you are about to file, and file it only if they are happy for you to. If they would rather not, hand them the finished report to keep or paste themselves — the writing is not wasted.

## The checklist

Write the report in this order. Each item earns its place; skipping one costs a round trip.

1. **Intent.** What the user asked for, and what you were trying to accomplish with the command — in one or two plain sentences, before any command text. Half of all ambiguous reports are ambiguous because the reader cannot tell what the right answer would have been.
2. **Every command, VERBATIM, in the order you ran them.** Copy the exact command line — every flag, in the spelling you used — not a cleaned-up paraphrase. Include the commands that succeeded on the way to the failure: they establish the starting state. Prefer the `--json` form, and re-run the failing command with `--json` if you did not, so the report carries the machine shape.
3. **Their complete output.** The whole JSON envelope, not an excerpt: `ok`, `kind`, `error.code`, the message, `remediation`, and `meta`. Add the exit code (`0` landed · `2` usage · `3` verify-failed · `4` blocked · `5` drift-blocked · `6` unsupported · `7` environment), anything the command wrote to stderr, and — if you truncated a long body — say where and why. An empty output is itself a finding: report it as empty rather than omitting the step.
4. **Expected versus observed.** State them as two separate claims. "I expected the to-do to land at the top of Today; it stayed third." Where your expectation comes from a documented promise, name the source — `things <group> <verb> --help`, a `things help <topic>` guide, or the skill page that says so. If your expectation was a guess, say that too; a wrong expectation is a documentation defect worth reporting on its own.
5. **Your analysis: why this is a defect and not intended behavior.** This is the paragraph that decides whether the report is triaged or parked. Say what you checked before concluding it was a bug — the help text you read, the refusal's own remediation line and why following it did not resolve it, the flag that was supposed to sanction the operation. Name the inconsistency in the product's own terms where you can see one ("the read says it renders in Today, the reorder scope says it does not"). And name what you are *not* sure of: an honest "I could not determine whether X or Y causes this" is more useful than a confident wrong diagnosis.
6. **Environment.** A short block, all of it:
   - `things --version` — the package version (a `-dev` suffix means a source checkout; say so).
   - The surface: CLI, MCP tool call, or the library API.
   - Things.app version and build, macOS version, and the architecture (`sw_vers`, `uname -m`).
   - `things helpers status` — whether the helper pair is installed, running, and routing.
   - `things config get ui-enabled` (and `things config get` for the whole set when the failure looks configuration-shaped).
   - The relevant part of `things doctor` (`--json` for the full shape). Paste the sections that bear on the failure rather than the whole report.
   - `things op-result <op-id>` output whenever a write's outcome was uncertain, and `things rescue status --json` when a GUI-driving command may have left a dialog open in the app.
7. **What you tried, and what state you left behind.** Retries and their results, workarounds you attempted and why they fell short, and — importantly — whether anything actually landed. A half-completed change is part of the defect, not an embarrassment to leave out. If you did not try something obvious, say so; it stops the maintainer from re-deriving your ground.

A feature request is the same discipline minus the failure: what you were trying to do, why the existing commands cannot express it, what you tried instead, and the command or result shape you have in mind. One report per defect — a single issue carrying three unrelated problems gets triaged as none of them.

## Redaction — the tracker is PUBLIC

Anyone can read what you file, forever. Nothing from the user's real database goes in: no task titles, notes, project or area names, tags, checklist text, reminder text, or screenshots of real content. Never attach or paste the local trace files (`~/.local/state/things-api/trace/`) — they hold real titles verbatim.

Reproduce the shape instead:

- **Substitute, do not delete.** Replace each real name with an invented stand-in, and keep the stand-in consistent throughout the report so the steps still follow one another.
- **Preserve the structure that matters.** Counts, nesting depth, ordering, list lengths, roughly how long a title or note was, whether names collided — these are frequently the cause. Report #658 is the model: a twelve-area sidebar rendered as Alpha through Mu with each area's project-row count intact, explicitly labeled as synthetic with the structure faithfully reproduced.
- **UUIDs are identifying too.** Use a placeholder token (`TODO_UUID`, `PROJECT_UUID`) rather than a real one, and keep it stable across the report — report #657 does exactly this with a single `EVENING_TODO` stand-in and stays entirely reproducible.
- **Say that the data is synthetic**, in the report, so nobody wastes time trying to reconcile it with a real database.
- If a defect genuinely cannot be described without real content, describe the shape and offer the detail privately — do not publish it.

## Where to file

The tracker is the public GitHub repository **github.com/mikegreiling/things-api**. It has a bug-report form and a feature-request form; blank issues are open too, which is what makes non-interactive filing possible.

Before opening anything, look at what is already on it. `gh issue list --state open` when the `gh` CLI is available (add `--search "<command>"` to narrow it), the repository's issues page otherwise. If an open issue already describes the SAME command failing with the same symptom, add a **comment** carrying your run's data — the versions, the complete output, the trace excerpt, and whatever was different about your attempt — rather than filing a second issue. A second run on one issue is usually worth more than two issues holding one run each: it is often what separates a defect that reproduces from one that looked like a fluke.

A genuinely distinct failure still earns its own issue. The same feature is not the same defect — if a different step gives way, a different command, or a different underlying operation, file it separately and mention the neighboring issue by number. When you cannot tell which it is, comment on the open issue and say you are unsure whether it is the same defect; splitting one issue in two is easier than noticing that two were always one.

When the `gh` CLI is available and authenticated:

```
gh issue create --repo mikegreiling/things-api \
  --title "<surface>: <one-line symptom>" \
  --body "<the checklist above, as markdown>"
```

A good title names the surface and the symptom in the product's vocabulary ("area reorder fails to resolve the visible sidebar and leaves the order unchanged"), never just "bug" or "doesn't work". Write the body to a file and pass `--body-file` when it is long enough that shell quoting gets awkward.

If `gh` is missing or unauthenticated, do not shell out to the GitHub API by hand — hand the finished report to your user with the repository URL, and let them paste it into the form. Give them the report either way: they are the one who has to live with the defect.
